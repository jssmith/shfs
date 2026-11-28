//! The server's side of `upper/` and `whiteouts`, done here so that nothing the session put in
//! `upper/` is ever followed on the host (risk R14: Node has no `openat2`, and a running
//! session can swap a directory for a symlink between a check and an open).
//!
//! - [`export`]: a copy of every regular file in `upper/` into a directory the server owns,
//!   with a manifest (path, size, mode, sha256); the server diffs and merges from that copy.
//! - [`read_path`]: one path as the session sees it (`upper/`, else the view's blob unless
//!   whited out), for the server's read tools.
//! - [`write_path`]: one file written into a tree (`upper/`, or the daemon's mount), replacing
//!   whatever is in the way without following it.
//! - [`Rebase`]: after a merge, a hide or a conflict, drop the session's copies that the view
//!   now serves itself and change `whiteouts`; applied by a running daemon on its control socket
//!   (so its state and the kernel's caches follow), or here on disk when none runs.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use rusqlite::params;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::store;
use crate::upper::{Upper, open_trusted};
use crate::view::{View, join, parent_of};

/// The daemon's temporary name for copy-up; never exported.
const COPYUP: &str = ".a2-copyup";
/// The server's temporary names (`server/src/util/fsafe.ts`, and [`write_path`]).
const TMP_PREFIX: &str = ".ad-tmp-";

fn err(code: i32) -> io::Error {
    io::Error::from_raw_os_error(code)
}

/// A drive path as the server gives it: relative, no empty, `.` or `..` components.
pub fn check_path(p: &str) -> io::Result<()> {
    if p.is_empty() || p.split('/').any(|c| c.is_empty() || c == "." || c == ".." || c.contains('\0')) {
        return Err(err(libc::EINVAL));
    }
    Ok(())
}

fn whited(set: &HashSet<String>, path: &str) -> bool {
    let mut p = path;
    while !p.is_empty() {
        if set.contains(p) {
            return true;
        }
        p = parent_of(p);
    }
    false
}

/// Reads the whiteouts file without changing it; a last line without a newline is a delete
/// the daemon has not acknowledged yet, so it is left out.
pub fn read_whiteouts(path: &Path) -> io::Result<Vec<String>> {
    let s = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let complete = match s.rfind('\n') {
        Some(i) => &s[..i + 1],
        None => "",
    };
    let mut seen = HashSet::new();
    Ok(complete.lines().filter(|l| !l.is_empty() && seen.insert(l.to_string())).map(str::to_string).collect())
}

/// Replaces the whiteouts file with `set` (sorted), durably, and returns a fresh append handle.
pub fn rewrite_whiteouts(path: &Path, set: &HashSet<String>) -> io::Result<File> {
    let mut lines: Vec<&String> = set.iter().collect();
    lines.sort();
    let mut buf = String::new();
    for l in lines {
        buf.push_str(l);
        buf.push('\n');
    }
    let tmp = path.with_extension("new");
    let _ = fs::remove_file(&tmp);
    {
        let mut f = OpenOptions::new().write(true).create_new(true).custom_flags(libc::O_NOFOLLOW).mode(0o644).open(&tmp)?;
        f.write_all(buf.as_bytes())?;
        f.sync_data()?;
    }
    fs::rename(&tmp, path)?;
    if let Some(dir) = path.parent() {
        File::open(dir)?.sync_all()?;
    }
    OpenOptions::new().read(true).append(true).custom_flags(libc::O_NOFOLLOW).open(path)
}

// ---- rebase ---------------------------------------------------------------------------------

/// What the server asks for after a merge, a hide or a conflict (one JSON object):
/// `{"remove": [{"path", "sha256"}], "drop_whiteouts": [...], "unwhite": [...]}`.
#[derive(Debug, Default, Clone)]
pub struct Rebase {
    /// Remove the session's copy at `path` from `upper/` if it is a regular file with exactly
    /// this content (a newer write is kept).
    pub remove: Vec<(String, String)>,
    /// Exact lines to take out of `whiteouts` (those the server saw and merged).
    pub drop_whiteouts: Vec<String>,
    /// Paths the session must see again although it deleted them (or a directory above them):
    /// the whiteouts that hide them go, and anything else those whiteouts hid stays hidden.
    pub unwhite: Vec<String>,
}

