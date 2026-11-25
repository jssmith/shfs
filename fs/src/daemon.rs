//! Serving a `DriveFs` over `/dev/fuse`.

use std::path::Path;
use std::sync::Arc;
use std::thread;

use fuse_backend_rs::api::server::Server;
use fuse_backend_rs::transport::{FuseChannel, FuseSession};

use crate::drivefs::DriveFs;

/// A mounted session file system. Unmounts on drop.
pub struct Mount {
    session: FuseSession,
    threads: Vec<thread::JoinHandle<()>>,
    pub fs: Arc<DriveFs>,
}

fn serve(server: Arc<Server<Arc<DriveFs>>>, mut ch: FuseChannel) {
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

impl Mount {
    pub fn start(fs: DriveFs, mountpoint: &Path, threads: usize) -> anyhow::Result<Mount> {
        let fs = Arc::new(fs);
        let server = Arc::new(Server::new(fs.clone()));
        let mut session = FuseSession::new(mountpoint, "agent-drive", "", false)?;
        session.mount()?;
        let mut handles = Vec::new();
        for i in 0..threads.max(1) {
            let ch = session.new_channel()?;
            let server = server.clone();
            handles.push(
                thread::Builder::new()
                    .name(format!("a2-fs-{i}"))
                    .spawn(move || serve(server, ch))?,
            );
        }
        Ok(Mount { session, threads: handles, fs })
    }

    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        let _ = self.session.umount();
        let _ = self.session.wake();
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
        self.fs.flush_activity();
    }
}

impl Drop for Mount {
    fn drop(&mut self) {
        self.shutdown();
    }
}
