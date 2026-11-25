//! The session's `/drive`: `session_view` ∪ `upper/` − `whiteouts` (docs/contracts.md §2).
//!
//! The file system is path based. Inode numbers are handed out per path on first lookup and
//! follow renames; each inode counts the lookups the kernel was given and is dropped when the
//! kernel forgets them, so the table holds only what the kernel holds (plus a bounded number
//! handed out by listings). Every lookup, getattr, open and listing first checks the session's epoch and
//! reloads the view when it changed, so a trashed or ringed item is gone on the next operation.
//! The kernel is told not to cache entries or attributes (timeouts default to zero) for the
//! same reason.
//!
//! One implementation of `fuse_backend_rs::api::filesystem::FileSystem` serves both `/dev/fuse`
//! (gVisor) and virtio-fs (microVMs); see `tests/virtio.rs`.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::ffi::{CStr, CString};
use std::fs::{self, File, OpenOptions as StdOpen};
use std::io::{self, Write};
use std::mem::ManuallyDrop;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::time::Duration;

use fuse_backend_rs::abi::fuse_abi::{CreateIn, stat64, statvfs64};
use fuse_backend_rs::api::filesystem::{
    Context, DirEntry, Entry, FileSystem, FsOptions, GetxattrReply, ListxattrReply, OpenOptions,
    SetattrValid, ZeroCopyReader, ZeroCopyWriter,
};
use rusqlite::Connection;

use crate::store::{self, ActivityLog, OpenRecord};
use crate::upper::{Stat, Upper, open_trusted};
use crate::view::{ChildKind, DEFAULT_DIR_MODE, Lower, View, join, parent_of};

pub const ROOT_INO: u64 = 1;
/// The temporary name used for copy-up in each directory of `upper/`; never listed.
const COPYUP: &str = ".a2-copyup";
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
    /// Measurement only: never check the epoch (breaks the freshness contract).
    pub skip_epoch_check: bool,
    /// Measurement only: always run the epoch query instead of probing for writes first.
    pub no_change_probe: bool,
}

impl Config {
    pub fn new(data: impl Into<PathBuf>, dir_id: &str) -> Config {
        Config {
            data: data.into(),
            dir_id: dir_id.to_string(),
            entry_timeout: Duration::ZERO,
            attr_timeout: Duration::ZERO,
            skip_epoch_check: false,
            no_change_probe: false,
        }
    }
}

/// A kernel cache entry made stale by a view change.
#[derive(Debug)]
pub enum Inval {
    Entry { parent: u64, name: CString },
    Inode { ino: u64 },
}