impl Rebase {
    pub fn parse(s: &str) -> io::Result<Rebase> {
        let v: Value = serde_json::from_str(s).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let strs = |k: &str| -> io::Result<Vec<String>> {
            let mut out = Vec::new();
            for x in v.get(k).and_then(Value::as_array).into_iter().flatten() {
                let p = x.as_str().ok_or_else(|| err(libc::EINVAL))?;
                check_path(p)?;
                out.push(p.to_string());
            }
            Ok(out)
        };
        let mut remove = Vec::new();
        for x in v.get("remove").and_then(Value::as_array).into_iter().flatten() {
            let p = x.get("path").and_then(Value::as_str).ok_or_else(|| err(libc::EINVAL))?;
            let h = x.get("sha256").and_then(Value::as_str).ok_or_else(|| err(libc::EINVAL))?;
            check_path(p)?;
            remove.push((p.to_string(), h.to_ascii_lowercase()));
        }
        Ok(Rebase { remove, drop_whiteouts: strs("drop_whiteouts")?, unwhite: strs("unwhite")? })
    }

    /// Removes the copies in `remove` that still hold the given content; returns their paths.
    pub fn apply_upper(&self, upper: &Upper) -> io::Result<Vec<String>> {
        let mut out = Vec::new();
        for (p, want) in &self.remove {
            match upper.stat(p) {
                Ok(s) if s.is_file() => {}
                _ => continue,
            }
            let mut f = match upper.open_file(p, libc::O_RDONLY | libc::O_NONBLOCK, 0) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if hash_reader(&mut f, None)?.0 != *want {
                continue;
            }
            match upper.unlink(p) {
                Ok(()) => out.push(p.clone()),
                Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    /// The whiteouts after this request, given the current view.
    pub fn whiteouts_after(&self, set: &HashSet<String>, view: &View) -> HashSet<String> {
        let mut out = set.clone();
        for d in &self.drop_whiteouts {
            out.remove(d);
        }
        for p in &self.unwhite {
            let hiding: Vec<String> =
                out.iter().filter(|w| *w == p || p.starts_with(&format!("{w}/"))).cloned().collect();
            for w in hiding {
                out.remove(&w);
                if w == *p {
                    continue;
                }
                // Keep hidden what `w` hid besides the way down to `p`.
                let mut d = w.clone();
                for comp in p[w.len() + 1..].split('/') {
                    if let Some(children) = view.dirs.get(&d) {
                        for name in children.keys() {
                            if name != comp {
                                out.insert(join(&d, name));
                            }
                        }
                    }
                    d = join(&d, comp);
                }
            }
        }
        out
    }
}

/// Applies a rebase on disk, when no daemon runs for the session.
pub fn rebase_offline(data: &Path, dir_id: &str, req: &Rebase) -> anyhow::Result<Value> {
    let sess = store::session_dir(data, dir_id);
    fs::create_dir_all(sess.join("upper"))?;
    let upper = Upper::open(&sess.join("upper"))?;
    let removed = req.apply_upper(&upper)?;
    let wpath = sess.join("whiteouts");
    let cur: HashSet<String> = read_whiteouts(&wpath)?.into_iter().collect();
    let mut conn = store::open(data)?;
    let (ep, rows) = store::load_view(&mut conn, dir_id)?;
    let view = View::build(ep, rows);
    let new = req.whiteouts_after(&cur, &view);
    if new != cur || fs::read_to_string(&wpath).map(|s| !s.is_empty() && !s.ends_with('\n')).unwrap_or(false) {
        rewrite_whiteouts(&wpath, &new)?;
    }
    Ok(json!({ "removed": removed, "whiteouts": new.len() }))
}

// ---- export ---------------------------------------------------------------------------------

/// The merge ignore list (`server/src/merge/ignore.ts`), given by the server as JSON:
/// `{"dirs": [...], "files": [...], "suffixes": [...]}`.
#[derive(Debug, Default, Clone)]
pub struct Ignore {
    dirs: HashSet<String>,
    files: HashSet<String>,
    suffixes: Vec<String>,
}

impl Ignore {
    pub fn parse(s: &str) -> io::Result<Ignore> {
        let v: Value = serde_json::from_str(s).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let strs = |k: &str| -> Vec<String> {
            v.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
        };
        Ok(Ignore { dirs: strs("dirs").into_iter().collect(), files: strs("files").into_iter().collect(), suffixes: strs("suffixes") })
    }

    /// Same rule as `isToolCache`: a listed directory name anywhere above, or a listed file
    /// name or suffix.
    pub fn matches(&self, path: &str) -> bool {
        let parts: Vec<&str> = path.split('/').collect();
        let name = parts.last().copied().unwrap_or("");
        self.files.contains(name)
            || self.suffixes.iter().any(|s| name.ends_with(s.as_str()))
            || parts[..parts.len() - 1].iter().any(|d| self.dirs.contains(*d))
    }
}

/// SHA-256 (hex) of everything `r` yields, copying it to `out` on the way; and the length.
fn hash_reader(r: &mut dyn Read, mut out: Option<&mut File>) -> io::Result<(String, u64)> {
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut n = 0u64;
    loop {
        let k = r.read(&mut buf)?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        if let Some(o) = out.as_mut() {
            o.write_all(&buf[..k])?;
        }
        n += k as u64;
    }
    Ok((hex::encode(h.finalize()), n))
}

pub struct ExportOptions<'a> {
    /// Copy every regular file that is not ignored into this directory (created; must not
    /// exist), and hash the copy.
    pub out: Option<&'a Path>,
    /// Hash the files that are not ignored without copying them.
    pub hash: bool,
    pub ignore: Ignore,
}

/// Lists `upper/` (and copies or hashes its regular files), plus the whiteouts. Entries:
/// `{path, type: "f"|"d"|"l"|"o", size, mode, mtime_ns, sha256?, ignored?}`. A file that
/// changes or vanishes while it is listed is reported as found, or left out; a copy is always
/// exactly what was hashed.
pub fn export(data: &Path, dir_id: &str, opts: &ExportOptions) -> anyhow::Result<Value> {
    let sess = store::session_dir(data, dir_id);
    let mut entries = Vec::new();
    if let Some(out) = opts.out {
        fs::create_dir(out)?;
        fs::set_permissions(out, fs::Permissions::from_mode(0o700))?;
    }
    match Upper::open(&sess.join("upper")) {
        Ok(upper) => walk(&upper, "", opts, &mut entries)?,
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {}
        Err(e) => return Err(e.into()),
    }
    let whiteouts = read_whiteouts(&sess.join("whiteouts"))?;
    Ok(json!({ "entries": entries, "whiteouts": whiteouts }))
}

fn walk(upper: &Upper, dir: &str, opts: &ExportOptions, out: &mut Vec<Value>) -> anyhow::Result<()> {
    let names = match upper.read_dir(dir) {
        Ok(n) => n,
        // Swapped or removed while we walk: nothing to list there.
        Err(_) => return Ok(()),
    };
    let mut names: Vec<String> = names.into_iter().filter_map(|n| String::from_utf8(n.name).ok()).collect();
    names.sort();
    for name in names {
        if name == COPYUP || name.starts_with(TMP_PREFIX) {
            continue;
        }
        let path = join(dir, &name);
        let Ok(st) = upper.stat(&path) else { continue };
        let s = &st.0;
        let mtime_ns = s.st_mtime as i128 * 1_000_000_000 + s.st_mtime_nsec as i128;
        let mut e = json!({
            "path": path, "size": s.st_size, "mode": s.st_mode & 0o7777, "mtime_ns": mtime_ns.to_string(),
        });
        let ignored = opts.ignore.matches(&path);
        if ignored {
            e["ignored"] = json!(true);
        }
        if st.is_dir() {
            e["type"] = json!("d");
            out.push(e);
            walk(upper, &path, opts, out)?;
            continue;
        }
        if st.is_symlink() {
            e["type"] = json!("l");
            out.push(e);
            continue;
        }
        if !st.is_file() {
            e["type"] = json!("o");
            out.push(e);
            continue;
        }
        e["type"] = json!("f");
        if !ignored && (opts.out.is_some() || opts.hash) {
            // O_NONBLOCK: a FIFO swapped in after the stat cannot hang the export.
            let Ok(mut f) = upper.open_file(&path, libc::O_RDONLY | libc::O_NONBLOCK, 0) else { continue };
            let Ok(fst) = crate::upper::Stat::of(std::os::fd::AsRawFd::as_raw_fd(&f)) else { continue };
            if !fst.is_file() {
                continue;
            }
            let (sha, n) = match opts.out {
                Some(root) => {
                    let dst = root.join(&path);
                    fs::create_dir_all(dst.parent().unwrap_or(root))?;
                    let mut o = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&dst)?;
                    hash_reader(&mut f, Some(&mut o))?
                }
                None => hash_reader(&mut f, None)?,
            };
            e["sha256"] = json!(sha);
            e["size"] = json!(n);
            e["mode"] = json!(fst.0.st_mode & 0o7777);
        }
        out.push(e);
    }
    Ok(())
}

// ---- read -----------------------------------------------------------------------------------

/// Where a path the session sees comes from.
pub enum Found {
    /// The session's own copy in `upper/`.
    Upper(File),
    /// The view's item: its blob, item id and version.
    Store(File, String, i64),
}

/// The file at `path` as the session sees it, or `None` (missing, hidden, a directory, a
/// symlink, or under something in `upper/` that is not a directory). `upper_only` skips the
/// view.
pub fn read_path(data: &Path, dir_id: &str, path: &str, upper_only: bool) -> anyhow::Result<Option<Found>> {
    check_path(path)?;
    let sess = store::session_dir(data, dir_id);
    match Upper::open(&sess.join("upper")) {
        Ok(upper) => match upper.stat(path) {
            Ok(s) if s.is_file() => {
                let f = upper.open_file(path, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
                if !crate::upper::Stat::of(std::os::fd::AsRawFd::as_raw_fd(&f))?.is_file() {
                    return Ok(None);
                }
                return Ok(Some(Found::Upper(f)));
            }
            Ok(_) => return Ok(None),
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {}
            // A file or symlink above it in upper/ shadows the store below.
            Err(_) => return Ok(None),
        },
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {}
        Err(e) => return Err(e.into()),
    }
    if upper_only {
        return Ok(None);
    }
    let wo: HashSet<String> = read_whiteouts(&sess.join("whiteouts"))?.into_iter().collect();
    if whited(&wo, path) {
        return Ok(None);
    }
    let conn = store::open(data)?;
    let row: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT sv.item_id, sv.version, iv.blob_hash FROM session_view sv
             JOIN item_versions iv ON iv.item_id = sv.item_id AND iv.version = sv.version
             WHERE sv.dir_id = ?1 AND sv.path = ?2 AND sv.kind = 'file'",
            params![dir_id, path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let Some((item, version, blob)) = row else { return Ok(None) };
    // A file row under another file row is not served (view.rs): mirror that.
    let mut p = parent_of(path);
    while !p.is_empty() {
        let clash: bool = conn
            .query_row(
                "SELECT 1 FROM session_view WHERE dir_id = ?1 AND path = ?2 AND kind != 'dir'",
                params![dir_id, p],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if clash {
            return Ok(None);
        }
        p = parent_of(p);
    }
    Ok(Some(Found::Store(open_trusted(&store::blob_path(data, &blob))?, item, version)))
}

// ---- write ----------------------------------------------------------------------------------

/// Removes whatever is at `path` (a directory with everything in it), never following a link.
fn remove_tree(t: &Upper, path: &str) -> io::Result<()> {
    match t.stat(path) {
        Ok(s) if s.is_dir() => {
            for n in t.read_dir(path)? {
                let Ok(name) = String::from_utf8(n.name) else { return Err(err(libc::EINVAL)) };
                remove_tree(t, &join(path, &name))?;
            }
            t.rmdir(path)
        }
        Ok(_) => t.unlink(path),
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => Ok(()),
        Err(e) => Err(e),
    }
}

/// Writes `data` to `path` under `root` (mode 0644), as `fsafe.ts`'s `safeWrite` does but
/// without its check-then-open race: directories on the way are created, and a file or
/// symlink in their place is removed first; a directory at `path` itself is removed. The file
/// is written under a temporary name and renamed into place.
pub fn write_path(root: &Path, path: &str, data: &[u8], owner: Option<(u32, u32)>) -> anyhow::Result<()> {
    check_path(path)?;
    let t = Upper::open(root)?.with_owner(owner);
    let dir = parent_of(path);
    if !dir.is_empty() {
        let mut prefix = String::new();
        for comp in dir.split('/') {
            prefix = join(&prefix, comp);
            match t.stat(&prefix) {
                Ok(s) if s.is_dir() => continue,
                Ok(_) => t.unlink(&prefix)?,
                Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {}
                Err(e) => return Err(e.into()),
            }
            t.mkdir(&prefix, 0o755)?;
            t.chmod(&prefix, 0o755)?;
        }
    }
    if let Ok(s) = t.stat(path) {
        if s.is_dir() {
            remove_tree(&t, path)?;
        }
    }
    let rnd: u64 = {
        let mut b = [0u8; 8];
        File::open("/dev/urandom")?.read_exact(&mut b)?;
        u64::from_le_bytes(b)
    };
    let tmp = join(dir, &format!("{TMP_PREFIX}{}-{rnd:016x}", std::process::id()));
    let mut f = t.open_file(&tmp, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o644)?;
    let res = (|| -> io::Result<()> {
        f.write_all(data)?;
        f.set_permissions(fs::Permissions::from_mode(0o644))?;
        f.sync_data()
    })();
    drop(f);
    if let Err(e) = res.and_then(|_| t.rename(&tmp, path)) {
        let _ = t.unlink(&tmp);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stub::StubStore;
    use std::os::unix::fs::symlink;

    fn ignore() -> Ignore {
        Ignore::parse(r#"{"dirs":["__pycache__","node_modules"],"files":[".DS_Store"],"suffixes":[".pyc"]}"#).unwrap()
    }

    #[test]
    fn ignore_matches_like_the_server() {
        let i = ignore();
        assert!(i.matches("a/__pycache__/m.pyc"));
        assert!(i.matches("x.pyc"));
        assert!(i.matches("w/node_modules/p/index.js"));
        assert!(i.matches("n/.DS_Store"));
        assert!(!i.matches("node_modules.txt"));
        assert!(!i.matches("a/b.py"));
    }

    #[test]
    fn whiteouts_hole_punching_keeps_siblings_hidden() {
        let t = tempfile::Builder::new().prefix("fsd-maint-").tempdir().unwrap();
        let mut s = StubStore::create(t.path(), "d").unwrap();
        for p in ["a/x.txt", "a/y.txt", "a/b/z.txt", "a/b/w.txt", "c.txt"] {
            s.add_item(p, p.as_bytes(), &[], true).unwrap();
        }
        let mut conn = store::open(t.path()).unwrap();
        let (ep, rows) = store::load_view(&mut conn, "d").unwrap();
        let view = View::build(ep, rows);
        let set: HashSet<String> = ["a".to_string(), "c.txt".to_string()].into_iter().collect();
        let req = Rebase { unwhite: vec!["a/b/z.txt".into()], drop_whiteouts: vec![], remove: vec![] };
        let mut got: Vec<String> = req.whiteouts_after(&set, &view).into_iter().collect();
        got.sort();
        assert_eq!(got, ["a/b/w.txt", "a/x.txt", "a/y.txt", "c.txt"]);
        let req = Rebase { drop_whiteouts: vec!["c.txt".into(), "nope".into()], ..Default::default() };
        let got: Vec<String> = req.whiteouts_after(&set, &view).into_iter().collect();
        assert_eq!(got, ["a"]);
    }

    #[test]
    fn rebase_removes_only_unchanged_copies() {
        let t = tempfile::Builder::new().prefix("fsd-maint-").tempdir().unwrap();
        let mut s = StubStore::create(t.path(), "d").unwrap();
        s.add_item("a.txt", b"one", &[], true).unwrap();
        let up = store::session_dir(t.path(), "d").join("upper");
        fs::write(up.join("a.txt"), b"one").unwrap();
        fs::write(up.join("b.txt"), b"newer").unwrap();
        fs::write(store::session_dir(t.path(), "d").join("whiteouts"), "gone.txt\nkept.txt\n").unwrap();
        let sha = |b: &[u8]| hex::encode(Sha256::digest(b));
        let req = Rebase::parse(&format!(
            r#"{{"remove":[{{"path":"a.txt","sha256":"{}"}},{{"path":"b.txt","sha256":"{}"}}],"drop_whiteouts":["gone.txt"]}}"#,
            sha(b"one"),
            sha(b"older")
        ))
        .unwrap();
        let r = rebase_offline(t.path(), "d", &req).unwrap();
        assert_eq!(r["removed"], json!(["a.txt"]));
        assert!(!up.join("a.txt").exists());
        assert_eq!(fs::read(up.join("b.txt")).unwrap(), b"newer");
        assert_eq!(fs::read_to_string(store::session_dir(t.path(), "d").join("whiteouts")).unwrap(), "kept.txt\n");
        assert!(Rebase::parse(r#"{"unwhite":["../x"]}"#).is_err());
    }

    /// A symlink planted in `upper/` (as a directory and as a file) is listed as a symlink and
    /// never followed: nothing outside is copied, read, written or removed.
    #[test]
    fn planted_symlinks_are_never_followed() {
        let t = tempfile::Builder::new().prefix("fsd-maint-").tempdir().unwrap();
        let mut s = StubStore::create(t.path(), "d").unwrap();
        s.add_item("notes/a.txt", b"store a", &[], true).unwrap();
        s.add_item("evil/f.txt", b"store f", &[], true).unwrap();
        let outside = t.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"host secret").unwrap();
        let up = store::session_dir(t.path(), "d").join("upper");
        fs::create_dir_all(up.join("notes")).unwrap();
        fs::write(up.join("notes/mine.txt"), b"mine").unwrap();
        fs::write(up.join("notes/x.pyc"), b"cache").unwrap();
        symlink(&outside, up.join("evil")).unwrap();
        symlink(outside.join("secret.txt"), up.join("notes/link.txt")).unwrap();

        let out = t.path().join("export");
        let m = export(t.path(), "d", &ExportOptions { out: Some(&out), hash: false, ignore: ignore() }).unwrap();
        let entries = m["entries"].as_array().unwrap();
        let by = |p: &str| entries.iter().find(|e| e["path"] == p).cloned();
        assert_eq!(by("evil").unwrap()["type"], "l");
        assert_eq!(by("notes/link.txt").unwrap()["type"], "l");
        assert!(by("evil/secret.txt").is_none());
        assert_eq!(by("notes/mine.txt").unwrap()["sha256"], hex::encode(Sha256::digest(b"mine")));
        assert_eq!(by("notes/x.pyc").unwrap()["ignored"], true);
        assert!(by("notes/x.pyc").unwrap().get("sha256").is_none());
        assert_eq!(fs::read(out.join("notes/mine.txt")).unwrap(), b"mine");
        assert!(!out.join("evil").exists() && !out.join("notes/link.txt").exists() && !out.join("notes/x.pyc").exists());

        // Reads: the session's copy, the store's blob, and nothing through a link.
        let read = |p: &str| -> Option<Vec<u8>> {
            read_path(t.path(), "d", p, false).unwrap().map(|f| {
                let mut v = Vec::new();
                match f {
                    Found::Upper(mut f) | Found::Store(mut f, _, _) => f.read_to_end(&mut v).unwrap(),
                };
                v
            })
        };
        assert_eq!(read("notes/mine.txt").unwrap(), b"mine");
        assert_eq!(read("notes/a.txt").unwrap(), b"store a");
        assert_eq!(read("notes/link.txt"), None);
        assert_eq!(read("evil/secret.txt"), None);
        assert_eq!(read("evil/f.txt"), None, "the link shadows the store directory");

        // A write through the planted directory link replaces the link with a directory.
        write_path(&up, "evil/new.txt", b"agent", None).unwrap();
        assert!(fs::symlink_metadata(up.join("evil")).unwrap().is_dir());
        assert_eq!(fs::read(up.join("evil/new.txt")).unwrap(), b"agent");
        write_path(&up, "notes/link.txt", b"over the link", None).unwrap();
        assert!(fs::symlink_metadata(up.join("notes/link.txt")).unwrap().is_file());

        // Removing by content never touches a link's target.
        symlink(outside.join("secret.txt"), up.join("notes/link2.txt")).unwrap();
        let sha = hex::encode(Sha256::digest(b"host secret"));
        let req = Rebase { remove: vec![("notes/link2.txt".into(), sha)], ..Default::default() };
        assert!(req.apply_upper(&Upper::open(&up).unwrap()).unwrap().is_empty());

        assert_eq!(fs::read(outside.join("secret.txt")).unwrap(), b"host secret");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    }

    #[test]
    fn write_gives_new_files_and_directories_to_the_owner() {
        let t = tempfile::Builder::new().prefix("fsd-maint-").tempdir().unwrap();
        let root = t.path().join("r");
        fs::create_dir(&root).unwrap();
        write_path(&root, "a/b/c.txt", b"x", Some((1000, 1000))).unwrap();
        use std::os::unix::fs::MetadataExt;
        for p in ["a", "a/b", "a/b/c.txt"] {
            let m = fs::symlink_metadata(root.join(p)).unwrap();
            if unsafe { libc::geteuid() } == 0 {
                assert_eq!((m.uid(), m.gid()), (1000, 1000), "{p}");
            }
        }
        assert_eq!(fs::read_dir(root.join("a/b")).unwrap().count(), 1, "no temporary left behind");
    }
}
