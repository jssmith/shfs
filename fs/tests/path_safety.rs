//! Path safety: whatever is in `upper/`, the daemon never follows a symlink on the host.
//!
//! The kernel follows symlinks itself and never asks the daemon to look up a name under a
//! symlink, but a guest kernel (virtio-fs) or a compromised gVisor sentry can send any request,
//! and a kernel can hold inodes from before a directory was replaced by a symlink. So most tests
//! here call `DriveFs` directly, the way such a client would, with symlinks planted in `upper/`:
//! as intermediate directories and as last names, pointing at `/etc`, at another session's
//! directory and at the blob store. Each test snapshots every target before and after, and
//! fails if any host file outside `upper/` was read (content returned), written, created,
//! removed, renamed or had its attributes changed. One test does the same through a real
//! mount with the kernel's caches primed.

use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::{Path, PathBuf};
use std::time::Duration;

use agent_drive_fs::daemon::{Mount, Options};
use agent_drive_fs::drivefs::{Config, DriveFs, ROOT_INO};
use agent_drive_fs::store;
use agent_drive_fs::stub::StubStore;
use fuse_backend_rs::abi::fuse_abi::{CreateIn, stat64};
use fuse_backend_rs::api::filesystem::{Context, DirEntry, FileSystem, SetattrValid, ZeroCopyReader, ZeroCopyWriter};
use fuse_backend_rs::common::file_buf::FileVolatileSlice;
use fuse_backend_rs::common::file_traits::FileReadWriteVolatile;

const DIR: &str = "a8-safe";
const OTHER: &str = "a8-other";
const SECRET: &[u8] = b"OTHER SESSION SECRET\n";
const MARK: &str = "a8-planted";

// ---- a client that speaks to DriveFs directly ---------------------------------------------

struct VecWriter(Vec<u8>);

impl io::Write for VecWriter {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl ZeroCopyWriter for VecWriter {
    fn write_from(&mut self, f: &mut dyn FileReadWriteVolatile, count: usize, off: u64) -> io::Result<usize> {
        let mut buf = vec![0u8; count.min(1 << 20)];
        let n = f.read_at_volatile(unsafe { FileVolatileSlice::from_mut_slice(&mut buf) }, off)?;
        self.0.extend_from_slice(&buf[..n]);
        Ok(n)
    }
    fn available_bytes(&self) -> usize {
        1 << 20
    }
}

struct SliceReader(Vec<u8>);

impl io::Read for SliceReader {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        let n = b.len().min(self.0.len());
        b[..n].copy_from_slice(&self.0[..n]);
        self.0.drain(..n);
        Ok(n)
    }
}

impl ZeroCopyReader for SliceReader {
    fn read_to(&mut self, f: &mut dyn FileReadWriteVolatile, count: usize, off: u64) -> io::Result<usize> {
        let n = count.min(self.0.len());
        let mut buf = self.0[..n].to_vec();
        let w = f.write_at_volatile(unsafe { FileVolatileSlice::from_mut_slice(&mut buf) }, off)?;
        self.0.drain(..w);
        Ok(w)
    }
}

fn c(s: &str) -> CString {
    CString::new(s).unwrap()
}

struct Client {
    fs: DriveFs,
    ctx: Context,
}

