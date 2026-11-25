//! The session's `upper/` directory on the host, reached only through a directory fd.
//!
//! Everything in `upper/` was put there on the session's behalf, so none of it is trusted:
//! a symlink anywhere in it, as an intermediate directory or as the last name, must never be
//! followed on the host. Every path is resolved with `openat2(2)` from the fd of `upper/`
//! with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV`,
//! and every operation on a last name uses the `*at` call on the parent's fd with "no follow"
//! semantics (`unlinkat`, `renameat`, `symlinkat`, `fchownat(AT_SYMLINK_NOFOLLOW)`, ...).
//! Paths given here are relative to `upper/`, never empty except for `upper/` itself, and
//! never hold `.` or `..` components (the callers' path model rules them out); a `..` would be
//! refused by `RESOLVE_BENEATH` anyway.

use std::ffi::{CStr, CString, OsStr};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

const RESOLVE: u64 = libc::RESOLVE_BENEATH
    | libc::RESOLVE_NO_SYMLINKS
    | libc::RESOLVE_NO_MAGICLINKS
    | libc::RESOLVE_NO_XDEV;

fn err(code: i32) -> io::Error {
    io::Error::from_raw_os_error(code)
}

fn last() -> io::Error {
    io::Error::last_os_error()
}

fn cstr(s: &[u8]) -> io::Result<CString> {
    CString::new(s).map_err(|_| err(libc::EINVAL))
}

/// `path` relative to `upper/`; "." for `upper/` itself.
fn rel(path: &str) -> io::Result<CString> {
    if path.is_empty() { Ok(CString::from(c".")) } else { cstr(path.as_bytes()) }
}

fn split(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path),
    }
}

/// `openat2` with the safe resolve flags. A symlink as the last name is an error (ELOOP)
/// unless `flags` has both `O_PATH` and `O_NOFOLLOW`, which give an fd for the link itself.
pub fn openat2(dir: RawFd, path: &CStr, flags: i32, mode: u32) -> io::Result<OwnedFd> {
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (flags | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64;
    how.mode = if flags & (libc::O_CREAT | libc::O_TMPFILE) != 0 { mode as u64 } else { 0 };
    how.resolve = RESOLVE;
    for _ in 0..8 {
        let fd = unsafe {
            libc::syscall(libc::SYS_openat2, dir, path.as_ptr(), &how as *const libc::open_how, size_of::<libc::open_how>())
        };
        if fd >= 0 {
            return Ok(unsafe { OwnedFd::from_raw_fd(fd as RawFd) });
        }
        let e = last();
        // EAGAIN: a concurrent rename raced the resolution; it is safe to retry.
        if e.raw_os_error() != Some(libc::EAGAIN) {
            return Err(e);
        }
    }
    Err(err(libc::EAGAIN))
}

/// A host file's attributes, from `fstat`.
#[derive(Clone, Copy)]
pub struct Stat(pub libc::stat64);

impl Stat {
    pub fn of(fd: RawFd) -> io::Result<Stat> {
        let mut s: libc::stat64 = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat64(fd, &mut s) } < 0 {
            return Err(last());
        }
        Ok(Stat(s))
    }
    pub fn file_type(&self) -> u32 {
        self.0.st_mode & libc::S_IFMT
    }
    pub fn is_dir(&self) -> bool {
        self.file_type() == libc::S_IFDIR
    }
    pub fn is_symlink(&self) -> bool {
        self.file_type() == libc::S_IFLNK
    }
    pub fn is_file(&self) -> bool {
        self.file_type() == libc::S_IFREG
    }
}

/// One name in a directory of `upper/`.
pub struct Name {
    pub name: Vec<u8>,
    /// `DT_DIR`, `DT_LNK`, `DT_REG`, ...
    pub d_type: u8,
}

pub struct Upper {
    root: OwnedFd,
    path: PathBuf,
}

