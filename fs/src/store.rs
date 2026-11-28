//! The daemon's side of the SQLite store (docs/contracts.md §1–2).
//!
//! The daemon only reads `session_view`, `session_view_epoch` and `item_versions`,
//! and appends to `activity`.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, params};

/// The shared schema, compiled in from the server's copy so the two never drift.
pub const SCHEMA: &str = include_str!("../../server/src/store/schema.sql");

pub fn db_path(data: &Path) -> PathBuf {
    data.join("drive.db")
}

pub fn blob_path(data: &Path, hash: &str) -> PathBuf {
    data.join("blobs").join(&hash[..2]).join(hash)
}

pub fn session_dir(data: &Path, dir_id: &str) -> PathBuf {
    data.join("sessions").join(dir_id)
}

/// Opens the store for the daemon: read-write (for `activity`), never creating it.
pub fn open(data: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        db_path(data),
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(conn)
}

/// A cheap test for "has anything been committed since I last looked?", so the epoch query
/// can be skipped on most operations. It reads the WAL-index header at the start of
/// `drive.db-shm` (SQLite's documented WAL format: the header changes on every write
/// transaction, and after a WAL reset its salt changes). With `pread`, not `mmap`, so a
/// truncated file cannot fault. Without a `-shm` file (not in WAL mode) every call reports a
/// change, so the epoch query always runs.
pub struct ChangeProbe {
    file: Option<std::fs::File>,
    last: [u8; 48],
    primed: bool,
}

impl ChangeProbe {
    pub fn new(data: &Path) -> ChangeProbe {
        let shm = data.join("drive.db-shm");
        ChangeProbe { file: std::fs::File::open(shm).ok(), last: [0; 48], primed: false }
    }

    /// True if the database may have changed since the last call that returned true.
    pub fn changed(&mut self) -> bool {
        use std::os::unix::fs::FileExt;
        let Some(f) = &self.file else { return true };
        let mut buf = [0u8; 48];
        match f.read_exact_at(&mut buf, 0) {
            Ok(()) if self.primed && buf == self.last => false,
            Ok(()) => {
                self.last = buf;
                self.primed = true;
                true
            }
            Err(_) => true,
        }
    }
}

/// Current epoch for a session; 0 when the row is missing.
pub fn epoch(conn: &Connection, dir_id: &str) -> rusqlite::Result<i64> {
    let mut st = conn.prepare_cached("SELECT epoch FROM session_view_epoch WHERE dir_id = ?1")?;
    let mut rows = st.query(params![dir_id])?;
    Ok(match rows.next()? {
        Some(r) => r.get(0)?,
        None => 0,
    })
}

/// One `session_view` row joined with its item version.
#[derive(Debug, Clone)]
pub struct ViewRow {
    pub path: String,
    pub kind: String,
    pub item_id: Option<String>,
    pub version: Option<i64>,
    pub target: Option<String>,
    pub writable: bool,
    /// Permission bits (`session_view.mode`); None for NULL or a store without the column.
    pub mode: Option<u32>,
    pub blob_hash: Option<String>,
    pub size: Option<i64>,
    pub created_at: Option<String>,
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut st = conn.prepare_cached("SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2")?;
    st.exists(params![table, column])
}