impl Client {
    fn lookup(&self, parent: u64, name: &str) -> io::Result<u64> {
        self.fs.lookup(&self.ctx, parent, &c(name)).map(|e| e.inode)
    }
    fn walk(&self, path: &str) -> u64 {
        let mut ino = ROOT_INO;
        for comp in path.split('/') {
            ino = self.lookup(ino, comp).unwrap_or_else(|e| panic!("lookup {path}: {e}"));
        }
        ino
    }
    fn read_all(&self, ino: u64, flags: u32) -> io::Result<Vec<u8>> {
        let (fh, _, _) = self.fs.open(&self.ctx, ino, flags, 0)?;
        let fh = fh.unwrap();
        let mut w = VecWriter(Vec::new());
        let r = self.fs.read(&self.ctx, ino, fh, &mut w, 1 << 16, 0, None, 0);
        let _ = self.fs.release(&self.ctx, ino, 0, fh, false, false, None);
        r.map(|_| w.0)
    }
    fn write_at(&self, ino: u64, flags: u32, data: &[u8]) -> io::Result<usize> {
        let (fh, _, _) = self.fs.open(&self.ctx, ino, flags, 0)?;
        let fh = fh.unwrap();
        let mut r = SliceReader(data.to_vec());
        let n = self.fs.write(&self.ctx, ino, fh, &mut r, data.len() as u32, 0, None, false, 0, 0);
        let _ = self.fs.release(&self.ctx, ino, 0, fh, false, false, None);
        n
    }
    fn create(&self, parent: u64, name: &str, flags: i32) -> io::Result<u64> {
        let args = CreateIn { flags: flags as u32, mode: 0o644, umask: 0, fuse_flags: 0 };
        let (e, fh, _, _) = self.fs.create(&self.ctx, parent, &c(name), args)?;
        if let Some(fh) = fh {
            let mut r = SliceReader(b"planted\n".to_vec());
            let _ = self.fs.write(&self.ctx, e.inode, fh, &mut r, 8, 0, None, false, 0, 0);
            let _ = self.fs.release(&self.ctx, e.inode, 0, fh, false, false, None);
        }
        Ok(e.inode)
    }
    fn setattr(&self, ino: u64, valid: SetattrValid) -> io::Result<()> {
        let mut a: stat64 = unsafe { std::mem::zeroed() };
        a.st_mode = 0o777;
        a.st_size = 0;
        a.st_uid = 4242;
        a.st_gid = 4242;
        a.st_mtime = 1;
        a.st_atime = 1;
        self.fs.setattr(&self.ctx, ino, a, None, valid).map(|_| ())
    }
    fn list(&self, ino: u64) -> io::Result<Vec<String>> {
        let (fh, _) = self.fs.opendir(&self.ctx, ino, 0)?;
        let fh = fh.unwrap();
        let mut names = Vec::new();
        let r = self.fs.readdir(&self.ctx, ino, fh, 1 << 16, 0, &mut |d: DirEntry| {
            names.push(String::from_utf8_lossy(d.name).into_owned());
            Ok(1)
        });
        let _ = self.fs.releasedir(&self.ctx, ino, 0, fh);
        r.map(|_| names)
    }
}

// ---- targets and snapshots ----------------------------------------------------------------

/// Everything observable about a tree: type, mode, owner, size, mtime and content of each
/// entry (content only below 1 MiB; /etc is compared at its top level only).
fn snapshot(root: &Path, recurse: bool) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    fn walk(root: &Path, dir: &Path, recurse: bool, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
            let Ok(m) = fs::symlink_metadata(&p) else { continue };
            let mut v = format!("{:o} {}:{} {} {}.{}", m.mode(), m.uid(), m.gid(), m.size(), m.mtime(), m.mtime_nsec());
            if m.file_type().is_symlink() {
                v += &format!(" -> {:?}", fs::read_link(&p).unwrap());
            } else if m.is_file() && m.size() < (1 << 20) && recurse {
                v += &format!(" {:?}", fs::read(&p).unwrap_or_default());
            }
            out.insert(rel, v);
            if recurse && m.is_dir() {
                walk(root, &p, recurse, out);
            }
        }
    }
    walk(root, root, recurse, &mut out);
    out
}

struct Target {
    name: &'static str,
    path: PathBuf,
    recurse: bool,
    before: BTreeMap<String, String>,
}

impl Target {
    fn new(name: &'static str, path: PathBuf, recurse: bool) -> Target {
        let before = snapshot(&path, recurse);
        Target { name, path, recurse, before }
    }
    fn check(&self) {
        // Nothing the attacks named may exist there, even if a bug made it.
        let planted: Vec<_> = fs::read_dir(&self.path)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(MARK))
            .map(|e| e.path())
            .collect();
        for p in &planted {
            let _ = fs::remove_file(p).or_else(|_| fs::remove_dir_all(p));
        }
        assert!(planted.is_empty(), "{}: created on the host: {planted:?}", self.name);
        let after = snapshot(&self.path, self.recurse);
        assert_eq!(self.before, after, "{}: host files outside upper/ changed", self.name);
    }
}

