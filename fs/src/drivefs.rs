//! The session's `/drive`: `session_view` ∪ `upper/` − `whiteouts` (docs/contracts.md §2).
//!
//! The file system is path based. Inode numbers are handed out per path on first lookup and
//! follow renames. Every lookup, getattr, open and listing first checks the session's epoch and
//! reloads the view when it changed, so a trashed or ringed item is gone on the next operation.
//! The kernel is told not to cache entries or attributes (timeouts default to zero) for the
//! same reason.
//!
//! One implementation of `fuse_backend_rs::api::filesystem::FileSystem` serves both `/dev/fuse`
//! (gVisor) and virtio-fs (microVMs); see `tests/virtio.rs`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{CStr, CString};
use std::fs::{self, File, OpenOptions as StdOpen};
use std::io::{self, Write};
use std::mem::ManuallyDrop;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use fuse_backend_rs::abi::fuse_abi::{CreateIn, stat64, statvfs64};
use fuse_backend_rs::api::filesystem::{
    Context, DirEntry, Entry, FileSystem, FsOptions, GetxattrReply, ListxattrReply, OpenOptions,
    SetattrValid, ZeroCopyReader, ZeroCopyWriter,
};
use rusqlite::Connection;

use crate::store::{self, ActivityLog, OpenRecord};
use crate::view::{ChildKind, Lower, View, join, parent_of};

pub const ROOT_INO: u64 = 1;
const XATTR_ITEM_ID: &[u8] = b"user.drive.item_id";

fn err(code: i32) -> io::Error {
    io::Error::from_raw_os_error(code)
}

fn dberr(e: rusqlite::Error) -> io::Error {
    log::error!("store: {e}");
    err(libc::EIO)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Debug, Clone)]
pub struct Config {
    pub data: PathBuf,
    pub dir_id: String,
    pub entry_timeout: Duration,
    pub attr_timeout: Duration,
}

impl Config {
    pub fn new(data: impl Into<PathBuf>, dir_id: &str) -> Config {
        Config {
            data: data.into(),
            dir_id: dir_id.to_string(),
            entry_timeout: Duration::ZERO,
            attr_timeout: Duration::ZERO,
        }
    }
}

/// What a path currently is in the merged view.
enum Node {
    Upper(fs::Metadata),
    Lower(Lower),
}

struct Handle {
    file: File,
    path: String,
    /// For a handle reading the item's blob: the item it was opened on.
    lower_item: Option<String>,
}

struct DirItem {
    name: Vec<u8>,
    ino: u64,
    type_: u32,
}

struct State {
    view: Arc<View>,
    whiteouts: HashSet<String>,
    whiteout_file: File,
    inodes: HashMap<u64, Option<String>>,
    by_path: HashMap<String, u64>,
    next_ino: u64,
    handles: HashMap<u64, Arc<Handle>>,
    /// Directory handle to (listing, whether a readdir has served it yet).
    dir_handles: HashMap<u64, (Arc<Vec<DirItem>>, bool)>,
    next_fh: u64,
}

pub struct DriveFs {
    cfg: Config,
    upper: PathBuf,
    db: Mutex<Connection>,
    st: Mutex<State>,
    activity: ActivityLog,
    uid: u32,
    gid: u32,
    mount_time: i64,
}

fn file_type_bits(kind: ChildKind) -> u32 {
    match kind {
        ChildKind::File => libc::DT_REG as u32,
        ChildKind::Symlink => libc::DT_LNK as u32,
        ChildKind::Dir => libc::DT_DIR as u32,
    }
}

fn cpath(p: &Path) -> io::Result<CString> {
    CString::new(p.as_os_str().as_bytes()).map_err(|_| err(libc::EINVAL))
}

fn name_str(name: &CStr) -> io::Result<&str> {
    let s = name.to_str().map_err(|_| err(libc::EINVAL))?;
    if s.is_empty() || s == "." || s == ".." || s.contains('/') {
        return Err(err(libc::EINVAL));
    }
    Ok(s)
}

