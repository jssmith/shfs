//! Correctness at the host mount: every operation in docs/contracts.md §2, through the kernel's
//! FUSE driver. Needs root and /dev/fuse.

use std::collections::BTreeSet;
use std::ffi::CString;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use agent_drive_fs::daemon::{self, Mount, Options};
use agent_drive_fs::drivefs::{Config, DriveFs};
use agent_drive_fs::store;
use agent_drive_fs::stub::StubStore;
use rusqlite::params;

const DIR: &str = "a8-test";

struct Env {
    // Fields drop in order: unmount before the temporary directory goes.
    mount: Option<Mount>,
    cached: bool,
    data: PathBuf,
    mnt: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Env {
    /// `cached`: kernel caching on (long timeouts) with invalidation on view changes;
    /// otherwise zero timeouts, so every operation reaches the daemon.
    fn new(cached: bool) -> Env {
        let tmp = tempfile::Builder::new().prefix("a8-fs-test-").tempdir().unwrap();
        let data = tmp.path().join("data");
        let mut s = StubStore::create(&data, DIR).unwrap();
        s.add_synthetic().unwrap();
        s.add_item("code/src/main.rs", b"fn main() {}\n", &[], true).unwrap();
        s.add_item("code/src/lib.rs", b"pub fn f() {}\n", &[], true).unwrap();
        s.add_item("code/README", b"readme\n", &[], true).unwrap();
        s.conn
            .execute(
                "UPDATE session_view SET writable = 0 WHERE dir_id = ?1 AND path = 'code/README'",
                params![DIR],
            )
            .unwrap();
        drop(s);
        let mut e = Env { cached, mnt: store::session_dir(&data, DIR).join("mnt"), data, _tmp: tmp, mount: None };
        e.remount();
        e
    }

    fn remount(&mut self) {
        if let Some(m) = self.mount.take() {
            m.stop();
        }
        let mut cfg = Config::new(&self.data, DIR);
        if self.cached {
            cfg.entry_timeout = std::time::Duration::from_secs(60);
            cfg.attr_timeout = std::time::Duration::from_secs(60);
        }
        let fs = DriveFs::new(cfg).unwrap();
        let opts = Options { threads: 2, ..Default::default() };
        self.mount = Some(Mount::start(fs, &self.mnt, opts).unwrap());
    }

    fn p(&self, rel: &str) -> PathBuf {
        self.mnt.join(rel)
    }

    fn upper(&self, rel: &str) -> PathBuf {
        store::session_dir(&self.data, DIR).join("upper").join(rel)
    }

    fn whiteouts(&self) -> BTreeSet<String> {
        fs::read_to_string(store::session_dir(&self.data, DIR).join("whiteouts"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn ls(&self, rel: &str) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(self.p(rel))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn conn(&self) -> rusqlite::Connection {
        store::open(&self.data).unwrap()
    }

    /// What the server does after changing session_view: bump the epoch, then tell the daemon.
    fn bump(&self) {
        store::bump_epoch(&self.conn(), DIR).unwrap();
        assert!(daemon::request_refresh(&self.data, DIR).unwrap().is_some());
    }

    fn hide(&self, path: &str) {
        self.conn()
            .execute("DELETE FROM session_view WHERE dir_id = ?1 AND path = ?2", params![DIR, path])
            .unwrap();
        self.bump();
    }
}

fn errno<T: std::fmt::Debug>(r: std::io::Result<T>) -> i32 {
    r.expect_err("expected an error").raw_os_error().unwrap_or(-1)
}

fn listing_shows_view_only(e: Env) {
    assert_eq!(e.ls(""), ["_by", "code", "notes", "projects"]);
    assert_eq!(e.ls("notes"), ["readme.md", "todo.txt"]);
    // The ringed item is in the store but not in session_view.
    assert_eq!(errno(fs::metadata(e.p("finance"))), libc::ENOENT);
    let md = fs::metadata(e.p("notes/todo.txt")).unwrap();
    assert!(md.is_file());
    assert_eq!(md.len(), 21);
    assert!(fs::metadata(e.p("projects/acme")).unwrap().is_dir());
}

fn reads_come_from_blobs(e: Env) {
    assert_eq!(fs::read_to_string(e.p("notes/todo.txt")).unwrap(), "buy milk\nwrite spike\n");
    let mut f = fs::File::open(e.p("notes/readme.md")).unwrap();
    f.seek(SeekFrom::Start(2)).unwrap();
    let mut s = String::new();
    f.read_to_string(&mut s).unwrap();
    assert_eq!(s, "Notes\n\nSynthetic notes for the spike.\n");
    // Nothing was copied up by reading.
    assert!(!e.upper("notes/todo.txt").exists());
}

fn symlinks_from_view(e: Env) {
    let l = e.p("_by/project/acme/plan.md");
    assert!(fs::symlink_metadata(&l).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_link(&l).unwrap(), Path::new("../../../projects/acme/plan.md"));
    assert_eq!(fs::read_to_string(&l).unwrap(), "Plan for Acme Robotics (synthetic).\n");
    // Writing through the symlink updates the target, by copy-up of the target.
    fs::OpenOptions::new().append(true).open(&l).unwrap().write_all(b"more\n").unwrap();
    assert_eq!(
        fs::read_to_string(e.upper("projects/acme/plan.md")).unwrap(),
        "Plan for Acme Robotics (synthetic).\nmore\n"
    );
}

fn session_symlinks(e: Env) {
    std::os::unix::fs::symlink("../notes/todo.txt", e.p("projects/todo-link")).unwrap();
    assert_eq!(fs::read_link(e.p("projects/todo-link")).unwrap(), Path::new("../notes/todo.txt"));
    assert_eq!(fs::read_to_string(e.p("projects/todo-link")).unwrap(), "buy milk\nwrite spike\n");
    assert!(fs::symlink_metadata(e.upper("projects/todo-link")).unwrap().file_type().is_symlink());
    fs::remove_file(e.p("projects/todo-link")).unwrap();
    assert!(!e.ls("projects").contains(&"todo-link".to_string()));
}

fn write_copies_up(e: Env) {
    let before = fs::read(e.p("notes/todo.txt")).unwrap();
    fs::OpenOptions::new().append(true).open(e.p("notes/todo.txt")).unwrap().write_all(b"third\n").unwrap();
    assert_eq!(fs::read_to_string(e.p("notes/todo.txt")).unwrap(), "buy milk\nwrite spike\nthird\n");
    assert_eq!(fs::read_to_string(e.upper("notes/todo.txt")).unwrap(), "buy milk\nwrite spike\nthird\n");
    // The blob is untouched.
    let mut conn = e.conn();
    let (_, rows) = store::load_view(&mut conn, DIR).unwrap();
    let r = rows.iter().find(|r| r.path == "notes/todo.txt").unwrap();
    assert_eq!(fs::read(store::blob_path(&e.data, r.blob_hash.as_ref().unwrap())).unwrap(), before);
    // Overwrite in the middle.
    let mut f = fs::OpenOptions::new().write(true).open(e.p("notes/todo.txt")).unwrap();
    f.seek(SeekFrom::Start(0)).unwrap();
    f.write_all(b"BUY").unwrap();
    drop(f);
    assert!(fs::read_to_string(e.p("notes/todo.txt")).unwrap().starts_with("BUY milk"));
    assert_eq!(e.ls("notes"), ["readme.md", "todo.txt"]);
}

fn truncate_and_setattr(e: Env) {
    fs::write(e.p("notes/readme.md"), b"new\n").unwrap(); // O_TRUNC
    assert_eq!(fs::read_to_string(e.p("notes/readme.md")).unwrap(), "new\n");
    let f = fs::OpenOptions::new().write(true).open(e.p("projects/acme/budget.csv")).unwrap();
    f.set_len(4).unwrap();
    drop(f);
    assert_eq!(fs::read_to_string(e.p("projects/acme/budget.csv")).unwrap(), "item");
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(e.p("projects/acme/plan.md"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(fs::metadata(e.p("projects/acme/plan.md")).unwrap().permissions().mode() & 0o777, 0o755);
    assert_eq!(fs::read_to_string(e.p("projects/acme/plan.md")).unwrap(), "Plan for Acme Robotics (synthetic).\n");
}

fn read_only_items_refuse_writes(e: Env) {
    assert_eq!(fs::read_to_string(e.p("code/README")).unwrap(), "readme\n");
    assert_eq!(errno(fs::OpenOptions::new().write(true).open(e.p("code/README"))), libc::EACCES);
}

fn create_and_mkdir(e: Env) {
    fs::write(e.p("notes/new.txt"), b"fresh\n").unwrap();
    fs::create_dir(e.p("notes/sub")).unwrap();
    fs::write(e.p("notes/sub/deep.txt"), b"deep\n").unwrap();
    fs::create_dir_all(e.p("brand/new/tree")).unwrap();
    assert_eq!(e.ls("notes"), ["new.txt", "readme.md", "sub", "todo.txt"]);
    assert_eq!(fs::read_to_string(e.p("notes/sub/deep.txt")).unwrap(), "deep\n");
    assert_eq!(fs::read_to_string(e.upper("notes/new.txt")).unwrap(), "fresh\n");
    assert!(e.upper("brand/new/tree").is_dir());
    assert_eq!(errno(fs::create_dir(e.p("notes"))), libc::EEXIST);
    assert_eq!(
        errno(fs::OpenOptions::new().write(true).create_new(true).open(e.p("notes/todo.txt"))),
        libc::EEXIST
    );
    assert!(e.whiteouts().is_empty());
}

fn unlink_adds_whiteouts(e: Env) {
    fs::remove_file(e.p("notes/todo.txt")).unwrap();
    assert_eq!(e.ls("notes"), ["readme.md"]);
    assert_eq!(errno(fs::metadata(e.p("notes/todo.txt"))), libc::ENOENT);
    assert_eq!(e.whiteouts(), BTreeSet::from(["notes/todo.txt".to_string()]));
    // A file the session made itself leaves no whiteout.
    fs::write(e.p("notes/tmp"), b"x").unwrap();
    fs::remove_file(e.p("notes/tmp")).unwrap();
    assert_eq!(e.whiteouts().len(), 1);
    // Re-creating a deleted path shows the new content.
    fs::write(e.p("notes/todo.txt"), b"again\n").unwrap();
    assert_eq!(fs::read_to_string(e.p("notes/todo.txt")).unwrap(), "again\n");
    assert_eq!(e.ls("notes"), ["readme.md", "todo.txt"]);
}

fn rmdir_and_recreate(e: Env) {
    assert_eq!(errno(fs::remove_dir(e.p("projects/acme"))), libc::ENOTEMPTY);
    fs::remove_dir_all(e.p("projects")).unwrap();
    assert_eq!(e.ls(""), ["_by", "code", "notes"]);
    assert!(e.whiteouts().contains("projects"));
    fs::create_dir(e.p("projects")).unwrap();
    assert!(e.ls("projects").is_empty(), "a re-created directory starts empty");
}

fn rename_file(e: Env) {
    fs::rename(e.p("notes/todo.txt"), e.p("projects/todo.txt")).unwrap();
    assert_eq!(e.ls("notes"), ["readme.md"]);
    assert_eq!(fs::read_to_string(e.p("projects/todo.txt")).unwrap(), "buy milk\nwrite spike\n");
    assert!(e.whiteouts().contains("notes/todo.txt"));
    // Rename of the session's own file leaves no whiteout.
    fs::write(e.p("a.txt"), b"a").unwrap();
    fs::rename(e.p("a.txt"), e.p("b.txt")).unwrap();
    assert_eq!(fs::read_to_string(e.p("b.txt")).unwrap(), "a");
    assert!(!e.whiteouts().contains("a.txt"));
    // NOREPLACE semantics through the plain API: renaming onto a directory fails.
    assert_eq!(errno(fs::rename(e.p("b.txt"), e.p("notes"))), libc::EISDIR);
}

fn rename_over_existing_file(e: Env) {
    // The save-to-temp-then-rename pattern editors use.
    let mut f = fs::File::create(e.p("notes/.todo.txt.swp")).unwrap();
    f.write_all(b"edited\n").unwrap();
    f.sync_all().unwrap();
    drop(f);
    fs::rename(e.p("notes/.todo.txt.swp"), e.p("notes/todo.txt")).unwrap();
    assert_eq!(fs::read_to_string(e.p("notes/todo.txt")).unwrap(), "edited\n");
    assert_eq!(e.ls("notes"), ["readme.md", "todo.txt"]);
    // The existing item is shadowed (a new version at merge), not deleted.
    assert_eq!(fs::read_to_string(e.upper("notes/todo.txt")).unwrap(), "edited\n");
    assert!(!e.whiteouts().contains("notes/todo.txt"));
    // And over a file the session already copied up.
    fs::write(e.p("notes/t2"), b"second\n").unwrap();
    fs::rename(e.p("notes/t2"), e.p("notes/todo.txt")).unwrap();
    assert_eq!(fs::read_to_string(e.p("notes/todo.txt")).unwrap(), "second\n");
    // Over a store file from a store file.
    fs::rename(e.p("notes/readme.md"), e.p("notes/todo.txt")).unwrap();
    assert_eq!(e.ls("notes"), ["todo.txt"]);
    assert!(fs::read_to_string(e.p("notes/todo.txt")).unwrap().starts_with("# Notes"));
    assert!(e.whiteouts().contains("notes/readme.md"));
}

fn rename_directory(e: Env) {
    fs::write(e.p("code/src/extra.rs"), b"// extra\n").unwrap();
    fs::rename(e.p("code/src"), e.p("code/source")).unwrap();
    assert_eq!(e.ls("code"), ["README", "source"]);
    assert_eq!(e.ls("code/source"), ["extra.rs", "lib.rs", "main.rs"]);
    assert_eq!(fs::read_to_string(e.p("code/source/main.rs")).unwrap(), "fn main() {}\n");
    assert!(e.whiteouts().contains("code/src"));
    assert_eq!(errno(fs::metadata(e.p("code/src/main.rs"))), libc::ENOENT);
    // Into a directory of its own.
    fs::rename(e.p("code/source"), e.p("notes/source")).unwrap();
    assert_eq!(e.ls("notes/source"), ["extra.rs", "lib.rs", "main.rs"]);
}

fn opens_are_recorded(e: Env) {
    let conn = e.conn();
    let count = || -> i64 {
        e.mount.as_ref().unwrap().fs.flush_activity();
        conn.query_row("SELECT count(*) FROM activity WHERE op = 'open'", [], |r| r.get(0)).unwrap()
    };
    assert_eq!(count(), 0);
    fs::read(e.p("notes/todo.txt")).unwrap();
    fs::read(e.p("notes/readme.md")).unwrap();
    fs::write(e.p("notes/new.txt"), b"x").unwrap();
    fs::OpenOptions::new().append(true).open(e.p("notes/todo.txt")).unwrap();
    assert_eq!(count(), 4);
    let rows: Vec<(String, Option<String>, String, String)> = {
        let mut st = conn
            .prepare("SELECT actor, item_id, dir_id, detail FROM activity WHERE op = 'open' ORDER BY id")
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert!(rows.iter().all(|r| r.0 == "fs" && r.2 == DIR));
    let d: serde_json::Value = serde_json::from_str(&rows[0].3).unwrap();
    assert_eq!(d["path"], "notes/todo.txt");
    assert_eq!(d["mode"], "r");
    assert!(rows[0].1.as_deref().unwrap().starts_with("itm_"));
    assert_eq!(rows[2].1, None, "a new file has no item yet");
    let d: serde_json::Value = serde_json::from_str(&rows[3].3).unwrap();
    assert_eq!(d["mode"], "w");
}

fn hide_on_epoch_is_immediate(e: Env) {
    let path = e.p("projects/acme/plan.md");
    assert!(fs::metadata(&path).is_ok());
    assert_eq!(e.ls("projects/acme"), ["budget.csv", "plan.md"]);
    let mut open = fs::File::open(&path).unwrap();
    let mut buf = [0u8; 4];
    open.read_exact(&mut buf).unwrap();

    // The server trashes the item: removes its view row and bumps the epoch.
    let conn = e.conn();
    e.hide("projects/acme/plan.md");

    // Very next lookup and listing.
    assert_eq!(errno(fs::metadata(&path)), libc::ENOENT);
    assert_eq!(e.ls("projects/acme"), ["budget.csv"]);
    // The symlink view pointing at it now dangles.
    assert_eq!(errno(fs::read(e.p("_by/project/acme/plan.md"))), libc::ENOENT);
    // An open handle gets errors: ENOENT when the kernel refreshes attributes first, EACCES
    // from the read itself.
    let mut rest = Vec::new();
    let code = errno(open.read_to_end(&mut rest));
    assert!(code == libc::ENOENT || code == libc::EACCES, "errno {code}");

    // A ring label hides a whole directory the same way.
    conn.execute("DELETE FROM session_view WHERE dir_id = ?1 AND path LIKE 'code/%'", params![DIR]).unwrap();
    e.bump();
    assert_eq!(e.ls(""), ["_by", "notes", "projects"]);
    assert_eq!(errno(fs::read(e.p("code/src/main.rs"))), libc::ENOENT);

    // And un-hiding (an approval, an untrash) shows it again at once.
    conn.execute(
        "INSERT INTO session_view (dir_id, path, kind, item_id, version)
         SELECT ?1, 'projects/acme/plan.md', 'file', item_id, 1 FROM items WHERE path = 'projects/acme/plan.md'",
        params![DIR],
    )
    .unwrap();
    e.bump();
    assert_eq!(fs::read_to_string(&path).unwrap(), "Plan for Acme Robotics (synthetic).\n");
}

fn hide_without_epoch_bump_is_not_seen(e: Env) {
    // Documents the contract: the epoch is the signal; the daemon does not poll rows.
    let conn = e.conn();
    assert!(fs::metadata(e.p("notes/todo.txt")).is_ok());
    conn.execute("DELETE FROM session_view WHERE dir_id = ?1 AND path = 'notes/todo.txt'", params![DIR]).unwrap();
    assert!(fs::metadata(e.p("notes/todo.txt")).is_ok());
    e.bump();
    assert_eq!(errno(fs::metadata(e.p("notes/todo.txt"))), libc::ENOENT);
}

fn item_id_xattr(e: Env) {
    let c = CString::new(e.p("notes/todo.txt").as_os_str().as_bytes()).unwrap();
    let name = CString::new("user.drive.item_id").unwrap();
    let mut buf = [0u8; 64];
    let n = unsafe { libc::getxattr(c.as_ptr(), name.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
    assert!(n > 0, "getxattr: {}", std::io::Error::last_os_error());
    assert!(std::str::from_utf8(&buf[..n as usize]).unwrap().starts_with("itm_"));
}

fn state_survives_remount(mut e: Env) {
    fs::remove_file(e.p("notes/readme.md")).unwrap();
    fs::write(e.p("notes/todo.txt"), b"changed\n").unwrap();
    e.remount();
    assert_eq!(e.ls("notes"), ["todo.txt"]);
    assert_eq!(fs::read_to_string(e.p("notes/todo.txt")).unwrap(), "changed\n");
}

fn many_small_files(e: Env) {
    fs::create_dir(e.p("many")).unwrap();
    for i in 0..500 {
        fs::write(e.p(&format!("many/f{i:04}.txt")), format!("{i}\n")).unwrap();
    }
    let names = e.ls("many");
    assert_eq!(names.len(), 500);
    assert_eq!(fs::read_to_string(e.p("many/f0123.txt")).unwrap(), "123\n");
}

fn unannounced_change_is_picked_up(e: Env) {
    // The server bumps the epoch but does not call the control socket: the per-operation check
    // (zero timeouts) or the poll (kernel caching) applies it.
    assert!(fs::metadata(e.p("notes/todo.txt")).is_ok());
    let conn = e.conn();
    conn.execute("DELETE FROM session_view WHERE dir_id = ?1 AND path = 'notes/todo.txt'", params![DIR]).unwrap();
    store::bump_epoch(&conn, DIR).unwrap();
    if e.cached {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    assert_eq!(errno(fs::metadata(e.p("notes/todo.txt"))), libc::ENOENT);
    assert_eq!(e.ls("notes"), ["readme.md"]);
}

fn added_item_appears(e: Env) {
    // A miss the kernel cached (negative entry) must not hide an item added later.
    assert_eq!(errno(fs::metadata(e.p("notes/later.txt"))), libc::ENOENT);
    let conn = e.conn();
    conn.execute(
        "INSERT INTO session_view (dir_id, path, kind, item_id, version)
         SELECT ?1, 'notes/later.txt', 'file', item_id, 1 FROM items WHERE path = 'notes/todo.txt'",
        params![DIR],
    )
    .unwrap();
    e.bump();
    assert_eq!(fs::read_to_string(e.p("notes/later.txt")).unwrap(), "buy milk\nwrite spike\n");
}

fn inode_table_stays_bounded(e: Env) {
    // Create, write, read, rename and delete files and directories many times over: every
    // inode the kernel was given must be forgotten again, so the table does not grow.
    let fs_ = e.mount.as_ref().unwrap().fs.clone();
    fs::create_dir(e.p("loop")).unwrap();
    let base = fs_.stats();
    let mut peak = 0;
    for i in 0..20_000 {
        let f = e.p(&format!("loop/f{i}"));
        fs::write(&f, b"x").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"x");
        if i % 10 == 0 {
            let d = e.p(&format!("loop/d{i}"));
            fs::create_dir(&d).unwrap();
            fs::rename(&f, d.join("g")).unwrap();
            fs::remove_file(d.join("g")).unwrap();
            fs::remove_dir(&d).unwrap();
        } else {
            fs::remove_file(&f).unwrap();
        }
        if i % 1000 == 0 {
            peak = peak.max(fs_.stats().inodes);
        }
    }
    // Forgets are asynchronous: give the kernel a moment to send the last ones.
    let mut now = fs_.stats();
    for _ in 0..50 {
        if now.inodes <= base.inodes + 50 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        now = fs_.stats();
    }
    eprintln!("inode table: {} before, peak {peak}, {} after 20,000 create/delete rounds", base.inodes, now.inodes);
    assert!(now.inodes <= base.inodes + 50, "inodes grew from {} to {} (peak {peak})", base.inodes, now.inodes);
    assert!(peak <= base.inodes + 1000, "peak {peak}");
    assert!(now.paths <= base.paths + 50, "paths grew from {} to {}", base.paths, now.paths);
    assert_eq!(now.handles, 0);
    assert_eq!(now.dir_handles, 0);
    assert!(e.ls("loop").is_empty());

    // A listing hands out inode numbers the kernel never counts (no lookup): those are kept
    // only up to a cap. 20,000 names placed in upper/ directly and listed without a stat.
    fs::create_dir_all(e.upper("big")).unwrap();
    for i in 0..20_000 {
        fs::write(e.upper(&format!("big/n{i:05}")), b"").unwrap();
    }
    assert_eq!(fs::read_dir(e.p("big")).unwrap().count(), 20_000);
    let after = fs_.stats();
    eprintln!("inode table after listing 20,000 unlooked-up names: {}", after.inodes);
    assert!(after.inodes <= base.inodes + 16_384 + 100, "listing left {} inodes", after.inodes);
    // And a name that was listed and then looked up keeps the number the listing showed.
    use std::os::unix::fs::{DirEntryExt, MetadataExt};
    let last = fs::read_dir(e.p("big")).unwrap().map(|d| d.unwrap()).find(|d| d.file_name() == "n19999").unwrap();
    assert_eq!(last.ino(), fs::metadata(e.p("big/n19999")).unwrap().ino());
}

macro_rules! both_modes {
    ($($name:ident),* $(,)?) => {
        mod zero_timeouts { $( #[test] fn $name() { super::$name(super::Env::new(false)) } )* }
        mod kernel_cache { $( #[test] fn $name() { super::$name(super::Env::new(true)) } )* }
    };
}

both_modes!(
    listing_shows_view_only,
    reads_come_from_blobs,
    symlinks_from_view,
    session_symlinks,
    write_copies_up,
    truncate_and_setattr,
    read_only_items_refuse_writes,
    create_and_mkdir,
    unlink_adds_whiteouts,
    rmdir_and_recreate,
    rename_file,
    rename_over_existing_file,
    rename_directory,
    opens_are_recorded,
    hide_on_epoch_is_immediate,
    hide_without_epoch_bump_is_not_seen,
    item_id_xattr,
    state_survives_remount,
    many_small_files,
    unannounced_change_is_picked_up,
    added_item_appears,
    inode_table_stays_bounded,
);