struct Setup {
    _tmp: tempfile::TempDir,
    data: PathBuf,
    upper: PathBuf,
    targets: Vec<Target>,
}

fn setup() -> Setup {
    let tmp = tempfile::Builder::new().prefix("a8-fs-safe-").tempdir().unwrap();
    let data = tmp.path().join("data");
    let mut s = StubStore::create(&data, DIR).unwrap();
    s.add_synthetic().unwrap();
    s.add_item("code/src/main.rs", b"fn main() {}\n", &[], true).unwrap();
    drop(s);
    // Another session with private content, in the same data directory.
    let other = store::session_dir(&data, OTHER);
    fs::create_dir_all(other.join("upper/notes")).unwrap();
    for name in ["todo.txt", "readme.md", "main.rs", "secret", ".a2-copyup"] {
        fs::write(other.join("upper/notes").join(name), SECRET).unwrap();
    }
    fs::create_dir(other.join("upper/notes/sub")).unwrap();
    fs::write(other.join("whiteouts"), b"x\n").unwrap();
    let upper = store::session_dir(&data, DIR).join("upper");
    let targets = vec![
        Target::new("/etc", PathBuf::from("/etc"), false),
        Target::new("other session", other.join("upper/notes"), true),
        Target::new("other session dir", other.clone(), true),
        Target::new("blob store", data.join("blobs"), true),
    ];
    Setup { _tmp: tmp, data, upper, targets }
}

fn client(data: &Path) -> Client {
    Client { fs: DriveFs::new(Config::new(data, DIR)).unwrap(), ctx: Context::new() }
}

/// Where each kind of planted symlink points, as an absolute host path.
fn target_dirs(s: &Setup) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/etc"),
        store::session_dir(&s.data, OTHER).join("upper/notes"),
        store::session_dir(&s.data, OTHER),
        s.data.join("blobs"),
    ]
}

/// Asserts that no reply carried another session's or a host file's content.
fn no_leak(r: io::Result<Vec<u8>>) {
    if let Ok(b) = r {
        assert!(!b.windows(SECRET.len()).any(|w| w == SECRET), "leaked another session's content");
        assert!(!String::from_utf8_lossy(&b).contains("root:"), "leaked /etc/passwd");
    }
}

fn names_of(t: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(t).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    v.extend(["passwd", "hostname", "todo.txt", "secret", "sub", "upper", "whiteouts"].map(String::from));
    v.sort();
    v.dedup();
    v
}

/// Whether to aim writes, removals and renames at existing names in the target. Not for
/// /etc on a shared machine: there only lookups, reads and creations of new `a8-planted-*`
/// names are tried (the other targets cover the same code paths destructively).
fn destructive(target: &Path) -> bool {
    target != Path::new("/etc")
}