/// What a path currently is in the merged view.
enum Node {
    Upper(Stat),
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

/// One inode the kernel may hold.
struct Inode {
    /// `None` once the path is gone (unlinked, or replaced by a rename) while the kernel still
    /// holds the inode.
    path: Option<String>,
    /// The kernel's lookup count: replies that handed this inode out (lookup, create, mkdir,
    /// symlink, mknod) minus what `forget` returned. At zero the inode is dropped.
    refs: u64,
}

/// How many inodes handed out only in listings (never looked up, so the kernel holds no
/// count and will never forget them) are kept, so that a later lookup of the same name gets
/// the inode number the listing showed. Older ones are dropped.
const LISTED_ONLY_CAP: usize = 16384;

/// Sizes of the daemon's tables, for tests and the soak.
#[derive(Debug, Clone, Copy, Default)]
pub struct Stats {
    pub inodes: usize,
    pub paths: usize,
    pub handles: usize,
    pub dir_handles: usize,
    pub whiteouts: usize,
    pub listed_only: usize,
}

struct State {
    view: Arc<View>,
    whiteouts: HashSet<String>,
    whiteout_file: File,
    inodes: HashMap<u64, Inode>,
    by_path: HashMap<String, u64>,
    /// Inodes created by listings with no lookup count yet, oldest first.
    listed_only: VecDeque<u64>,
    next_ino: u64,
    handles: HashMap<u64, Arc<Handle>>,
    /// Directory handle to (listing, whether a readdir has served it yet).
    dir_handles: HashMap<u64, (Arc<Vec<DirItem>>, bool)>,
    next_fh: u64,
}

pub struct DriveFs {
    cfg: Config,
    upper: Upper,
    db: Mutex<(Connection, store::ChangeProbe)>,
    st: Mutex<State>,
    activity: ActivityLog,
    inval_sink: Mutex<Option<mpsc::Sender<Vec<Inval>>>>,
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

fn name_str(name: &CStr) -> io::Result<&str> {
    let s = name.to_str().map_err(|_| err(libc::EINVAL))?;
    if s.is_empty() || s == "." || s == ".." || s.contains('/') {
        return Err(err(libc::EINVAL));
    }
    Ok(s)
}

/// Reads the whiteouts file and opens it for appending. A torn last line (a crash during an
/// append, before that delete was acknowledged) is dropped from the file.
fn open_whiteouts(path: &Path) -> io::Result<(HashSet<String>, File)> {
    let f = StdOpen::new().read(true).append(true).create(true).custom_flags(libc::O_NOFOLLOW).open(path)?;
    let mut s = String::new();
    io::Read::read_to_string(&mut &f, &mut s)?;
    if !s.is_empty() && !s.ends_with('\n') {
        let keep = s.rfind('\n').map(|i| i + 1).unwrap_or(0);
        log::warn!("whiteouts: dropping a torn last line {:?}", &s[keep..]);
        f.set_len(keep as u64)?;
        f.sync_data()?;
        s.truncate(keep);
    }
    Ok((s.lines().filter(|l| !l.is_empty()).map(str::to_string).collect(), f))
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
        fs::create_dir_all(sess.join("upper"))?;
        let upper = Upper::open(&sess.join("upper"))?;
        let (whiteouts, whiteout_file) = open_whiteouts(&sess.join("whiteouts"))?;
        let mut db = store::open(&cfg.data)?;
        let (ep, rows) = store::load_view(&mut db, &cfg.dir_id)?;
        let view = Arc::new(View::build(ep, rows));
        let mut inodes = HashMap::new();
        inodes.insert(ROOT_INO, Inode { path: Some(String::new()), refs: 1 });
        let mut by_path = HashMap::new();
        by_path.insert(String::new(), ROOT_INO);
        let activity = ActivityLog::start(&cfg.data, &cfg.dir_id)?;
        Ok(DriveFs {
            upper,
            db: Mutex::new((db, store::ChangeProbe::new(&cfg.data))),
            st: Mutex::new(State {
                view,
                whiteouts,
                whiteout_file,
                inodes,
                by_path,
                listed_only: VecDeque::new(),
                next_ino: ROOT_INO + 1,
                handles: HashMap::new(),
                dir_handles: HashMap::new(),
                next_fh: 1,
            }),
            activity,
            inval_sink: Mutex::new(None),
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
            mount_time: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            cfg,
        })
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    pub fn upper_dir(&self) -> &Path {
        self.upper.path()
    }

    pub fn stats(&self) -> Stats {
        let st = lock(&self.st);
        Stats {
            inodes: st.inodes.len(),
            paths: st.by_path.len(),
            handles: st.handles.len(),
            dir_handles: st.dir_handles.len(),
            whiteouts: st.whiteouts.len(),
            listed_only: st.listed_only.len(),
        }
    }

    /// Waits until every open recorded so far is in `activity`.
    pub fn flush_activity(&self) {
        self.activity.flush();
    }

    // ---- freshness -------------------------------------------------------------------------

    /// Where kernel invalidations found inside a request handler are sent; the handler must not
    /// send them itself (the kernel may hold a directory lock while it waits for the handler).
    pub fn set_inval_sink(&self, tx: mpsc::Sender<Vec<Inval>>) {
        *lock(&self.inval_sink) = Some(tx);
    }

    /// Checks the epoch and reloads the view if it changed. Returns the kernel cache entries
    /// that the change makes stale (only those the kernel can have: paths it has an inode for).
    /// Lock order: db, then state.
    pub fn refresh(&self) -> io::Result<(i64, Vec<Inval>)> {
        let mut guard = lock(&self.db);
        let (db, probe) = &mut *guard;
        if !self.cfg.no_change_probe && !probe.changed() {
            return Ok((lock(&self.st).view.epoch, Vec::new()));
        }
        let ep = store::epoch(db, &self.cfg.dir_id).map_err(dberr)?;
        let old = lock(&self.st).view.clone();
        if ep == old.epoch {
            return Ok((ep, Vec::new()));
        }
        let (ep, rows) = store::load_view(db, &self.cfg.dir_id).map_err(dberr)?;
        let view = Arc::new(View::build(ep, rows));
        log::debug!("view reloaded at epoch {ep}: {} entries", view.entries.len());
        let mut st = lock(&self.st);
        st.view = view.clone();
        drop(guard);
        let mut out = Vec::new();
        for p in old.changed_paths(&view) {
            if let Some(&parent) = st.by_path.get(parent_of(&p)) {
                let name = p.rsplit('/').next().unwrap_or(&p);
                if let Ok(c) = CString::new(name) {
                    out.push(Inval::Entry { parent, name: c });
                }
            }
            if let Some(&ino) = st.by_path.get(&p) {
                out.push(Inval::Inode { ino });
            }
        }
        Ok((ep, out))
    }

    /// The per-operation epoch check, called before every lookup, getattr, open, read of an
    /// item's blob, and listing.
    fn fresh(&self) -> io::Result<()> {
        if self.cfg.skip_epoch_check {
            return Ok(());
        }
        let (_, invals) = self.refresh()?;
        if !invals.is_empty() {
            if let Some(tx) = lock(&self.inval_sink).as_ref() {
                let _ = tx.send(invals);
            }
        }
        Ok(())
    }

    // ---- path model ------------------------------------------------------------------------

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

    /// What `path` is in the merged view. Something in `upper/` that is not a directory
    /// shadows everything below its path: ENOTDIR (a file) and ELOOP (a symlink, never
    /// followed on the host) mean the path does not exist.
    fn resolve(&self, st: &State, path: &str) -> Option<Node> {
        match self.upper.stat(path) {
            Ok(m) => Some(Node::Upper(m)),
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) => Self::lower(st, path).map(Node::Lower),
            Err(_) => None,
        }
    }