/// Reads the view and its epoch in one read transaction, so they agree. A store whose
/// `session_view` predates the `mode` column is read as if every mode were NULL.
pub fn load_view(conn: &mut Connection, dir_id: &str) -> rusqlite::Result<(i64, Vec<ViewRow>)> {
    let tx = conn.transaction()?;
    let ep = epoch(&tx, dir_id)?;
    let mode = if has_column(&tx, "session_view", "mode")? { "sv.mode" } else { "NULL" };
    let rows = {
        let mut st = tx.prepare_cached(&format!(
            "SELECT sv.path, sv.kind, sv.item_id, sv.version, sv.target, sv.writable,
                    iv.blob_hash, iv.size, iv.created_at, {mode}
             FROM session_view sv
             LEFT JOIN item_versions iv ON iv.item_id = sv.item_id AND iv.version = sv.version
             WHERE sv.dir_id = ?1"
        ))?;
        st.query_map(params![dir_id], |r| {
            Ok(ViewRow {
                path: r.get(0)?,
                kind: r.get(1)?,
                item_id: r.get(2)?,
                version: r.get(3)?,
                target: r.get(4)?,
                writable: r.get::<_, i64>(5)? != 0,
                blob_hash: r.get(6)?,
                size: r.get(7)?,
                created_at: r.get(8)?,
                mode: r.get::<_, Option<i64>>(9)?.map(|m| (m & 0o7777) as u32),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    tx.commit()?;
    Ok((ep, rows))
}

/// How long opens are collected before they are written to `activity`.
const BATCH: Duration = Duration::from_millis(20);

/// Opens of one (path, mode, item) within this long of the first share one `activity` row,
/// whose `detail.count` says how many there were (docs/contracts.md §2, Accounting).
pub const AGGREGATE: Duration = Duration::from_secs(60);

/// One file open, for `activity`.
#[derive(Debug, Clone)]
pub struct OpenRecord {
    pub ts: String,
    pub item_id: Option<String>,
    pub path: String,
    pub mode: &'static str,
}

/// Appends `activity` rows on a background thread, batching whatever is queued into one
/// transaction, so an open never waits for SQLite to commit. Repeated opens of the same path
/// in the same mode are counted into the row of the first one for [`AGGREGATE`]: at most one
/// row per (path, mode) per minute, instead of one per open (4.8 million rows in a 25-minute
/// soak, decision 0003).
pub struct ActivityLog {
    tx: Option<mpsc::Sender<Msg>>,
    handle: Option<thread::JoinHandle<()>>,
}

enum Msg {
    Open(OpenRecord),
    Flush(mpsc::Sender<()>),
}

type Key = (String, &'static str, Option<String>);

/// The row of one key: its id, when it started, how many opens it counts, and whether the
/// count changed since it was last written.
struct Window {
    row: i64,
    started: std::time::Instant,
    count: u64,
    dirty: bool,
}

fn detail(path: &str, mode: &str, count: u64) -> String {
    serde_json::json!({ "path": path, "mode": mode, "count": count }).to_string()
}

impl ActivityLog {
    pub fn start(data: &Path, dir_id: &str) -> rusqlite::Result<ActivityLog> {
        Self::start_with(data, dir_id, AGGREGATE)
    }

    /// `window`: how long opens of one key share a row (zero: one row per open).
    pub fn start_with(data: &Path, dir_id: &str, window: Duration) -> rusqlite::Result<ActivityLog> {
        let mut conn = open(data)?;
        let dir_id = dir_id.to_string();
        let (tx, rx) = mpsc::channel::<Msg>();
        let handle = thread::Builder::new()
            .name("a2-fs-activity".into())
            .spawn(move || {
                let mut windows: std::collections::HashMap<Key, Window> = std::collections::HashMap::new();
                while let Ok(first) = rx.recv() {
                    // Collect for up to BATCH, so a burst of opens is one transaction (each
                    // write also makes the daemon's change probe fall through to a query).
                    let deadline = std::time::Instant::now() + BATCH;
                    let mut flush = matches!(first, Msg::Flush(_));
                    let mut batch = vec![first];
                    while !flush {
                        let left = deadline.saturating_duration_since(std::time::Instant::now());
                        match rx.recv_timeout(left) {
                            Ok(m) => {
                                flush = matches!(m, Msg::Flush(_));
                                batch.push(m);
                            }
                            Err(_) => break,
                        }
                    }
                    let now = std::time::Instant::now();
                    windows.retain(|_, w| now.duration_since(w.started) < window);
                    let mut waiters = Vec::new();
                    let res: rusqlite::Result<()> = (|| {
                        let t = conn.transaction()?;
                        {
                            let mut ins = t.prepare_cached(
                                "INSERT INTO activity (ts, dir_id, actor, op, item_id, detail)
                                 VALUES (?1, ?2, 'fs', 'open', ?3, ?4)",
                            )?;
                            for m in &batch {
                                let Msg::Open(r) = m else { continue };
                                let key: Key = (r.path.clone(), r.mode, r.item_id.clone());
                                if let Some(w) = windows.get_mut(&key) {
                                    w.count += 1;
                                    w.dirty = true;
                                    continue;
                                }
                                ins.execute(params![r.ts, dir_id, r.item_id, detail(&r.path, r.mode, 1)])?;
                                if !window.is_zero() {
                                    let row = t.last_insert_rowid();
                                    windows.insert(key, Window { row, started: now, count: 1, dirty: false });
                                }
                            }
                            let mut upd = t.prepare_cached("UPDATE activity SET detail = ?1 WHERE id = ?2")?;
                            for ((path, mode, _), w) in windows.iter_mut() {
                                if w.dirty {
                                    upd.execute(params![detail(path, mode, w.count), w.row])?;
                                    w.dirty = false;
                                }
                            }
                        }
                        t.commit()
                    })();
                    if let Err(e) = res {
                        log::error!("activity write failed: {e}");
                    }
                    for m in batch {
                        if let Msg::Flush(w) = m {
                            waiters.push(w);
                        }
                    }
                    for w in waiters {
                        let _ = w.send(());
                    }
                }
            })
            .expect("spawn activity thread");
        Ok(ActivityLog { tx: Some(tx), handle: Some(handle) })
    }

    pub fn record(&self, r: OpenRecord) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(Msg::Open(r));
        }
    }

    /// Waits until everything recorded so far is committed.
    pub fn flush(&self) {
        if let Some(tx) = &self.tx {
            let (wt, wr) = mpsc::channel();
            if tx.send(Msg::Flush(wt)).is_ok() {
                let _ = wr.recv();
            }
        }
    }
}

impl Drop for ActivityLog {
    fn drop(&mut self) {
        self.tx.take();
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Server-side operations the spike needs to drive the daemon: hide a path the way the server
/// does when an item is trashed or ringed, and bump the epoch.
pub fn bump_epoch(conn: &Connection, dir_id: &str) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO session_view_epoch (dir_id, epoch) VALUES (?1, 1)
         ON CONFLICT (dir_id) DO UPDATE SET epoch = epoch + 1",
        params![dir_id],
    )?;
    epoch(conn, dir_id)
}

pub fn hide_path(conn: &Connection, dir_id: &str, path: &str) -> rusqlite::Result<usize> {
    let n = conn.execute(
        "DELETE FROM session_view WHERE dir_id = ?1 AND path = ?2",
        params![dir_id, path],
    )?;
    bump_epoch(conn, dir_id)?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_store_without_the_mode_column() {
        let tmp = tempfile::Builder::new().prefix("a8-store-").tempdir().unwrap();
        let mut s = crate::stub::StubStore::create(tmp.path(), "a8-m").unwrap();
        s.add_synthetic().unwrap();
        s.set_mode("notes/todo.txt", 0o755).unwrap();
        let mut c = open(tmp.path()).unwrap();
        let (_, rows) = load_view(&mut c, "a8-m").unwrap();
        assert_eq!(rows.iter().find(|r| r.path == "notes/todo.txt").unwrap().mode, Some(0o755));
        s.conn.execute_batch("ALTER TABLE session_view DROP COLUMN mode").unwrap();
        let (_, rows) = load_view(&mut c, "a8-m").unwrap();
        assert_eq!(rows.len(), 5);
        assert!(rows.iter().all(|r| r.mode.is_none()));
    }

    #[test]
    fn change_probe_sees_writes_from_another_connection() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = crate::stub::StubStore::create(tmp.path(), "a2-p").unwrap();
        s.add_synthetic().unwrap();
        let reader = open(tmp.path()).unwrap();
        assert_eq!(epoch(&reader, "a2-p").unwrap(), 1);
        let mut probe = ChangeProbe::new(tmp.path());
        assert!(probe.changed(), "first call primes");
        assert!(!probe.changed());
        assert!(!probe.changed());
        let writer = open(tmp.path()).unwrap();
        bump_epoch(&writer, "a2-p").unwrap();
        assert!(probe.changed());
        assert!(!probe.changed());
        for _ in 0..3 {
            writer
                .execute(
                    "INSERT INTO meta (key, value) VALUES ('k', 'v')
                     ON CONFLICT (key) DO UPDATE SET value = value || 'v'",
                    [],
                )
                .unwrap();
            assert!(probe.changed());
        }
        // Across a checkpoint that truncates the WAL, and the reset that follows.
        writer.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        probe.changed();
        bump_epoch(&writer, "a2-p").unwrap();
        assert!(probe.changed());
        assert_eq!(epoch(&reader, "a2-p").unwrap(), 3);
    }

    #[test]
    fn repeated_opens_share_one_row_per_window() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = crate::stub::StubStore::create(tmp.path(), "a2-agg").unwrap();
        s.add_synthetic().unwrap();
        let rec = |p: &str, mode: &'static str| OpenRecord { ts: crate::time::now_iso(), item_id: None, path: p.into(), mode };
        let rows = || -> Vec<String> {
            let c = open(tmp.path()).unwrap();
            let mut st = c.prepare("SELECT detail FROM activity WHERE op = 'open' ORDER BY id").unwrap();
            st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        let log = ActivityLog::start_with(tmp.path(), "a2-agg", Duration::from_millis(400)).unwrap();
        for _ in 0..1000 {
            log.record(rec("a.txt", "r"));
        }
        log.record(rec("a.txt", "w"));
        log.record(rec("b.txt", "r"));
        log.flush();
        for _ in 0..5 {
            log.record(rec("a.txt", "r"));
        }
        log.flush();
        let got = rows();
        assert_eq!(got.len(), 3, "{got:?}");
        let d: serde_json::Value = serde_json::from_str(&got[0]).unwrap();
        assert_eq!((d["path"].as_str(), d["mode"].as_str(), d["count"].as_u64()), (Some("a.txt"), Some("r"), Some(1005)));
        // After the window, a new row.
        std::thread::sleep(Duration::from_millis(500));
        log.record(rec("a.txt", "r"));
        log.flush();
        assert_eq!(rows().len(), 4);
    }
}