/// Every operation a client can send, aimed at `dir_ino` (now a symlink in upper/) and at
/// inodes the client looked up under it before the symlink was planted.
fn attack_dir(cl: &Client, dir_ino: u64, stale: &[u64], target: &Path) {
    let destructive = destructive(target);
    use libc::{O_APPEND, O_CREAT, O_EXCL, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY};
    for name in names_of(target) {
        // Lookups under the symlink find nothing.
        if let Ok(ino) = cl.lookup(dir_ino, &name) {
            panic!("lookup of {name} under a symlink found inode {ino}");
        }
    }
    for &ino in stale {
        assert!(cl.fs.getattr(&cl.ctx, ino, None).is_err(), "getattr through a symlink");
        no_leak(cl.read_all(ino, O_RDONLY as u32));
        no_leak(cl.read_all(ino, O_RDWR as u32));
        if !destructive {
            continue;
        }
        let _ = cl.write_at(ino, O_WRONLY as u32, b"a8-planted\n");
        let _ = cl.write_at(ino, (O_WRONLY | O_APPEND) as u32, b"a8-planted\n");
        let _ = cl.write_at(ino, (O_WRONLY | O_TRUNC) as u32, b"a8-planted\n");
        for v in [SetattrValid::MODE, SetattrValid::SIZE, SetattrValid::UID | SetattrValid::GID, SetattrValid::MTIME | SetattrValid::ATIME] {
            let _ = cl.setattr(ino, v);
        }
        no_leak(cl.fs.readlink(&cl.ctx, ino));
        let _ = cl.fs.getxattr(&cl.ctx, ino, &c("user.drive.item_id"), 64);
        let _ = cl.fs.listxattr(&cl.ctx, ino, 64);
        let _ = cl.fs.link(&cl.ctx, ino, dir_ino, &c("a8-planted-link"));
        let _ = cl.fs.link(&cl.ctx, ino, ROOT_INO, &c("a8-planted-link"));
        let _ = cl.fs.access(&cl.ctx, ino, 4);
    }
    // Listing the symlink as a directory.
    if let Ok(names) = cl.list(dir_ino) {
        for n in &names {
            assert!(n == "." || n == "..", "listing through a symlink showed {n}");
        }
    }
    // Creating under it.
    let _ = cl.create(dir_ino, "a8-planted-file", O_WRONLY | O_CREAT | O_EXCL);
    if destructive {
        let _ = cl.create(dir_ino, "todo.txt", O_WRONLY | O_CREAT | O_TRUNC);
        let _ = cl.create(dir_ino, "secret", O_WRONLY | O_CREAT | O_TRUNC);
    }
    let _ = cl.fs.mkdir(&cl.ctx, dir_ino, &c("a8-planted-dir"), 0o755, 0);
    let _ = cl.fs.symlink(&cl.ctx, &c("/"), dir_ino, &c("a8-planted-sym"));
    let _ = cl.fs.mknod(&cl.ctx, dir_ino, &c("a8-planted-nod"), libc::S_IFREG | 0o644, 0, 0);
    let _ = cl.fs.fsyncdir(&cl.ctx, dir_ino, false, 0);
    let _ = cl.fs.statfs(&cl.ctx, dir_ino);
    if !destructive {
        return;
    }
    // Removing and renaming under it, in both directions.
    for name in names_of(target) {
        let _ = cl.fs.unlink(&cl.ctx, dir_ino, &c(&name));
        let _ = cl.fs.rmdir(&cl.ctx, dir_ino, &c(&name));
        let _ = cl.fs.rename(&cl.ctx, dir_ino, &c(&name), ROOT_INO, &c("a8-planted-stolen"), 0);
    }
    let _ = cl.create(ROOT_INO, "a8-planted-src", O_WRONLY | O_CREAT | O_EXCL);
    let _ = cl.fs.rename(&cl.ctx, ROOT_INO, &c("a8-planted-src"), dir_ino, &c("a8-planted-moved"), 0);
    let _ = cl.fs.rename(&cl.ctx, ROOT_INO, &c("a8-planted-src"), dir_ino, &c("secret"), 0);
    let _ = cl.fs.rename(&cl.ctx, ROOT_INO, &c("notes"), dir_ino, &c("a8-planted-notes"), 0);
}

/// A store directory (`notes`) that the session never wrote to, then `upper/notes` planted as
/// a symlink: the kernel (or guest) still holds inodes for `notes` and the files in it.
#[test]
fn symlink_in_place_of_a_store_directory() {
    let s = setup();
    for t in target_dirs(&s) {
        let _ = fs::remove_file(s.upper.join("notes"));
        let cl = client(&s.data);
        let dir = cl.walk("notes");
        let stale = vec![cl.walk("notes/todo.txt"), cl.walk("notes/readme.md")];
        symlink(&t, s.upper.join("notes")).unwrap();
        attack_dir(&cl, dir, &stale, &t);
        // Writing to a store file under it would copy up into the symlink's target.
        if destructive(&t) {
            assert!(cl.write_at(stale[0], libc::O_WRONLY as u32, b"x").is_err());
        }
        drop(cl);
        for t in &s.targets {
            t.check();
        }
    }
}