    fn path_of(st: &State, ino: u64) -> io::Result<String> {
        match st.inodes.get(&ino) {
            Some(Inode { path: Some(p), .. }) => Ok(p.clone()),
            _ => Err(err(libc::ENOENT)),
        }
    }

    /// The inode number for `path`, allocated (with no lookup count) if it has none.
    fn ino_for(st: &mut State, path: &str) -> u64 {
        if let Some(i) = st.by_path.get(path) {
            return *i;
        }
        let i = st.next_ino;
        st.next_ino += 1;
        st.inodes.insert(i, Inode { path: Some(path.to_string()), refs: 0 });
        st.by_path.insert(path.to_string(), i);
        i
    }

    /// The inode for `path`, counted as handed out to the kernel.
    fn ino_counted(st: &mut State, path: &str) -> u64 {
        let i = Self::ino_for(st, path);
        if let Some(n) = st.inodes.get_mut(&i) {
            n.refs += 1;
        }
        i
    }

    /// An inode for a listing: the kernel holds no count for it, so it is kept only while it
    /// is among the last LISTED_ONLY_CAP of its kind.
    fn ino_listed(st: &mut State, path: &str) -> u64 {
        if let Some(i) = st.by_path.get(path) {
            return *i;
        }
        let i = Self::ino_for(st, path);
        st.listed_only.push_back(i);
        while st.listed_only.len() > LISTED_ONLY_CAP {
            let old = st.listed_only.pop_front().unwrap();
            if st.inodes.get(&old).is_some_and(|n| n.refs == 0) {
                Self::drop_inode(st, old);
            }
        }
        i
    }

