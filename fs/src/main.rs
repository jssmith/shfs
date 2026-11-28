//! `agent-drive-fs`: mount a session's `/drive`, the server's safe access to `upper/`, and the
//! stub-store tools used by the spike.
//!
//! ```text
//! agent-drive-fs mount --data D --dir-id S [--mountpoint M] [--threads N]
//!                      [--entry-timeout-ms N] [--attr-timeout-ms N] [--poll-ms N] [--name NAME]
//!                      [--uid U --gid G] [--exit-with-parent]
//!                                       (--uid/--gid: the owner reported for store items and
//!                                        given to everything created in upper/)
//! agent-drive-fs export --data D --dir-id S [--out DIR | --hash] [--ignore JSON]
//!                                       (JSON manifest of upper/ and whiteouts on stdout;
//!                                        --out copies the regular files there)
//! agent-drive-fs read --data D --dir-id S --path P [--max N] [--upper-only]
//!                                       (a JSON line {found, size, from, item_id?}, then up
//!                                        to N bytes of the file as the session sees it)
//! agent-drive-fs write --root DIR --path P [--uid U --gid G]   (stdin into DIR/P)
//! agent-drive-fs rebase --data D --dir-id S   (a JSON request on stdin; to the running daemon,
//!                                              or on disk when none runs)
//! agent-drive-fs stub --data D --dir-id S [--synthetic] [--tree PATH --prefix P]...
//! agent-drive-fs hide --data D --dir-id S --path P      (delete a view row, bump the epoch,
//!                                                        and ask the daemon to apply it)
//! agent-drive-fs bump --data D --dir-id S
//! agent-drive-fs materialize --data D --dir-id S --out DIR
//! agent-drive-fs opens --data D --dir-id S              (count of activity rows op='open')
//! ```

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use agent_drive_fs::{daemon, daemon::Mount, drivefs, maintain, store, stub};
use anyhow::{Context, bail};

const FLAGS: &[&str] = &["synthetic", "exit-with-parent", "hash", "upper-only"];

struct Args {
    cmd: String,
    kv: Vec<(String, String)>,
    flags: Vec<String>,
}

impl Args {
    fn parse() -> anyhow::Result<Args> {
        let mut it = std::env::args().skip(1);
        let cmd = it.next().context("missing command")?;
        let (mut kv, mut flags) = (Vec::new(), Vec::new());
        let rest: Vec<String> = it.collect();
        let mut i = 0;
        while i < rest.len() {
            let a = &rest[i];
            let Some(k) = a.strip_prefix("--") else { bail!("unexpected argument {a}") };
            if FLAGS.contains(&k) {
                flags.push(k.to_string());
                i += 1;
            } else {
                let v = rest.get(i + 1).with_context(|| format!("--{k} needs a value"))?;
                kv.push((k.to_string(), v.clone()));
                i += 2;
            }
        }
        Ok(Args { cmd, kv, flags })
    }
    fn get(&self, k: &str) -> Option<&str> {
        self.kv.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
    }
    fn all(&self, k: &str) -> Vec<&str> {
        self.kv.iter().filter(|(a, _)| a == k).map(|(_, v)| v.as_str()).collect()
    }
    fn req(&self, k: &str) -> anyhow::Result<&str> {
        self.get(k).with_context(|| format!("missing --{k}"))
    }
    fn flag(&self, k: &str) -> bool {
        self.flags.iter().any(|f| f == k)
    }
    fn ms(&self, k: &str) -> anyhow::Result<Duration> {
        Ok(Duration::from_millis(self.get(k).unwrap_or("0").parse()?))
    }
    /// `--uid U --gid G` (both or neither).
    fn owner(&self) -> anyhow::Result<Option<(u32, u32)>> {
        match (self.get("uid"), self.get("gid")) {
            (None, None) => Ok(None),
            (Some(u), Some(g)) => Ok(Some((u.parse()?, g.parse()?))),
            _ => bail!("--uid and --gid go together"),
        }
    }
}

fn set_process_name(name: &str) {
    if let Ok(c) = std::ffi::CString::new(name) {
        unsafe { libc::prctl(libc::PR_SET_NAME, c.as_ptr(), 0, 0, 0) };
    }
}

