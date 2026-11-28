//! Serving a `DriveFs` over `/dev/fuse`, and keeping the kernel's caches in step with the view.
//!
//! With kernel caching on (non-zero entry and attribute timeouts) the kernel answers repeated
//! lookups itself, so a view change must reach it as invalidations. Three paths do that:
//! - the control socket `sessions/<dir_id>/control.sock`: the server writes `refresh` after it
//!   bumps the epoch and waits for `ok <epoch>`; by then the kernel has dropped every stale
//!   entry, so the next operation in the sandbox sees the change;
//! - a poll of the epoch every `poll` interval, for changes nobody announced;
//! - the per-operation epoch check, for requests that reach the daemon anyway.
//!
//! The control socket also answers `stats` with `ok {json}`: the sizes of the daemon's tables
//! (inodes, paths, open handles, whiteouts), for monitoring; and `rebase {json}` with
//! `ok <epoch> {json}`: the server's changes to `upper/` and `whiteouts` after a merge, a hide or
//! a conflict (`maintain::Rebase`), applied in the daemon so its state and the kernel's caches
//! follow.

use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

use fuse_backend_rs::api::server::Server;
use fuse_backend_rs::transport::{FuseChannel, FuseDevWriter, FuseSession};

use crate::drivefs::{DriveFs, Inval};
use crate::store;

/// A mounted session file system. Unmounts on drop.
pub struct Mount {
    session: FuseSession,
    threads: Vec<thread::JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    stop_tx: Option<mpsc::Sender<Vec<Inval>>>,
    control: PathBuf,
    pub fs: Arc<DriveFs>,
}

#[derive(Debug, Clone)]
pub struct Options {
    pub threads: usize,
    /// How often to poll the epoch for unannounced changes (only with kernel caching).
    pub poll: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Options { threads: 1, poll: Duration::from_millis(50) }
    }
}

type Srv = Arc<Server<Arc<DriveFs>>>;

fn serve(server: Srv, mut ch: FuseChannel) {
    loop {
        match ch.get_request() {
            Ok(Some((reader, writer))) => {
                if let Err(e) = server.handle_message(reader, writer.into(), None, None) {
                    match e {
                        fuse_backend_rs::Error::EncodeMessage(ref io)
                            if io.raw_os_error() == Some(libc::EBADF) =>
                        {
                            break;
                        }
                        _ => log::debug!("fuse message: {e:?}"),
                    }
                }
            }
            Ok(None) => break,
            Err(e) => {
                log::debug!("fuse channel closed: {e:?}");
                break;
            }
        }
    }
}

/// Sends invalidations to the kernel. Never called from a request handler.
fn notify(server: &Srv, fd: i32, invals: &[Inval]) {
    let mut buf = vec![0u8; 4096];
    for inv in invals {
        let r = match inv {
            Inval::Entry { parent, name } => FuseDevWriter::<()>::new(fd, &mut buf)
                .map_err(|e| fuse_backend_rs::Error::InvalidMessage(std::io::Error::other(format!("{e:?}"))))
                .and_then(|w| server.notify_inval_entry(w, *parent, name)),
            Inval::Inode { ino } => FuseDevWriter::<()>::new(fd, &mut buf)
                .map_err(|e| fuse_backend_rs::Error::InvalidMessage(std::io::Error::other(format!("{e:?}"))))
                .and_then(|w| server.notify_inval_inode(w, *ino, 0, 0)),
        };
        // ENOENT means the kernel had nothing cached; that is fine.
        if let Err(e) = r {
            log::trace!("invalidate {inv:?}: {e:?}");
        }
    }
}

fn refresh_and_notify(fs: &DriveFs, server: &Srv, fd: i32) -> std::io::Result<i64> {
    let (ep, invals) = fs.refresh()?;
    notify(server, fd, &invals);
    Ok(ep)
}