impl Upper {
    /// Opens `upper/` itself. `path` comes from the server's data directory and is trusted,
    /// except that its last name must not be a symlink.
    pub fn open(path: &Path) -> io::Result<Upper> {
        let c = cstr(path.as_os_str().as_bytes())?;
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(last());
        }
        Ok(Upper { root: unsafe { OwnedFd::from_raw_fd(fd) }, path: path.to_path_buf() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn fd(&self) -> RawFd {
        self.root.as_raw_fd()
    }

    /// Opens a path in `upper/` (never following a symlink anywhere in it).
    pub fn open_file(&self, path: &str, flags: i32, mode: u32) -> io::Result<File> {
        Ok(File::from(openat2(self.fd(), &rel(path)?, flags, mode)?))
    }

    /// The parent directory of `path` (an `O_PATH` fd) and the last name.
    fn parent<'a>(&self, path: &'a str) -> io::Result<(OwnedFd, CString)> {
        let (dir, name) = split(path);
        if name.is_empty() {
            return Err(err(libc::EINVAL));
        }
        let fd = openat2(self.fd(), &rel(dir)?, libc::O_PATH | libc::O_DIRECTORY, 0)?;
        Ok((fd, cstr(name.as_bytes())?))
    }

    /// `lstat`: the attributes of the path itself; a symlink is reported, not followed.
    pub fn stat(&self, path: &str) -> io::Result<Stat> {
        let fd = openat2(self.fd(), &rel(path)?, libc::O_PATH, 0)?;
        Stat::of(fd.as_raw_fd())
    }

    pub fn exists(&self, path: &str) -> bool {
        self.stat(path).is_ok()
    }

    pub fn mkdir(&self, path: &str, mode: u32) -> io::Result<()> {
        let (p, n) = self.parent(path)?;
        if unsafe { libc::mkdirat(p.as_raw_fd(), n.as_ptr(), mode) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    /// `mkdir -p` inside `upper/`: each component is created if missing and must then be a
    /// real directory (a symlink in the way is an error, never followed).
    pub fn mkdir_all(&self, dir: &str) -> io::Result<()> {
        if dir.is_empty() {
            return Ok(());
        }
        // Fast path: it is already there.
        if openat2(self.fd(), &rel(dir)?, libc::O_PATH | libc::O_DIRECTORY, 0).is_ok() {
            return Ok(());
        }
        let mut cur: Option<OwnedFd> = None;
        for comp in dir.split('/') {
            let at = cur.as_ref().map(|f| f.as_raw_fd()).unwrap_or(self.fd());
            let c = cstr(comp.as_bytes())?;
            if unsafe { libc::mkdirat(at, c.as_ptr(), 0o755) } < 0 {
                let e = last();
                if e.raw_os_error() != Some(libc::EEXIST) {
                    return Err(e);
                }
            }
            let next = openat2(at, &c, libc::O_PATH | libc::O_DIRECTORY, 0).map_err(|e| {
                // A symlink or a file where a directory should be.
                if e.raw_os_error() == Some(libc::ELOOP) { err(libc::ENOTDIR) } else { e }
            })?;
            cur = Some(next);
        }
        Ok(())
    }

    pub fn symlink(&self, target: &[u8], path: &str) -> io::Result<()> {
        let (p, n) = self.parent(path)?;
        let t = cstr(target)?;
        if unsafe { libc::symlinkat(t.as_ptr(), p.as_raw_fd(), n.as_ptr()) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    pub fn readlink(&self, path: &str) -> io::Result<Vec<u8>> {
        let (p, n) = self.parent(path)?;
        let mut buf = vec![0u8; libc::PATH_MAX as usize + 1];
        let r = unsafe { libc::readlinkat(p.as_raw_fd(), n.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
        if r < 0 {
            return Err(last());
        }
        buf.truncate(r as usize);
        Ok(buf)
    }

    pub fn unlink(&self, path: &str) -> io::Result<()> {
        let (p, n) = self.parent(path)?;
        if unsafe { libc::unlinkat(p.as_raw_fd(), n.as_ptr(), 0) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    pub fn rmdir(&self, path: &str) -> io::Result<()> {
        let (p, n) = self.parent(path)?;
        if unsafe { libc::unlinkat(p.as_raw_fd(), n.as_ptr(), libc::AT_REMOVEDIR) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    /// `rename(2)` within `upper/`. The last names are links themselves, never followed.
    pub fn rename(&self, old: &str, new: &str) -> io::Result<()> {
        let (op, on) = self.parent(old)?;
        let (np, nn) = self.parent(new)?;
        if unsafe { libc::renameat(op.as_raw_fd(), on.as_ptr(), np.as_raw_fd(), nn.as_ptr()) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    /// The names in a directory of `upper/`, without `.` and `..`.
    pub fn read_dir(&self, path: &str) -> io::Result<Vec<Name>> {
        let fd = openat2(self.fd(), &rel(path)?, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        let dir = unsafe { libc::fdopendir(fd.as_raw_fd()) };
        if dir.is_null() {
            return Err(last());
        }
        // The DIR now owns the fd.
        std::mem::forget(fd);
        let mut out = Vec::new();
        loop {
            let e = unsafe { libc::readdir64(dir) };
            if e.is_null() {
                break;
            }
            let name = unsafe { CStr::from_ptr((*e).d_name.as_ptr()) };
            let b = name.to_bytes();
            if b == b"." || b == b".." {
                continue;
            }
            let mut d_type = unsafe { (*e).d_type };
            if d_type == libc::DT_UNKNOWN {
                let mut s: libc::stat64 = unsafe { std::mem::zeroed() };
                if unsafe { libc::fstatat64(libc::dirfd(dir), name.as_ptr(), &mut s, libc::AT_SYMLINK_NOFOLLOW) } == 0 {
                    d_type = match s.st_mode & libc::S_IFMT {
                        libc::S_IFDIR => libc::DT_DIR,
                        libc::S_IFLNK => libc::DT_LNK,
                        libc::S_IFREG => libc::DT_REG,
                        _ => libc::DT_UNKNOWN,
                    };
                }
            }
            out.push(Name { name: b.to_vec(), d_type });
        }
        unsafe { libc::closedir(dir) };
        Ok(out)
    }

    /// `chmod` without following a symlink (a symlink's mode cannot be changed: EOPNOTSUPP).
    pub fn chmod(&self, path: &str, mode: u32) -> io::Result<()> {
        let (p, n) = self.parent(path)?;
        let r = unsafe { libc::syscall(libc::SYS_fchmodat2, p.as_raw_fd(), n.as_ptr(), mode, libc::AT_SYMLINK_NOFOLLOW) };
        if r == 0 {
            return Ok(());
        }
        let e = last();
        if e.raw_os_error() != Some(libc::ENOSYS) {
            return Err(e);
        }
        // Kernels before 6.6: open the file itself (ELOOP for a symlink) and fchmod it.
        let f = openat2(p.as_raw_fd(), &n, libc::O_RDONLY | libc::O_NONBLOCK, 0).map_err(|e| {
            if e.raw_os_error() == Some(libc::ELOOP) { err(libc::EOPNOTSUPP) } else { e }
        })?;
        if unsafe { libc::fchmod(f.as_raw_fd(), mode) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    pub fn chown(&self, path: &str, uid: u32, gid: u32) -> io::Result<()> {
        let (p, n) = self.parent(path)?;
        if unsafe { libc::fchownat(p.as_raw_fd(), n.as_ptr(), uid, gid, libc::AT_SYMLINK_NOFOLLOW) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    pub fn truncate(&self, path: &str, len: u64) -> io::Result<()> {
        self.open_file(path, libc::O_WRONLY | libc::O_NONBLOCK, 0)?.set_len(len)
    }

    pub fn utimens(&self, path: &str, times: &[libc::timespec; 2]) -> io::Result<()> {
        let (p, n) = self.parent(path)?;
        if unsafe { libc::utimensat(p.as_raw_fd(), n.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    /// `fsync` of a directory in `upper/`, so the names in it are durable.
    pub fn sync_dir(&self, path: &str) -> io::Result<()> {
        self.open_file(path, libc::O_RDONLY | libc::O_DIRECTORY, 0)?.sync_all()
    }

    /// `syncfs(2)` on the file system holding `upper/`.
    pub fn syncfs(&self) -> io::Result<()> {
        if unsafe { libc::syncfs(self.fd()) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    pub fn statvfs(&self) -> io::Result<libc::statvfs64> {
        let mut s: libc::statvfs64 = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatvfs64(self.fd(), &mut s) } < 0 {
            return Err(last());
        }
        Ok(s)
    }
}

/// Opens a file outside `upper/` that the server owns (a blob), refusing a symlink as the
/// last name.
pub fn open_trusted(path: &Path) -> io::Result<File> {
    let c = cstr(OsStr::as_bytes(path.as_os_str()))?;
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(last());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn never_follows_symlinks() {
        let t = tempfile::Builder::new().prefix("a8-upper-").tempdir().unwrap();
        let up = t.path().join("upper");
        let outside = t.path().join("outside");
        std::fs::create_dir_all(up.join("d")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret"), b"s").unwrap();
        symlink(&outside, up.join("link")).unwrap();
        symlink(outside.join("secret"), up.join("d/leaf")).unwrap();
        let u = Upper::open(&up).unwrap();
        let eloop = |r: io::Result<()>| r.unwrap_err().raw_os_error();
        // A symlink as an intermediate directory: ELOOP from the resolution, or ENOTDIR when
        // the parent is opened with O_DIRECTORY | O_NOFOLLOW.
        let refused = |r: io::Result<()>| matches!(r.unwrap_err().raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR));
        assert_eq!(u.stat("link/secret").err().and_then(|e| e.raw_os_error()), Some(libc::ELOOP));
        assert!(u.stat("link").unwrap().is_symlink());
        assert!(u.stat("d/leaf").unwrap().is_symlink());
        assert_eq!(u.open_file("d/leaf", libc::O_RDONLY, 0).err().and_then(|e| e.raw_os_error()), Some(libc::ELOOP));
        assert!(refused(u.mkdir("link/x", 0o755)));
        assert_eq!(eloop(u.mkdir_all("link/x/y")), Some(libc::ENOTDIR));
        assert!(refused(u.symlink(b"t", "link/s")));
        assert!(refused(u.unlink("link/secret")));
        assert!(refused(u.rename("link/secret", "moved")));
        assert_eq!(eloop(u.chmod("d/leaf", 0o600)), Some(libc::EOPNOTSUPP));
        assert_eq!(eloop(u.truncate("d/leaf", 0)), Some(libc::ELOOP));
        assert!(u.read_dir("link").is_err());
        assert!(u.open_file("../outside/secret", libc::O_RDONLY, 0).is_err());
        // A symlink as the last name of unlink and rename is the link itself.
        u.rename("d/leaf", "d/leaf2").unwrap();
        u.unlink("d/leaf2").unwrap();
        u.unlink("link").unwrap();
        assert_eq!(std::fs::read(outside.join("secret")).unwrap(), b"s");
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
    }
}