fn open_upper(path: &Path, flags: i32, mode: u32) -> io::Result<File> {
    let c = cpath(path)?;
    let fd = unsafe { libc::open(c.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW, mode) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn access_mode(flags: u32) -> &'static str {
    match flags as i32 & libc::O_ACCMODE {
        libc::O_WRONLY => "w",
        libc::O_RDWR => "rw",
        _ => "r",
    }
}

fn wants_write(flags: u32) -> bool {
    let acc = flags as i32 & libc::O_ACCMODE;
    acc == libc::O_WRONLY || acc == libc::O_RDWR || flags as i32 & libc::O_TRUNC != 0
}

impl DriveFs {
    pub fn new(cfg: Config) -> anyhow::Result<DriveFs> {
        let sess = store::session_dir(&cfg.data, &cfg.dir_id);
        let upper = sess.join("upper");
        fs::create_dir_all(&upper)?;
        let wpath = sess.join("whiteouts");
        let whiteouts: HashSet<String> = match fs::read_to_string(&wpath) {
            Ok(s) => s.lines().filter(|l| !l.is_empty()).map(str::to_string).collect(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => HashSet::new(),
            Err(e) => return Err(e.into()),
        };
        let whiteout_file = StdOpen::new().create(true).append(true).open(&wpath)?;
        let mut db = store::open(&cfg.data)?;
        let (ep, rows) = store::load_view(&mut db, &cfg.dir_id)?;
        let view = Arc::new(View::build(ep, rows));
        let mut inodes = HashMap::new();
        inodes.insert(ROOT_INO, Some(String::new()));
        let mut by_path = HashMap::new();
        by_path.insert(String::new(), ROOT_INO);
        let activity = ActivityLog::start(&cfg.data, &cfg.dir_id)?;
        Ok(DriveFs {
            upper,
            db: Mutex::new(db),
            st: Mutex::new(State {
                view,
                whiteouts,
                whiteout_file,
                inodes,
                by_path,
                next_ino: ROOT_INO + 1,
                handles: HashMap::new(),
                dir_handles: HashMap::new(),
                next_fh: 1,
            }),
            activity,
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
            mount_time: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            cfg,
        })
    }

    pub fn upper_dir(&self) -> &Path {
        &self.upper
    }

    /// Waits until every open recorded so far is in `activity`.
    pub fn flush_activity(&self) {
        self.activity.flush();
    }

    // ---- freshness -------------------------------------------------------------------------

    /// Checks the epoch and reloads the view if it changed. Called before every lookup,
    /// getattr, open, read of an item's blob, and listing. Lock order: db, then state.
    fn fresh(&self) -> io::Result<()> {
        let mut db = lock(&self.db);
        let ep = store::epoch(&db, &self.cfg.dir_id).map_err(dberr)?;
        if ep == lock(&self.st).view.epoch {
            return Ok(());
        }
        let (ep, rows) = store::load_view(&mut db, &self.cfg.dir_id).map_err(dberr)?;
        let view = Arc::new(View::build(ep, rows));
        log::debug!("view reloaded at epoch {ep}: {} entries", view.entries.len());
        lock(&self.st).view = view;
        Ok(())
    }

    // ---- path model ------------------------------------------------------------------------

    fn up(&self, path: &str) -> PathBuf {
        if path.is_empty() { self.upper.clone() } else { self.upper.join(path) }
    }

    fn whited(st: &State, path: &str) -> bool {
        if st.whiteouts.is_empty() {
            return false;
        }
        let mut p = path;
        while !p.is_empty() {
            if st.whiteouts.contains(p) {
                return true;
            }
            p = parent_of(p);
        }
        false
    }

    /// The lower (store) entry at `path`, if the session can still see it.
    fn lower(st: &State, path: &str) -> Option<Lower> {
        if Self::whited(st, path) {
            return None;
        }
        st.view.get(path)
    }

    fn resolve(&self, st: &State, path: &str) -> Option<Node> {
        if let Ok(m) = fs::symlink_metadata(self.up(path)) {
            return Some(Node::Upper(m));
        }
        Self::lower(st, path).map(Node::Lower)
    }

    fn path_of(st: &State, ino: u64) -> io::Result<String> {
        match st.inodes.get(&ino) {
            Some(Some(p)) => Ok(p.clone()),
            _ => Err(err(libc::ENOENT)),
        }
    }

    fn ino_for(st: &mut State, path: &str) -> u64 {
        if let Some(i) = st.by_path.get(path) {
            return *i;
        }
        let i = st.next_ino;
        st.next_ino += 1;
        st.inodes.insert(i, Some(path.to_string()));
        st.by_path.insert(path.to_string(), i);
        i
    }

    fn under(p: &str, dir: &str) -> bool {
        p.len() > dir.len() && p.starts_with(dir) && p.as_bytes()[dir.len()] == b'/'
    }

    /// Forgets the inode of `path` and of everything under it.
    fn detach(st: &mut State, path: &str) {
        if let Some(i) = st.by_path.remove(path) {
            st.inodes.insert(i, None);
        }
        let below: Vec<String> =
            st.by_path.keys().filter(|p| Self::under(p, path)).cloned().collect();
        for p in below {
            if let Some(i) = st.by_path.remove(&p) {
                st.inodes.insert(i, None);
            }
        }
    }

    /// Moves inode numbers from `old` (and below) to `new`, after a rename.
    fn move_inodes(st: &mut State, old: &str, new: &str, is_dir: bool) {
        Self::detach(st, new);
        let mut moves: Vec<(String, u64)> = Vec::new();
        if let Some(i) = st.by_path.remove(old) {
            moves.push((new.to_string(), i));
        }
        if is_dir {
            let below: Vec<String> =
                st.by_path.keys().filter(|p| Self::under(p, old)).cloned().collect();
            for p in below {
                let i = st.by_path.remove(&p).unwrap();
                moves.push((format!("{new}{}", &p[old.len()..]), i));
            }
        }
        for (p, i) in moves {
            st.inodes.insert(i, Some(p.clone()));
            st.by_path.insert(p, i);
        }
    }

    fn add_whiteout(st: &mut State, path: &str) -> io::Result<()> {
        if st.whiteouts.insert(path.to_string()) {
            st.whiteout_file.write_all(format!("{path}\n").as_bytes())?;
        }
        Ok(())
    }

    // ---- attributes ------------------------------------------------------------------------

    fn attr_upper(&self, ino: u64, m: &fs::Metadata) -> stat64 {
        let mut s: stat64 = unsafe { std::mem::zeroed() };
        s.st_ino = ino;
        s.st_mode = m.mode();
        s.st_nlink = m.nlink();
        s.st_uid = m.uid();
        s.st_gid = m.gid();
        s.st_size = m.size() as i64;
        s.st_blksize = m.blksize() as i64;
        s.st_blocks = m.blocks() as i64;
        s.st_atime = m.atime();
        s.st_atime_nsec = m.atime_nsec();
        s.st_mtime = m.mtime();
        s.st_mtime_nsec = m.mtime_nsec();
        s.st_ctime = m.ctime();
        s.st_ctime_nsec = m.ctime_nsec();
        s
    }

    fn attr_lower(&self, ino: u64, l: &Lower) -> stat64 {
        let mut s: stat64 = unsafe { std::mem::zeroed() };
        s.st_ino = ino;
        s.st_uid = self.uid;
        s.st_gid = self.gid;
        s.st_blksize = 4096;
        let (mode, nlink, size, t) = match l {
            Lower::File { size, mtime, writable, .. } => {
                (libc::S_IFREG | if *writable { 0o644 } else { 0o444 }, 1, *size, *mtime)
            }
            Lower::Symlink { target } => (libc::S_IFLNK | 0o777, 1, target.len() as u64, self.mount_time),
            Lower::Dir => (libc::S_IFDIR | 0o755, 2, 4096, self.mount_time),
        };
        s.st_mode = mode;
        s.st_nlink = nlink;
        s.st_size = size as i64;
        s.st_blocks = size.div_ceil(512) as i64;
        s.st_atime = t;
        s.st_mtime = t;
        s.st_ctime = t;
        s
    }

    fn attr_of(&self, ino: u64, n: &Node) -> stat64 {
        match n {
            Node::Upper(m) => self.attr_upper(ino, m),
            Node::Lower(l) => self.attr_lower(ino, l),
        }
    }

    fn entry(&self, ino: u64, attr: stat64) -> Entry {
        Entry {
            inode: ino,
            generation: 0,
            attr,
            attr_flags: 0,
            attr_timeout: self.cfg.attr_timeout,
            entry_timeout: self.cfg.entry_timeout,
        }
    }

    fn entry_for(&self, st: &mut State, path: &str) -> io::Result<Entry> {
        let n = self.resolve(st, path).ok_or_else(|| err(libc::ENOENT))?;
        let ino = Self::ino_for(st, path);
        Ok(self.entry(ino, self.attr_of(ino, &n)))
    }

    // ---- copy-up ---------------------------------------------------------------------------

    fn ensure_upper_dir(&self, dir: &str) -> io::Result<()> {
        fs::create_dir_all(self.up(dir))
    }

    /// Makes `path` exist in `upper/`, copying the item's content unless `content` is false.
    fn copy_up(&self, path: &str, l: &Lower, content: bool) -> io::Result<()> {
        self.ensure_upper_dir(parent_of(path))?;
        let dst = self.up(path);
        match l {
            Lower::File { blob, mtime, writable, .. } => {
                // Callers hold the state lock, so one temporary name per directory is enough.
                let tmp = self.up(parent_of(path)).join(".a2-copyup");
                if content {
                    fs::copy(store::blob_path(&self.cfg.data, blob), &tmp)?;
                } else {
                    File::create(&tmp)?;
                }
                let f = StdOpen::new().write(true).open(&tmp)?;
                f.set_permissions(fs::Permissions::from_mode(if *writable { 0o644 } else { 0o444 }))?;
                if content {
                    let t = std::time::UNIX_EPOCH + Duration::from_secs((*mtime).max(0) as u64);
                    let _ = f.set_modified(t);
                }
                drop(f);
                fs::rename(&tmp, &dst)?;
            }
            Lower::Symlink { target } => std::os::unix::fs::symlink(target, &dst)?,
            Lower::Dir => fs::create_dir_all(&dst)?,
        }
        Ok(())
    }

    /// Copies a whole lower directory into `upper/`, for a directory rename.
    fn copy_up_tree(&self, st: &State, dir: &str) -> io::Result<()> {
        self.ensure_upper_dir(dir)?;
        let view = st.view.clone();
        let mut subdirs: Vec<&String> =
            view.dirs.keys().filter(|d| Self::under(d, dir)).collect();
        subdirs.sort();
        for d in subdirs {
            if Self::lower(st, d).is_some() {
                fs::create_dir_all(self.up(d))?;
            }
        }
        for (p, l) in view.descendants(dir) {
            if Self::lower(st, p).is_none() || fs::symlink_metadata(self.up(p)).is_ok() {
                continue;
            }
            self.copy_up(p, l, true)?;
        }
        Ok(())
    }

    // ---- listings --------------------------------------------------------------------------

    fn list(&self, st: &mut State, dir: &str) -> io::Result<Vec<DirItem>> {
        let mut names: BTreeMap<String, ChildKind> = BTreeMap::new();
        let mut found = false;
        if let Some(Lower::Dir) = Self::lower(st, dir) {
            found = true;
            let view = st.view.clone();
            if let Some(children) = view.dirs.get(dir) {
                for (name, kind) in children {
                    if !st.whiteouts.contains(&join(dir, name)) {
                        names.insert(name.clone(), *kind);
                    }
                }
            }
        }
        match fs::read_dir(self.up(dir)) {
            Ok(rd) => {
                found = true;
                for e in rd.flatten() {
                    let Some(name) = e.file_name().to_str().map(str::to_string) else { continue };
                    if name == ".a2-copyup" {
                        continue;
                    }
                    let kind = match e.file_type() {
                        Ok(t) if t.is_dir() => ChildKind::Dir,
                        Ok(t) if t.is_symlink() => ChildKind::Symlink,
                        _ => ChildKind::File,
                    };
                    names.insert(name, kind);
                }
            }
            Err(e) if e.raw_os_error() == Some(libc::ENOTDIR) => return Err(err(libc::ENOTDIR)),
            Err(_) => {}
        }
        if !found {
            return Err(err(libc::ENOENT));
        }
        let self_ino = Self::ino_for(st, dir);
        let parent_ino = Self::ino_for(st, parent_of(dir));
        let mut out = vec![
            DirItem { name: b".".to_vec(), ino: self_ino, type_: libc::DT_DIR as u32 },
            DirItem { name: b"..".to_vec(), ino: parent_ino, type_: libc::DT_DIR as u32 },
        ];
        for (name, kind) in names {
            let ino = Self::ino_for(st, &join(dir, &name));
            out.push(DirItem { name: name.into_bytes(), ino, type_: file_type_bits(kind) });
        }
        Ok(out)
    }

    fn is_empty_dir(&self, st: &mut State, dir: &str) -> io::Result<bool> {
        Ok(self.list(st, dir)?.len() <= 2)
    }

    fn new_handle(st: &mut State, h: Handle) -> u64 {
        let fh = st.next_fh;
        st.next_fh += 1;
        st.handles.insert(fh, Arc::new(h));
        fh
    }

    fn record_open(&self, path: &str, item_id: Option<String>, flags: u32) {
        self.activity.record(OpenRecord {
            ts: crate::time::now_iso(),
            item_id,
            path: path.to_string(),
            mode: access_mode(flags),
        });
    }

    /// Opens `path` for the kernel: copy-up on write, blob for reads of store items.
    fn open_path(&self, st: &mut State, path: &str, flags: u32) -> io::Result<u64> {
        let node = self.resolve(st, path).ok_or_else(|| err(libc::ENOENT))?;
        let lower_item = match st.view.entries.get(path) {
            Some(Lower::File { item_id, .. }) if !Self::whited(st, path) => Some(item_id.clone()),
            _ => None,
        };
        let keep = libc::O_ACCMODE | libc::O_APPEND | libc::O_TRUNC;
        let h = match node {
            Node::Upper(m) => {
                if m.is_dir() {
                    return Err(err(libc::EISDIR));
                }
                let file = open_upper(&self.up(path), flags as i32 & keep, 0)?;
                Handle { file, path: path.to_string(), lower_item: None }
            }
            Node::Lower(Lower::Dir) => return Err(err(libc::EISDIR)),
            Node::Lower(Lower::Symlink { .. }) => return Err(err(libc::ELOOP)),
            Node::Lower(ref l @ Lower::File { ref blob, writable, .. }) => {
                if wants_write(flags) {
                    if !writable {
                        return Err(err(libc::EACCES));
                    }
                    let trunc = flags as i32 & libc::O_TRUNC != 0;
                    self.copy_up(path, l, !trunc)?;
                    let file = open_upper(&self.up(path), flags as i32 & keep, 0)?;
                    Handle { file, path: path.to_string(), lower_item: None }
                } else {
                    let file = File::open(store::blob_path(&self.cfg.data, blob))?;
                    Handle { file, path: path.to_string(), lower_item: lower_item.clone() }
                }
            }
        };
        self.record_open(path, lower_item, flags);
        Ok(Self::new_handle(st, h))
    }

    fn handle(&self, fh: u64) -> io::Result<Arc<Handle>> {
        lock(&self.st).handles.get(&fh).cloned().ok_or_else(|| err(libc::EBADF))
    }

    fn setattr_path(&self, path: &str, attr: &stat64, fh: Option<u64>, valid: SetattrValid) -> io::Result<()> {
        let p = self.up(path);
        let c = cpath(&p)?;
        if valid.contains(SetattrValid::MODE) {
            fs::set_permissions(&p, fs::Permissions::from_mode(attr.st_mode & 0o7777))?;
        }
        if valid.intersects(SetattrValid::UID | SetattrValid::GID) {
            let uid = if valid.contains(SetattrValid::UID) { attr.st_uid } else { u32::MAX };
            let gid = if valid.contains(SetattrValid::GID) { attr.st_gid } else { u32::MAX };
            if unsafe { libc::lchown(c.as_ptr(), uid, gid) } < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        if valid.contains(SetattrValid::SIZE) {
            let h = fh.and_then(|f| lock(&self.st).handles.get(&f).cloned());
            match h {
                Some(h) if h.lower_item.is_none() => h.file.set_len(attr.st_size as u64)?,
                _ => StdOpen::new().write(true).open(&p)?.set_len(attr.st_size as u64)?,
            }
        }
        if valid.intersects(SetattrValid::ATIME | SetattrValid::MTIME) {
            let ts = |set: bool, now: bool, s: i64, ns: i64| libc::timespec {
                tv_sec: s,
                tv_nsec: if !set { libc::UTIME_OMIT } else if now { libc::UTIME_NOW } else { ns },
            };
            let times = [
                ts(valid.contains(SetattrValid::ATIME), valid.contains(SetattrValid::ATIME_NOW), attr.st_atime, attr.st_atime_nsec),
                ts(valid.contains(SetattrValid::MTIME), valid.contains(SetattrValid::MTIME_NOW), attr.st_mtime, attr.st_mtime_nsec),
            ];
            if unsafe { libc::utimensat(libc::AT_FDCWD, c.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) } < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

impl FileSystem for DriveFs {
    type Inode = u64;
    type Handle = u64;

    fn init(&self, capable: FsOptions) -> io::Result<FsOptions> {
        let want = FsOptions::ASYNC_READ
            | FsOptions::BIG_WRITES
            | FsOptions::ATOMIC_O_TRUNC
            | FsOptions::PARALLEL_DIROPS
            | FsOptions::MAX_PAGES;
        Ok(capable & want)
    }

    fn lookup(&self, _ctx: &Context, parent: u64, name: &CStr) -> io::Result<Entry> {
        self.fresh()?;
        let name = name_str(name)?;
        let mut st = lock(&self.st);
        let path = join(&Self::path_of(&st, parent)?, name);
        self.entry_for(&mut st, &path)
    }

    fn getattr(&self, _ctx: &Context, ino: u64, _h: Option<u64>) -> io::Result<(stat64, Duration)> {
        self.fresh()?;
        let mut st = lock(&self.st);
        let path = Self::path_of(&st, ino)?;
        let e = self.entry_for(&mut st, &path)?;
        Ok((e.attr, self.cfg.attr_timeout))
    }

    fn setattr(&self, _ctx: &Context, ino: u64, attr: stat64, fh: Option<u64>, valid: SetattrValid) -> io::Result<(stat64, Duration)> {
        self.fresh()?;
        let path = {
            let st = lock(&self.st);
            let path = Self::path_of(&st, ino)?;
            match self.resolve(&st, &path).ok_or_else(|| err(libc::ENOENT))? {
                Node::Upper(_) => {}
                Node::Lower(l) => {
                    if let Lower::File { writable: false, .. } = l {
                        return Err(err(libc::EACCES));
                    }
                    let content = !(valid.contains(SetattrValid::SIZE) && attr.st_size == 0);
                    self.copy_up(&path, &l, content)?;
                }
            }
            path
        };
        self.setattr_path(&path, &attr, fh, valid)?;
        let mut st = lock(&self.st);
        let e = self.entry_for(&mut st, &path)?;
        Ok((e.attr, self.cfg.attr_timeout))
    }

    fn readlink(&self, _ctx: &Context, ino: u64) -> io::Result<Vec<u8>> {
        self.fresh()?;
        let st = lock(&self.st);
        let path = Self::path_of(&st, ino)?;
        match self.resolve(&st, &path).ok_or_else(|| err(libc::ENOENT))? {
            Node::Upper(_) => Ok(fs::read_link(self.up(&path))?.as_os_str().as_bytes().to_vec()),
            Node::Lower(Lower::Symlink { target }) => Ok(target.into_bytes()),
            Node::Lower(_) => Err(err(libc::EINVAL)),
        }
    }

    fn symlink(&self, _ctx: &Context, linkname: &CStr, parent: u64, name: &CStr) -> io::Result<Entry> {
        self.fresh()?;
        let name = name_str(name)?;
        let mut st = lock(&self.st);
        let dir = Self::path_of(&st, parent)?;
        let path = join(&dir, name);
        if self.resolve(&st, &path).is_some() {
            return Err(err(libc::EEXIST));
        }
        self.ensure_upper_dir(&dir)?;
        std::os::unix::fs::symlink(std::ffi::OsStr::from_bytes(linkname.to_bytes()), self.up(&path))?;
        self.entry_for(&mut st, &path)
    }

    fn mknod(&self, ctx: &Context, parent: u64, name: &CStr, mode: u32, _rdev: u32, umask: u32) -> io::Result<Entry> {
        if mode & libc::S_IFMT != libc::S_IFREG {
            return Err(err(libc::EPERM));
        }
        let args = CreateIn { flags: libc::O_WRONLY as u32, mode, umask, fuse_flags: 0 };
        let (e, fh, _, _) = self.create(ctx, parent, name, args)?;
        if let Some(fh) = fh {
            lock(&self.st).handles.remove(&fh);
        }
        Ok(e)
    }

    fn mkdir(&self, _ctx: &Context, parent: u64, name: &CStr, mode: u32, umask: u32) -> io::Result<Entry> {
        self.fresh()?;
        let name = name_str(name)?;
        let mut st = lock(&self.st);
        let dir = Self::path_of(&st, parent)?;
        let path = join(&dir, name);
        if self.resolve(&st, &path).is_some() {
            return Err(err(libc::EEXIST));
        }
        self.ensure_upper_dir(&dir)?;
        fs::create_dir(self.up(&path))?;
        fs::set_permissions(self.up(&path), fs::Permissions::from_mode(mode & !umask & 0o7777))?;
        self.entry_for(&mut st, &path)
    }

    fn unlink(&self, _ctx: &Context, parent: u64, name: &CStr) -> io::Result<()> {
        self.fresh()?;
        let name = name_str(name)?;
        let mut st = lock(&self.st);
        let path = join(&Self::path_of(&st, parent)?, name);
        match self.resolve(&st, &path).ok_or_else(|| err(libc::ENOENT))? {
            Node::Upper(m) if m.is_dir() => return Err(err(libc::EISDIR)),
            Node::Lower(Lower::Dir) => return Err(err(libc::EISDIR)),
            Node::Upper(_) => fs::remove_file(self.up(&path))?,
            Node::Lower(_) => {}
        }
        if Self::lower(&st, &path).is_some() {
            Self::add_whiteout(&mut st, &path)?;
        }
        Self::detach(&mut st, &path);
        Ok(())
    }

    fn rmdir(&self, _ctx: &Context, parent: u64, name: &CStr) -> io::Result<()> {
        self.fresh()?;
        let name = name_str(name)?;
        let mut st = lock(&self.st);
        let path = join(&Self::path_of(&st, parent)?, name);
        let upper_dir = match self.resolve(&st, &path).ok_or_else(|| err(libc::ENOENT))? {
            Node::Upper(m) if m.is_dir() => true,
            Node::Lower(Lower::Dir) => false,
            _ => return Err(err(libc::ENOTDIR)),
        };
        if !self.is_empty_dir(&mut st, &path)? {
            return Err(err(libc::ENOTEMPTY));
        }
        if upper_dir {
            fs::remove_dir(self.up(&path))?;
        }
        if Self::lower(&st, &path).is_some() {
            Self::add_whiteout(&mut st, &path)?;
        }
        Self::detach(&mut st, &path);
        Ok(())
    }

    fn rename(&self, _ctx: &Context, olddir: u64, oldname: &CStr, newdir: u64, newname: &CStr, flags: u32) -> io::Result<()> {
        if flags & !(libc::RENAME_NOREPLACE) != 0 {
            return Err(err(libc::EINVAL));
        }
        self.fresh()?;
        let (oldname, newname) = (name_str(oldname)?, name_str(newname)?);
        let mut st = lock(&self.st);
        let old = join(&Self::path_of(&st, olddir)?, oldname);
        let newparent = Self::path_of(&st, newdir)?;
        let new = join(&newparent, newname);
        if old == new {
            return Ok(());
        }
        if Self::under(&new, &old) {
            return Err(err(libc::EINVAL));
        }
        let src = self.resolve(&st, &old).ok_or_else(|| err(libc::ENOENT))?;
        let src_dir = matches!(&src, Node::Upper(m) if m.is_dir()) || matches!(src, Node::Lower(Lower::Dir));
        let dst = self.resolve(&st, &new);
        let mut dst_lower_dir = false;
        if let Some(d) = &dst {
            if flags & libc::RENAME_NOREPLACE != 0 {
                return Err(err(libc::EEXIST));
            }
            let dst_dir = matches!(d, Node::Upper(m) if m.is_dir()) || matches!(d, Node::Lower(Lower::Dir));
            match (src_dir, dst_dir) {
                (false, true) => return Err(err(libc::EISDIR)),
                (true, false) => return Err(err(libc::ENOTDIR)),
                (true, true) => {
                    if !self.is_empty_dir(&mut st, &new)? {
                        return Err(err(libc::ENOTEMPTY));
                    }
                    dst_lower_dir = Self::lower(&st, &new).is_some();
                }
                _ => {}
            }
        }
        // Bring the source fully into upper/, then move it there.
        match &src {
            Node::Lower(Lower::Dir) => self.copy_up_tree(&st, &old)?,
            Node::Upper(m) if m.is_dir() => self.copy_up_tree(&st, &old)?,
            Node::Lower(l) => self.copy_up(&old, l, true)?,
            Node::Upper(_) => {}
        }
        self.ensure_upper_dir(&newparent)?;
        if dst_lower_dir {
            // The target is an empty merged directory with nothing of its own in upper/.
            let _ = fs::remove_dir(self.up(&new));
            Self::add_whiteout(&mut st, &new)?;
        }
        fs::rename(self.up(&old), self.up(&new))?;
        if Self::lower(&st, &old).is_some() {
            Self::add_whiteout(&mut st, &old)?;
        }
        Self::move_inodes(&mut st, &old, &new, src_dir);
        Ok(())
    }

    fn link(&self, _ctx: &Context, _ino: u64, _np: u64, _nn: &CStr) -> io::Result<Entry> {
        Err(err(libc::EPERM))
    }

    fn open(&self, _ctx: &Context, ino: u64, flags: u32, _fuse_flags: u32) -> io::Result<(Option<u64>, OpenOptions, Option<u32>)> {
        self.fresh()?;
        let mut st = lock(&self.st);
        let path = Self::path_of(&st, ino)?;
        let fh = self.open_path(&mut st, &path, flags)?;
        Ok((Some(fh), OpenOptions::empty(), None))
    }

    fn create(&self, _ctx: &Context, parent: u64, name: &CStr, args: CreateIn) -> io::Result<(Entry, Option<u64>, OpenOptions, Option<u32>)> {
        self.fresh()?;
        let name = name_str(name)?;
        let mut st = lock(&self.st);
        let dir = Self::path_of(&st, parent)?;
        let path = join(&dir, name);
        if self.resolve(&st, &path).is_some() {
            if args.flags as i32 & libc::O_EXCL != 0 {
                return Err(err(libc::EEXIST));
            }
            let fh = self.open_path(&mut st, &path, args.flags)?;
            let e = self.entry_for(&mut st, &path)?;
            return Ok((e, Some(fh), OpenOptions::empty(), None));
        }
        match self.resolve(&st, &dir) {
            Some(Node::Upper(m)) if m.is_dir() => {}
            Some(Node::Lower(Lower::Dir)) => self.ensure_upper_dir(&dir)?,
            _ => return Err(err(libc::ENOENT)),
        }
        let keep = libc::O_ACCMODE | libc::O_APPEND | libc::O_TRUNC;
        let file = open_upper(
            &self.up(&path),
            (args.flags as i32 & keep) | libc::O_CREAT | libc::O_EXCL,
            args.mode & !args.umask & 0o7777,
        )?;
        self.record_open(&path, None, args.flags);
        let fh = Self::new_handle(&mut st, Handle { file, path: path.clone(), lower_item: None });
        let e = self.entry_for(&mut st, &path)?;
        Ok((e, Some(fh), OpenOptions::empty(), None))
    }

    fn read(&self, _ctx: &Context, _ino: u64, fh: u64, w: &mut dyn ZeroCopyWriter, size: u32, offset: u64, _lo: Option<u64>, _flags: u32) -> io::Result<usize> {
        let h = self.handle(fh)?;
        if let Some(item) = &h.lower_item {
            // A blob handle stays valid only while the item is still in the session's view.
            self.fresh()?;
            let st = lock(&self.st);
            match st.view.entries.get(&h.path) {
                Some(Lower::File { item_id, .. }) if item_id == item => {}
                _ => return Err(err(libc::EACCES)),
            }
        }
        let mut f = ManuallyDrop::new(unsafe { File::from_raw_fd(h.file.as_raw_fd()) });
        w.write_from(&mut *f, size as usize, offset)
    }

    fn write(&self, _ctx: &Context, _ino: u64, fh: u64, r: &mut dyn ZeroCopyReader, size: u32, offset: u64, _lo: Option<u64>, _dw: bool, _flags: u32, _ff: u32) -> io::Result<usize> {
        let h = self.handle(fh)?;
        if h.lower_item.is_some() {
            return Err(err(libc::EBADF));
        }
        let mut f = ManuallyDrop::new(unsafe { File::from_raw_fd(h.file.as_raw_fd()) });
        r.read_to(&mut *f, size as usize, offset)
    }

    fn flush(&self, _ctx: &Context, _ino: u64, _fh: u64, _lo: u64) -> io::Result<()> {
        Ok(())
    }

    fn fsync(&self, _ctx: &Context, _ino: u64, datasync: bool, fh: u64) -> io::Result<()> {
        let h = self.handle(fh)?;
        if datasync { h.file.sync_data() } else { h.file.sync_all() }
    }

    fn fallocate(&self, _ctx: &Context, _ino: u64, fh: u64, mode: u32, offset: u64, length: u64) -> io::Result<()> {
        let h = self.handle(fh)?;
        if h.lower_item.is_some() {
            return Err(err(libc::EBADF));
        }
        if unsafe { libc::fallocate64(h.file.as_raw_fd(), mode as i32, offset as i64, length as i64) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn release(&self, _ctx: &Context, _ino: u64, _flags: u32, fh: u64, _f: bool, _fl: bool, _lo: Option<u64>) -> io::Result<()> {
        lock(&self.st).handles.remove(&fh);
        Ok(())
    }

    fn statfs(&self, _ctx: &Context, _ino: u64) -> io::Result<statvfs64> {
        let c = cpath(&self.upper)?;
        let mut s: statvfs64 = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs64(c.as_ptr(), &mut s) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(s)
    }

    fn getxattr(&self, _ctx: &Context, ino: u64, name: &CStr, size: u32) -> io::Result<GetxattrReply> {
        self.fresh()?;
        let st = lock(&self.st);
        let path = Self::path_of(&st, ino)?;
        if name.to_bytes() != XATTR_ITEM_ID {
            return Err(err(libc::ENODATA));
        }
        let value = match Self::lower(&st, &path) {
            Some(Lower::File { item_id, .. }) => item_id.into_bytes(),
            _ => return Err(err(libc::ENODATA)),
        };
        if size == 0 {
            Ok(GetxattrReply::Count(value.len() as u32))
        } else if (size as usize) < value.len() {
            Err(err(libc::ERANGE))
        } else {
            Ok(GetxattrReply::Value(value))
        }
    }

    fn listxattr(&self, _ctx: &Context, ino: u64, size: u32) -> io::Result<ListxattrReply> {
        self.fresh()?;
        let st = lock(&self.st);
        let path = Self::path_of(&st, ino)?;
        let mut names = Vec::new();
        if let Some(Lower::File { .. }) = Self::lower(&st, &path) {
            names.extend_from_slice(XATTR_ITEM_ID);
            names.push(0);
        }
        if size == 0 {
            Ok(ListxattrReply::Count(names.len() as u32))
        } else if (size as usize) < names.len() {
            Err(err(libc::ERANGE))
        } else {
            Ok(ListxattrReply::Names(names))
        }
    }

    fn setxattr(&self, _ctx: &Context, _ino: u64, _n: &CStr, _v: &[u8], _f: u32) -> io::Result<()> {
        Err(err(libc::ENOTSUP))
    }

    fn removexattr(&self, _ctx: &Context, _ino: u64, _n: &CStr) -> io::Result<()> {
        Err(err(libc::ENOTSUP))
    }

    fn opendir(&self, _ctx: &Context, ino: u64, _flags: u32) -> io::Result<(Option<u64>, OpenOptions)> {
        self.fresh()?;
        let mut st = lock(&self.st);
        let path = Self::path_of(&st, ino)?;
        let items = Arc::new(self.list(&mut st, &path)?);
        let fh = st.next_fh;
        st.next_fh += 1;
        st.dir_handles.insert(fh, (items, false));
        Ok((Some(fh), OpenOptions::empty()))
    }

    fn readdir(&self, _ctx: &Context, ino: u64, fh: u64, _size: u32, offset: u64, add_entry: &mut dyn FnMut(DirEntry) -> io::Result<usize>) -> io::Result<()> {
        let served = lock(&self.st).dir_handles.get(&fh).map(|(_, s)| *s).ok_or_else(|| err(libc::EBADF))?;
        if offset == 0 && served {
            // A listing from the start again (rewinddir) re-checks the epoch; opendir already did
            // for the first one.
            self.fresh()?;
            let mut st = lock(&self.st);
            let path = Self::path_of(&st, ino)?;
            let items = Arc::new(self.list(&mut st, &path)?);
            st.dir_handles.insert(fh, (items, false));
        }
        let items = {
            let mut st = lock(&self.st);
            let e = st.dir_handles.get_mut(&fh).ok_or_else(|| err(libc::EBADF))?;
            e.1 = true;
            e.0.clone()
        };
        for (i, it) in items.iter().enumerate().skip(offset as usize) {
            let n = add_entry(DirEntry { ino: it.ino, offset: i as u64 + 1, type_: it.type_, name: &it.name })?;
            if n == 0 {
                break;
            }
        }
        Ok(())
    }

    fn releasedir(&self, _ctx: &Context, _ino: u64, _flags: u32, fh: u64) -> io::Result<()> {
        lock(&self.st).dir_handles.remove(&fh);
        Ok(())
    }

    fn fsyncdir(&self, _ctx: &Context, _ino: u64, _datasync: bool, _fh: u64) -> io::Result<()> {
        Ok(())
    }

    fn access(&self, _ctx: &Context, ino: u64, _mask: u32) -> io::Result<()> {
        self.fresh()?;
        let st = lock(&self.st);
        let path = Self::path_of(&st, ino)?;
        self.resolve(&st, &path).map(|_| ()).ok_or_else(|| err(libc::ENOENT))
    }
}