    fn drop_inode(st: &mut State, ino: u64) {
        if ino == ROOT_INO {
            return;
        }
        if let Some(Inode { path: Some(p), .. }) = st.inodes.remove(&ino) {
            if st.by_path.get(&p) == Some(&ino) {
                st.by_path.remove(&p);
            }
        }
    }

    fn forget_one(st: &mut State, ino: u64, count: u64) {
        if ino == ROOT_INO {
            return;
        }
        let Some(n) = st.inodes.get_mut(&ino) else { return };
        n.refs = n.refs.saturating_sub(count);
        if n.refs == 0 {
            Self::drop_inode(st, ino);
        }
    }

    /// The path of `ino` is gone; the inode lives on (path-less) until the kernel forgets it.
    fn unpath(st: &mut State, ino: u64) {
        match st.inodes.get_mut(&ino) {
            Some(n) if n.refs == 0 => {
                st.inodes.remove(&ino);
            }
            Some(n) => n.path = None,
            None => {}
        }
    }

    fn under(p: &str, dir: &str) -> bool {
        p.len() > dir.len() && p.starts_with(dir) && p.as_bytes()[dir.len()] == b'/'
    }

    /// Forgets the inode of `path` and of everything under it.
    fn detach(st: &mut State, path: &str) {
        if let Some(i) = st.by_path.remove(path) {
            Self::unpath(st, i);
        }
        let below: Vec<String> =
            st.by_path.keys().filter(|p| Self::under(p, path)).cloned().collect();
        for p in below {
            if let Some(i) = st.by_path.remove(&p) {
                Self::unpath(st, i);
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
            if let Some(n) = st.inodes.get_mut(&i) {
                n.path = Some(p.clone());
            }
            st.by_path.insert(p, i);
        }
    }

    /// Appends whiteouts and makes them durable before the delete or rename is acknowledged.
    /// Callers first make the `upper/` side of the change durable (see `durable_*`), so that
    /// after a crash a whiteout never stands without it.
    fn add_whiteouts(st: &mut State, paths: &[&str]) -> io::Result<()> {
        let mut buf = String::new();
        for p in paths {
            if !st.whiteouts.contains(*p) {
                buf.push_str(p);
                buf.push('\n');
            }
        }
        if buf.is_empty() {
            return Ok(());
        }
        // One write(2) with O_APPEND: a crash leaves whole lines or a torn last line, which
        // `open_whiteouts` drops.
        st.whiteout_file.write_all(buf.as_bytes())?;
        st.whiteout_file.sync_data()?;
        for p in paths {
            st.whiteouts.insert(p.to_string());
        }
        Ok(())
    }

    // ---- attributes ------------------------------------------------------------------------

    fn attr_upper(&self, ino: u64, m: &Stat) -> stat64 {
        let m = &m.0;
        let mut s: stat64 = unsafe { std::mem::zeroed() };
        s.st_ino = ino;
        s.st_mode = m.st_mode;
        s.st_nlink = m.st_nlink as _;
        s.st_uid = m.st_uid;
        s.st_gid = m.st_gid;
        s.st_size = m.st_size;
        s.st_blksize = m.st_blksize;
        s.st_blocks = m.st_blocks;
        s.st_atime = m.st_atime;
        s.st_atime_nsec = m.st_atime_nsec;
        s.st_mtime = m.st_mtime;
        s.st_mtime_nsec = m.st_mtime_nsec;
        s.st_ctime = m.st_ctime;
        s.st_ctime_nsec = m.st_ctime_nsec;
        s
    }

    fn attr_lower(&self, ino: u64, l: &Lower) -> stat64 {
        let mut s: stat64 = unsafe { std::mem::zeroed() };
        s.st_ino = ino;
        s.st_uid = self.uid;
        s.st_gid = self.gid;
        s.st_blksize = 4096;
        let (mode, nlink, size, t) = match l {
            Lower::File { size, mtime, mode, .. } => (libc::S_IFREG | *mode, 1, *size, *mtime),
            Lower::Symlink { target } => (libc::S_IFLNK | 0o777, 1, target.len() as u64, self.mount_time),
            Lower::Dir { mode } => (libc::S_IFDIR | *mode, 2, 4096, self.mount_time),
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

    /// The entry for `path`. `counted`: the reply hands the inode to the kernel (lookup,
    /// create, mkdir, symlink), which raises its lookup count; getattr and setattr do not.
    fn entry_for(&self, st: &mut State, path: &str, counted: bool) -> io::Result<Entry> {
        let n = self.resolve(st, path).ok_or_else(|| err(libc::ENOENT))?;
        let ino = if counted { Self::ino_counted(st, path) } else { Self::ino_for(st, path) };
        Ok(self.entry(ino, self.attr_of(ino, &n)))
    }

    // ---- copy-up ---------------------------------------------------------------------------

    /// Makes `dir` exist in `upper/`; directories created on the way get the store's mode.
    fn ensure_upper_dir(&self, st: &State, dir: &str) -> io::Result<()> {
        self.upper.mkdir_all(dir, &|p| match Self::lower(st, p) {
            Some(Lower::Dir { mode }) => mode,
            _ => DEFAULT_DIR_MODE,
        })
    }

    /// Makes `path` exist in `upper/`, copying the item's content unless `content` is false.
    fn copy_up(&self, st: &State, path: &str, l: &Lower, content: bool) -> io::Result<()> {
        let dir = parent_of(path);
        self.ensure_upper_dir(st, dir)?;
        match l {
            Lower::File { blob, mtime, mode, .. } => {
                // Callers hold the state lock, so one temporary name per directory is enough.
                // Whatever is at that name (even a symlink) is replaced, never followed.
                let tmp = join(dir, COPYUP);
                let _ = self.upper.unlink(&tmp);
                let mut f = self.upper.open_file(&tmp, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o600)?;
                if content {
                    io::copy(&mut open_trusted(&store::blob_path(&self.cfg.data, blob))?, &mut f)?;
                }
                f.set_permissions(fs::Permissions::from_mode(*mode))?;
                if content {
                    let t = std::time::UNIX_EPOCH + Duration::from_secs((*mtime).max(0) as u64);
                    let _ = f.set_modified(t);
                }
                drop(f);
                self.upper.rename(&tmp, path)?;
            }
            Lower::Symlink { target } => self.upper.symlink(target.as_bytes(), path)?,
            Lower::Dir { .. } => self.ensure_upper_dir(st, path)?,
        }
        Ok(())
    }

    /// Copies a whole lower directory into `upper/`, for a directory rename.
    fn copy_up_tree(&self, st: &State, dir: &str) -> io::Result<()> {
        self.ensure_upper_dir(st, dir)?;
        let view = st.view.clone();
        let mut subdirs: Vec<&String> =
            view.dirs.keys().filter(|d| Self::under(d, dir)).collect();
        subdirs.sort();
        for d in subdirs {
            if Self::lower(st, d).is_some() {
                self.ensure_upper_dir(st, d)?;
            }
        }
        for (p, l) in view.descendants(dir) {
            if Self::lower(st, p).is_none() || self.upper.exists(p) {
                continue;
            }
            self.copy_up(st, p, l, true)?;
        }
        Ok(())
    }

    // ---- listings --------------------------------------------------------------------------

    fn list(&self, st: &mut State, dir: &str) -> io::Result<Vec<DirItem>> {
        let mut names: BTreeMap<String, ChildKind> = BTreeMap::new();
        let in_upper = match self.resolve(st, dir) {
            Some(Node::Upper(m)) if m.is_dir() => true,
            Some(Node::Lower(Lower::Dir { .. })) => false,
            Some(_) => return Err(err(libc::ENOTDIR)),
            None => return Err(err(libc::ENOENT)),
        };
        if let Some(Lower::Dir { .. }) = Self::lower(st, dir) {
            let view = st.view.clone();
            if let Some(children) = view.dirs.get(dir) {
                for (name, kind) in children {
                    if !st.whiteouts.contains(&join(dir, name)) {
                        names.insert(name.clone(), *kind);
                    }
                }
            }
        }
        if in_upper {
            for e in self.upper.read_dir(dir)? {
                let Ok(name) = String::from_utf8(e.name) else { continue };
                if name == COPYUP {
                    continue;
                }
                let kind = match e.d_type {
                    libc::DT_DIR => ChildKind::Dir,
                    libc::DT_LNK => ChildKind::Symlink,
                    _ => ChildKind::File,
                };
                names.insert(name, kind);
            }
        }
        let self_ino = Self::ino_listed(st, dir);
        let parent_ino = Self::ino_listed(st, parent_of(dir));
        let mut out = vec![
            DirItem { name: b".".to_vec(), ino: self_ino, type_: libc::DT_DIR as u32 },
            DirItem { name: b"..".to_vec(), ino: parent_ino, type_: libc::DT_DIR as u32 },
        ];
        for (name, kind) in names {
            let ino = Self::ino_listed(st, &join(dir, &name));
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
                let file = self.upper.open_file(path, flags as i32 & keep, 0)?;
                Handle { file, path: path.to_string(), lower_item: None }
            }
            Node::Lower(Lower::Dir { .. }) => return Err(err(libc::EISDIR)),
            Node::Lower(Lower::Symlink { .. }) => return Err(err(libc::ELOOP)),
            Node::Lower(ref l @ Lower::File { ref blob, writable, .. }) => {
                if wants_write(flags) {
                    if !writable {
                        return Err(err(libc::EACCES));
                    }
                    let trunc = flags as i32 & libc::O_TRUNC != 0;
                    self.copy_up(st, path, l, !trunc)?;
                    let file = self.upper.open_file(path, flags as i32 & keep, 0)?;
                    Handle { file, path: path.to_string(), lower_item: None }
                } else {
                    let file = open_trusted(&store::blob_path(&self.cfg.data, blob))?;
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
        if valid.contains(SetattrValid::MODE) {
            self.upper.chmod(path, attr.st_mode & 0o7777)?;
        }
        if valid.intersects(SetattrValid::UID | SetattrValid::GID) {
            let uid = if valid.contains(SetattrValid::UID) { attr.st_uid } else { u32::MAX };
            let gid = if valid.contains(SetattrValid::GID) { attr.st_gid } else { u32::MAX };
            self.upper.chown(path, uid, gid)?;
        }
        if valid.contains(SetattrValid::SIZE) {
            let h = fh.and_then(|f| lock(&self.st).handles.get(&f).cloned());
            match h {
                Some(h) if h.lower_item.is_none() => h.file.set_len(attr.st_size as u64)?,
                _ => self.upper.truncate(path, attr.st_size as u64)?,
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
            self.upper.utimens(path, &times)?;
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
            | FsOptions::MAX_PAGES
            // The kernel otherwise asks for security.capability before every write.
            | FsOptions::HANDLE_KILLPRIV_V2;
        Ok(capable & want)
    }

    fn lookup(&self, _ctx: &Context, parent: u64, name: &CStr) -> io::Result<Entry> {
        self.fresh()?;
        let name = name_str(name)?;
        let mut st = lock(&self.st);
        let path = join(&Self::path_of(&st, parent)?, name);
        match self.entry_for(&mut st, &path, true) {
            // With kernel caching on, let the kernel cache the miss too; view changes
            // invalidate added paths as well as removed ones.
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) && !self.cfg.entry_timeout.is_zero() => {
                Ok(Entry { inode: 0, generation: 0, attr: unsafe { std::mem::zeroed() }, attr_flags: 0,
                           attr_timeout: self.cfg.attr_timeout, entry_timeout: self.cfg.entry_timeout })
            }
            r => r,
        }
    }

    fn forget(&self, _ctx: &Context, ino: u64, count: u64) {
        Self::forget_one(&mut lock(&self.st), ino, count);
    }

    fn batch_forget(&self, _ctx: &Context, requests: Vec<(u64, u64)>) {
        let mut st = lock(&self.st);
        for (ino, count) in requests {
            Self::forget_one(&mut st, ino, count);
        }
    }

    fn getattr(&self, _ctx: &Context, ino: u64, _h: Option<u64>) -> io::Result<(stat64, Duration)> {
        self.fresh()?;
        let mut st = lock(&self.st);
        let path = Self::path_of(&st, ino)?;
        let e = self.entry_for(&mut st, &path, false)?;
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
                    self.copy_up(&st, &path, &l, content)?;
                }
            }
            path
        };
        self.setattr_path(&path, &attr, fh, valid)?;
        let mut st = lock(&self.st);
        let e = self.entry_for(&mut st, &path, false)?;
        Ok((e.attr, self.cfg.attr_timeout))
    }

    fn readlink(&self, _ctx: &Context, ino: u64) -> io::Result<Vec<u8>> {
        self.fresh()?;
        let st = lock(&self.st);
        let path = Self::path_of(&st, ino)?;
        match self.resolve(&st, &path).ok_or_else(|| err(libc::ENOENT))? {
            Node::Upper(_) => self.upper.readlink(&path),
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
        self.ensure_upper_dir(&st, &dir)?;
        self.upper.symlink(linkname.to_bytes(), &path)?;
        self.entry_for(&mut st, &path, true)
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
        self.ensure_upper_dir(&st, &dir)?;
        self.upper.mkdir(&path, 0o700)?;
        self.upper.chmod(&path, mode & !umask & 0o7777)?;
        self.entry_for(&mut st, &path, true)
    }

    fn unlink(&self, _ctx: &Context, parent: u64, name: &CStr) -> io::Result<()> {
        self.fresh()?;
        let name = name_str(name)?;
        let mut st = lock(&self.st);
        let path = join(&Self::path_of(&st, parent)?, name);
        let had_upper = match self.resolve(&st, &path).ok_or_else(|| err(libc::ENOENT))? {
            Node::Upper(m) if m.is_dir() => return Err(err(libc::EISDIR)),
            Node::Lower(Lower::Dir { .. }) => return Err(err(libc::EISDIR)),
            Node::Upper(_) => {
                self.upper.unlink(&path)?;
                true
            }
            Node::Lower(_) => false,
        };
        if Self::lower(&st, &path).is_some() {
            if had_upper {
                // Else a crash could bring the session's copy back as a replacement.
                self.upper.sync_dir(parent_of(&path))?;
            }
            Self::add_whiteouts(&mut st, &[&path])?;
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
            Node::Lower(Lower::Dir { .. }) => false,
            _ => return Err(err(libc::ENOTDIR)),
        };
        if !self.is_empty_dir(&mut st, &path)? {
            return Err(err(libc::ENOTEMPTY));
        }
        if upper_dir {
            self.upper.rmdir(&path)?;
        }
        if Self::lower(&st, &path).is_some() {
            if upper_dir {
                self.upper.sync_dir(parent_of(&path))?;
            }
            Self::add_whiteouts(&mut st, &[&path])?;
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
        let src_dir = matches!(&src, Node::Upper(m) if m.is_dir()) || matches!(src, Node::Lower(Lower::Dir { .. }));
        let dst = self.resolve(&st, &new);
        let mut dst_lower_dir = false;
        if let Some(d) = &dst {
            if flags & libc::RENAME_NOREPLACE != 0 {
                return Err(err(libc::EEXIST));
            }
            let dst_dir = matches!(d, Node::Upper(m) if m.is_dir()) || matches!(d, Node::Lower(Lower::Dir { .. }));
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
            Node::Lower(Lower::Dir { .. }) => self.copy_up_tree(&st, &old)?,
            Node::Upper(m) if m.is_dir() => self.copy_up_tree(&st, &old)?,
            Node::Lower(l) => self.copy_up(&st, &old, l, true)?,
            Node::Upper(_) => {}
        }
        self.ensure_upper_dir(&st, &newparent)?;
        if dst_lower_dir {
            // The target is an empty merged directory with nothing of its own in upper/.
            let _ = self.upper.rmdir(&new);
        }
        self.upper.rename(&old, &new)?;
        let mut wo: Vec<&str> = Vec::new();
        if dst_lower_dir {
            wo.push(new.as_str());
        }
        if Self::lower(&st, &old).is_some() {
            wo.push(old.as_str());
        }
        if !wo.is_empty() {
            // The whiteout hides the store's copy at the old path, so the moved copy in upper/
            // must be on disk first: its content, its new name, and the old name's removal.
            if src_dir {
                self.upper.syncfs()?;
            } else {
                match self.upper.open_file(&new, libc::O_RDONLY | libc::O_NONBLOCK, 0) {
                    Ok(f) => f.sync_all()?,
                    // A symlink: its name is synced with the directory.
                    Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {}
                    Err(e) => return Err(e),
                }
                self.upper.sync_dir(&newparent)?;
                if parent_of(&old) != newparent {
                    self.upper.sync_dir(parent_of(&old))?;
                }
            }
            Self::add_whiteouts(&mut st, &wo)?;
        }
        Self::move_inodes(&mut st, &old, &new, src_dir);
        Ok(())
    }

    /// Hard links are not supported: always EPERM, before anything is touched. EPERM is what
    /// link(2) returns on a file system that has no hard links (it is what the kernel returns
    /// itself when a file system has no `link` operation), and tools that use links fall back
    /// on it: Git renames its object files instead, `cp -l` and `ln` report the error.
    /// Supporting them would mean two inodes sharing content in a path-based file system, with
    /// the kernel's cached size and times of one going stale when the other is written, and
    /// nothing in the store to keep the link in.
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
            let e = self.entry_for(&mut st, &path, true)?;
            return Ok((e, Some(fh), OpenOptions::empty(), None));
        }
        match self.resolve(&st, &dir) {
            Some(Node::Upper(m)) if m.is_dir() => {}
            Some(Node::Lower(Lower::Dir { .. })) => self.ensure_upper_dir(&st, &dir)?,
            _ => return Err(err(libc::ENOENT)),
        }
        let keep = libc::O_ACCMODE | libc::O_APPEND | libc::O_TRUNC;
        let file = self.upper.open_file(
            &path,
            (args.flags as i32 & keep) | libc::O_CREAT | libc::O_EXCL,
            args.mode & !args.umask & 0o7777,
        )?;
        self.record_open(&path, None, args.flags);
        let fh = Self::new_handle(&mut st, Handle { file, path: path.clone(), lower_item: None });
        let e = self.entry_for(&mut st, &path, true)?;
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
        // Nothing to do on close. ENOSYS makes the kernel stop sending FLUSH altogether,
        // which saves one round trip per close.
        Err(err(libc::ENOSYS))
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
        self.upper.statvfs()
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

    fn fsyncdir(&self, _ctx: &Context, ino: u64, _datasync: bool, _fh: u64) -> io::Result<()> {
        let st = lock(&self.st);
        let path = Self::path_of(&st, ino)?;
        match self.upper.sync_dir(&path) {
            // A directory only in the store has nothing of its own to sync.
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) => Ok(()),
            r => r,
        }
    }

    fn access(&self, _ctx: &Context, ino: u64, _mask: u32) -> io::Result<()> {
        self.fresh()?;
        let st = lock(&self.st);
        let path = Self::path_of(&st, ino)?;
        self.resolve(&st, &path).map(|_| ()).ok_or_else(|| err(libc::ENOENT))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn torn_whiteout_line_is_dropped() {
        let t = tempfile::Builder::new().prefix("a8-wo-").tempdir().unwrap();
        let p = t.path().join("whiteouts");
        fs::write(&p, b"notes/a\nnotes/b\nnotes/to").unwrap();
        let (set, mut f) = open_whiteouts(&p).unwrap();
        assert_eq!(set, HashSet::from(["notes/a".to_string(), "notes/b".to_string()]));
        assert_eq!(fs::read(&p).unwrap(), b"notes/a\nnotes/b\n");
        f.write_all(b"notes/c\n").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"notes/a\nnotes/b\nnotes/c\n");
        // No newline at all: nothing survives.
        fs::write(&p, b"half").unwrap();
        assert!(open_whiteouts(&p).unwrap().0.is_empty());
        assert_eq!(fs::read(&p).unwrap(), b"");
    }
}