/// The session's own directory in upper/ replaced by a symlink, one and two levels down.
#[test]
fn symlink_in_place_of_a_session_directory() {
    let s = setup();
    for t in target_dirs(&s) {
        let cl = client(&s.data);
        let _ = fs::remove_dir_all(s.upper.join("mine"));
        let _ = fs::remove_file(s.upper.join("mine"));
        let _ = fs::remove_dir_all(s.upper.join("code"));
        cl.fs.mkdir(&cl.ctx, ROOT_INO, &c("mine"), 0o755, 0).unwrap();
        let mine = cl.walk("mine");
        let f = cl.create(mine, "todo.txt", libc::O_WRONLY | libc::O_CREAT).unwrap();
        // code/src/main.rs: a store file, copied up so code/ and code/src/ are real in upper/.
        let main = cl.walk("code/src/main.rs");
        cl.write_at(main, libc::O_WRONLY as u32, b"// edited\n").unwrap();
        let src = cl.walk("code/src");
        assert!(s.upper.join("code/src/main.rs").is_file());

        fs::remove_dir_all(s.upper.join("mine")).unwrap();
        symlink(&t, s.upper.join("mine")).unwrap();
        attack_dir(&cl, mine, &[f], &t);

        fs::remove_dir_all(s.upper.join("code/src")).unwrap();
        symlink(&t, s.upper.join("code/src")).unwrap();
        attack_dir(&cl, src, &[main], &t);
        drop(cl);
        for t in &s.targets {
            t.check();
        }
    }
}

/// Symlinks as last names in a real upper/ directory: in place of a store item, of a file
/// the session made, and of the copy-up temporary.
#[test]
fn symlink_as_a_last_name() {
    let s = setup();
    for t in target_dirs(&s) {
        let _ = fs::remove_dir_all(s.upper.join("notes"));
        let _ = fs::remove_dir_all(s.upper.join("projects"));
        let cl = client(&s.data);
        let victim = if t == Path::new("/etc") { t.join("passwd") } else { t.join("secret") };
        fs::create_dir_all(s.upper.join("notes")).unwrap();
        fs::create_dir_all(s.upper.join("projects/acme")).unwrap();
        // In place of the store item notes/todo.txt (upper shadows it).
        symlink(&victim, s.upper.join("notes/todo.txt")).unwrap();
        // The copy-up temporary in projects/acme, where a write to a store file goes first.
        symlink(&victim, s.upper.join("projects/acme/.a2-copyup")).unwrap();
        // A directory symlink as a last name.
        symlink(&t, s.upper.join("notes/dirlink")).unwrap();

        let todo = cl.walk("notes/todo.txt");
        let dirlink = cl.walk("notes/dirlink");
        for flags in [libc::O_RDONLY, libc::O_RDWR] {
            no_leak(cl.read_all(todo, flags as u32));
        }
        if !destructive(&t) {
            drop(cl);
            for t in &s.targets {
                t.check();
            }
            continue;
        }
        for flags in [libc::O_WRONLY, libc::O_WRONLY | libc::O_TRUNC, libc::O_WRONLY | libc::O_APPEND] {
            assert!(cl.write_at(todo, flags as u32, b"a8-planted\n").is_err());
        }
        let notes = cl.walk("notes");
        assert!(cl.create(notes, "todo.txt", libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC).is_err());
        assert_eq!(cl.setattr(todo, SetattrValid::MODE).unwrap_err().raw_os_error(), Some(libc::EOPNOTSUPP));
        assert!(cl.setattr(todo, SetattrValid::SIZE).is_err());
        // Times and owner apply to the link itself (AT_SYMLINK_NOFOLLOW), never the target.
        let _ = cl.setattr(todo, SetattrValid::MTIME | SetattrValid::ATIME);
        let _ = cl.setattr(todo, SetattrValid::UID | SetattrValid::GID);
        attack_dir(&cl, dirlink, &[], &t);

        // A write to a store file copies up through the planted temporary name: it replaces
        // the symlink, it does not write through it.
        let plan = cl.walk("projects/acme/plan.md");
        cl.write_at(plan, (libc::O_WRONLY | libc::O_APPEND) as u32, b"more\n").unwrap();
        assert_eq!(fs::read(s.upper.join("projects/acme/plan.md")).unwrap(), b"Plan for Acme Robotics (synthetic).\nmore\n");
        assert!(!cl.list(cl.walk("projects/acme")).unwrap().contains(&".a2-copyup".to_string()));

        // Renaming and unlinking a symlink moves or removes the link only.
        cl.fs.rename(&cl.ctx, notes, &c("todo.txt"), notes, &c("moved"), 0).unwrap();
        assert!(fs::symlink_metadata(s.upper.join("notes/moved")).unwrap().file_type().is_symlink());
        cl.fs.unlink(&cl.ctx, notes, &c("moved")).unwrap();
        cl.fs.unlink(&cl.ctx, notes, &c("dirlink")).unwrap();
        drop(cl);
        for t in &s.targets {
            t.check();
        }
    }
}