fn main() -> anyhow::Result<()> {
    env_logger::init();
    let a = Args::parse()?;
    if a.cmd == "write" {
        let mut data = Vec::new();
        std::io::stdin().read_to_end(&mut data)?;
        maintain::write_path(Path::new(a.req("root")?), a.req("path")?, &data, a.owner()?)?;
        return Ok(());
    }
    let data = PathBuf::from(a.req("data")?);
    let dir_id = a.req("dir-id")?.to_string();
    match a.cmd.as_str() {
        "mount" => {
            if a.flag("exit-with-parent") {
                // SIGTERM is handled below: the mount is taken down cleanly.
                unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) };
            }
            if let Some(n) = a.get("name") {
                set_process_name(n);
            }
            let mnt = a
                .get("mountpoint")
                .map(PathBuf::from)
                .unwrap_or_else(|| store::session_dir(&data, &dir_id).join("mnt"));
            std::fs::create_dir_all(&mnt)?;
            let mut cfg = drivefs::Config::new(&data, &dir_id);
            cfg.entry_timeout = a.ms("entry-timeout-ms")?;
            cfg.attr_timeout = a.ms("attr-timeout-ms")?;
            cfg.owner = a.owner()?;
            cfg.skip_epoch_check = std::env::var_os("A2_FS_SKIP_EPOCH_CHECK").is_some();
            cfg.no_change_probe = std::env::var_os("A2_FS_NO_CHANGE_PROBE").is_some();
            let opts = daemon::Options {
                threads: a.get("threads").unwrap_or("1").parse()?,
                poll: Duration::from_millis(a.get("poll-ms").unwrap_or("50").parse()?),
            };
            let mut signals = signal_hook::iterator::Signals::new([libc::SIGINT, libc::SIGTERM])?;
            let m = Mount::start(drivefs::DriveFs::new(cfg)?, &mnt, opts)?;
            println!("mounted {}", mnt.display());
            std::io::stdout().flush()?;
            let _ = signals.forever().next();
            m.stop();
            println!("unmounted");
        }
        "export" => {
            let ignore = match a.get("ignore") {
                Some(j) => maintain::Ignore::parse(j)?,
                None => maintain::Ignore::default(),
            };
            let out = a.get("out").map(PathBuf::from);
            let opts = maintain::ExportOptions { out: out.as_deref(), hash: a.flag("hash"), ignore };
            let m = maintain::export(&data, &dir_id, &opts)?;
            println!("{m}");
        }
        "read" => {
            let max: u64 = a.get("max").unwrap_or("18446744073709551615").parse()?;
            let mut out = std::io::stdout().lock();
            match maintain::read_path(&data, &dir_id, a.req("path")?, a.flag("upper-only"))? {
                None => writeln!(out, "{}", serde_json::json!({ "found": false }))?,
                Some(found) => {
                    let (mut f, head) = match found {
                        maintain::Found::Upper(f) => {
                            let size = f.metadata()?.len();
                            (f, serde_json::json!({ "found": true, "from": "upper", "size": size }))
                        }
                        maintain::Found::Store(f, item, version) => {
                            let size = f.metadata()?.len();
                            (f, serde_json::json!({ "found": true, "from": "store", "size": size, "item_id": item, "version": version }))
                        }
                    };
                    writeln!(out, "{head}")?;
                    std::io::copy(&mut (&mut f).take(max), &mut out)?;
                }
            }
            out.flush()?;
        }
        "rebase" => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            let req = maintain::Rebase::parse(s.trim())?;
            match daemon::request_rebase(&data, &dir_id, s.trim())? {
                Some(reply) => println!("{reply}"),
                None => println!("{}", maintain::rebase_offline(&data, &dir_id, &req)?),
            }
        }
        "stub" => {
            let mut s = stub::StubStore::create(&data, &dir_id)?;
            if a.flag("synthetic") {
                s.add_synthetic()?;
            }
            let prefixes = a.all("prefix");
            for (i, t) in a.all("tree").iter().enumerate() {
                let p = prefixes.get(i).copied().unwrap_or("");
                let n = s.load_tree(Path::new(t), p)?;
                println!("loaded {n} entries from {t} under /{p}");
            }
        }
        "hide" => {
            let conn = store::open(&data)?;
            let n = store::hide_path(&conn, &dir_id, a.req("path")?)?;
            let applied = daemon::request_refresh(&data, &dir_id)?;
            println!("removed {n} view row(s); epoch {}; daemon applied {applied:?}", store::epoch(&conn, &dir_id)?);
        }
        "bump" => {
            let conn = store::open(&data)?;
            println!("epoch {}", store::bump_epoch(&conn, &dir_id)?);
            daemon::request_refresh(&data, &dir_id)?;
        }
        "materialize" => {
            let n = stub::materialize(&data, &dir_id, Path::new(a.req("out")?))?;
            println!("materialized {n} entries");
        }
        "opens" => {
            let conn = store::open(&data)?;
            let n: i64 = conn.query_row(
                "SELECT count(*) FROM activity WHERE dir_id = ?1 AND op = 'open'",
                [&dir_id],
                |r| r.get(0),
            )?;
            println!("{n}");
        }
        c => bail!("unknown command {c}"),
    }
    Ok(())
}