impl Mount {
    pub fn start(fs: DriveFs, mountpoint: &Path, opts: Options) -> anyhow::Result<Mount> {
        let caching = !fs.config().entry_timeout.is_zero() || !fs.config().attr_timeout.is_zero();
        let control = store::session_dir(&fs.config().data, &fs.config().dir_id).join("control.sock");
        let fs = Arc::new(fs);
        let server: Srv = Arc::new(Server::new(fs.clone()));
        let mut session = FuseSession::new(mountpoint, "agent-drive", "", false)?;
        session.mount()?;
        let fd = session.get_fuse_file().map(|f| f.as_raw_fd()).unwrap_or(-1);
        let mut handles = Vec::new();
        for i in 0..opts.threads.max(1) {
            let ch = session.new_channel()?;
            let server = server.clone();
            handles.push(thread::Builder::new().name(format!("a2-fs-{i}")).spawn(move || serve(server, ch))?);
        }
        let stop = Arc::new(AtomicBool::new(false));

        // Notifier: invalidations queued by handlers, and the epoch poll.
        let (tx, rx) = mpsc::channel::<Vec<Inval>>();
        fs.set_inval_sink(tx.clone());
        {
            let (fs, server, stop) = (fs.clone(), server.clone(), stop.clone());
            let poll = if caching { opts.poll } else { Duration::from_secs(3600) };
            handles.push(thread::Builder::new().name("a2-fs-notify".into()).spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    match rx.recv_timeout(poll) {
                        Ok(invals) => notify(&server, fd, &invals),
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if caching {
                                let _ = refresh_and_notify(&fs, &server, fd);
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })?);
        }

        // Control socket.
        let _ = std::fs::remove_file(&control);
        let listener = UnixListener::bind(&control)?;
        // Non-blocking, so the thread notices `stop` even if the socket file is gone.
        listener.set_nonblocking(true)?;
        {
            let (fs, server, stop) = (fs.clone(), server.clone(), stop.clone());
            handles.push(thread::Builder::new().name("a2-fs-control".into()).spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let conn = match listener.accept() {
                        Ok((c, _)) => c,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            let mut pfd = libc::pollfd { fd: listener.as_raw_fd(), events: libc::POLLIN, revents: 0 };
                            unsafe { libc::poll(&mut pfd, 1, 100) };
                            continue;
                        }
                        Err(_) => continue,
                    };
                    let _ = conn.set_nonblocking(false);
                    let mut w = match conn.try_clone() {
                        Ok(w) => w,
                        Err(_) => continue,
                    };
                    for line in BufReader::new(conn).lines() {
                        let Ok(line) = line else { break };
                        let line = line.trim();
                        let (cmd, arg) = line.split_once(' ').unwrap_or((line, ""));
                        let reply = match cmd {
                            "rebase" => match crate::maintain::Rebase::parse(arg).and_then(|req| fs.rebase(&req)) {
                                Ok((ep, invals, removed)) => {
                                    notify(&server, fd, &invals);
                                    format!("ok {ep} {}\n", serde_json::json!({ "removed": removed }))
                                }
                                Err(e) => format!("error {e}\n"),
                            },
                            "refresh" => match refresh_and_notify(&fs, &server, fd) {
                                Ok(ep) => format!("ok {ep}\n"),
                                Err(e) => format!("error {e}\n"),
                            },
                            "stats" => {
                                let s = fs.stats();
                                format!(
                                    "ok {}\n",
                                    serde_json::json!({
                                        "inodes": s.inodes, "paths": s.paths, "handles": s.handles,
                                        "dir_handles": s.dir_handles, "whiteouts": s.whiteouts,
                                        "listed_only": s.listed_only,
                                    })
                                )
                            }
                            other => format!("error unknown command {other:?}\n"),
                        };
                        if w.write_all(reply.as_bytes()).is_err() {
                            break;
                        }
                    }
                }
            })?);
        }
        Ok(Mount { session, threads: handles, stop, stop_tx: Some(tx), control, fs })
    }

    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.stop_tx.take();
        let _ = self.session.umount();
        let _ = self.session.wake();
        self.fs.set_inval_sink(mpsc::channel().0);
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
        let _ = std::fs::remove_file(&self.control);
        self.fs.flush_activity();
    }
}

impl Drop for Mount {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Sends a rebase request (one JSON line) to a running daemon. Returns its reply after `ok `
/// (`<epoch> {json}`), or `None` when no daemon is listening.
pub fn request_rebase(data: &Path, dir_id: &str, json: &str) -> std::io::Result<Option<String>> {
    if json.contains('\n') {
        return Err(std::io::Error::from_raw_os_error(libc::EINVAL));
    }
    let path = store::session_dir(data, dir_id).join("control.sock");
    let mut s = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused) => {
            return Ok(None);
        }
        Err(e) => return Err(e),
    };
    s.set_read_timeout(Some(Duration::from_secs(30)))?;
    s.write_all(format!("rebase {json}\n").as_bytes())?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line)?;
    match line.trim().strip_prefix("ok ") {
        Some(rest) => Ok(Some(rest.to_string())),
        None => Err(std::io::Error::other(line)),
    }
}

/// The server's side of the control socket: ask a running daemon to apply a view change now.
/// Returns the epoch it applied, or `None` when no daemon is listening.
pub fn request_refresh(data: &Path, dir_id: &str) -> std::io::Result<Option<i64>> {
    let path = store::session_dir(data, dir_id).join("control.sock");
    let mut s = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused) => {
            return Ok(None);
        }
        Err(e) => return Err(e),
    };
    s.set_read_timeout(Some(Duration::from_secs(5)))?;
    s.write_all(b"refresh\n")?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line)?;
    match line.trim().strip_prefix("ok ") {
        Some(ep) => Ok(ep.parse().ok()),
        None => Err(std::io::Error::other(line)),
    }
}