/// The same through the kernel: the mount's caches are primed, then `upper/notes` becomes a
/// symlink to another session's directory. The link is relative, and the mount point sits at a
/// different depth from upper/, so the kernel following it on the host (its own business)
/// finds nothing, while a daemon that followed it would reach the other session.
#[test]
fn symlink_planted_under_a_cached_mount() {
    let s = setup();
    let mnt = s._tmp.path().join("m/a/b/c/mnt");
    fs::create_dir_all(&mnt).unwrap();
    let mut cfg = Config::new(&s.data, DIR);
    cfg.entry_timeout = Duration::from_secs(60);
    cfg.attr_timeout = Duration::from_secs(60);
    let m = Mount::start(DriveFs::new(cfg).unwrap(), &mnt, Options::default()).unwrap();
    assert_eq!(fs::read(mnt.join("notes/todo.txt")).unwrap(), b"buy milk\nwrite spike\n");
    assert!(fs::metadata(mnt.join("notes/readme.md")).is_ok());
    let rel = format!("../../{OTHER}/upper/notes");
    assert!(s.upper.join(&rel).is_dir(), "the relative link reaches the other session from upper/");
    symlink(&rel, s.upper.join("notes")).unwrap();

    no_leak(fs::read(mnt.join("notes/todo.txt")));
    no_leak(fs::read(mnt.join("notes/secret")));
    let _ = fs::write(mnt.join("notes/readme.md"), b"a8-planted\n");
    let _ = fs::OpenOptions::new().append(true).open(mnt.join("notes/todo.txt")).map(|mut f| io::Write::write_all(&mut f, b"x"));
    let _ = fs::write(mnt.join("notes/a8-planted-new"), b"x");
    let _ = fs::create_dir(mnt.join("notes/a8-planted-dir"));
    let _ = fs::remove_file(mnt.join("notes/secret"));
    let _ = fs::rename(mnt.join("notes/todo.txt"), mnt.join("a8-planted-stolen"));
    let _ = fs::read_dir(mnt.join("notes")).map(|rd| rd.count());
    m.stop();
    for t in &s.targets {
        t.check();
    }
}

#[test]
fn names_with_slashes_or_dots_are_refused() {
    let s = setup();
    let cl = client(&s.data);
    for bad in ["..", ".", "a/b", "../../etc"] {
        assert_eq!(cl.lookup(ROOT_INO, bad).unwrap_err().raw_os_error(), Some(libc::EINVAL), "{bad}");
        assert!(cl.create(ROOT_INO, bad, libc::O_WRONLY | libc::O_CREAT).is_err());
    }
    drop(cl);
    for t in &s.targets {
        t.check();
    }
}
