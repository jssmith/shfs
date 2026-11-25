//! A stub store for tests and benchmarks: `drive.db` from the shared schema, blobs, items and
//! one session's `session_view`. Stands in for the TypeScript server.

use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};

use crate::store::{self, SCHEMA};

/// Fixed so that file times on the drive are stable between runs.
pub const CREATED_AT: &str = "2026-11-01T00:00:00.000Z";

pub struct StubStore {
    pub data: PathBuf,
    pub dir_id: String,
    pub conn: Connection,
    next: u64,
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "md" => "text/markdown",
        "txt" | "rs" | "py" | "ts" | "js" | "c" | "h" | "toml" | "json" | "yml" | "yaml" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

impl StubStore {
    /// Creates a fresh data directory (it must not already hold a `drive.db`).
    pub fn create(data: &Path, dir_id: &str) -> anyhow::Result<StubStore> {
        fs::create_dir_all(data.join("blobs"))?;
        let db = store::db_path(data);
        anyhow::ensure!(!db.exists(), "{} already exists", db.display());
        let conn = Connection::open(&db)?;
        conn.execute_batch(SCHEMA)?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute(
            "INSERT INTO sessions (session_id_hash, dir_id, connection_id, purpose, base_state,
                                   status, created_at, last_call_at)
             VALUES (?1, ?2, 'stub', 'spike', 'state-0', 'open', ?3, ?3)",
            params![format!("stub-{dir_id}"), dir_id, CREATED_AT],
        )?;
        conn.execute(
            "INSERT INTO session_view_epoch (dir_id, epoch) VALUES (?1, 1)",
            params![dir_id],
        )?;
        for sub in ["upper", "work", "mnt"] {
            fs::create_dir_all(store::session_dir(data, dir_id).join(sub))?;
        }
        Ok(StubStore { data: data.to_path_buf(), dir_id: dir_id.to_string(), conn, next: 0 })
    }

    pub fn put_blob(&self, bytes: &[u8]) -> io::Result<String> {
        let hash = hex::encode(Sha256::digest(bytes));
        let p = store::blob_path(&self.data, &hash);
        if !p.exists() {
            fs::create_dir_all(p.parent().unwrap())?;
            let tmp = p.with_extension("tmp");
            fs::write(&tmp, bytes)?;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o444))?;
            fs::rename(&tmp, &p)?;
        }
        Ok(hash)
    }

    /// Adds an item with one version. `visible` puts it in the session's view.
    pub fn add_item(&mut self, path: &str, bytes: &[u8], rings: &[&str], visible: bool) -> anyhow::Result<String> {
        self.next += 1;
        let item_id = format!("itm_{:08}", self.next);
        let hash = self.put_blob(bytes)?;
        self.conn.execute(
            "INSERT INTO items (item_id, path, state, current_version, created_at)
             VALUES (?1, ?2, 'live', 1, ?3)",
            params![item_id, path, CREATED_AT],
        )?;
        self.conn.execute(
            "INSERT INTO item_versions (item_id, version, blob_hash, mime, size, ring_check, rings, created_at)
             VALUES (?1, 1, ?2, ?3, ?4, 'done', ?5, ?6)",
            params![item_id, hash, mime_for(path), bytes.len() as i64,
                    serde_json::to_string(rings)?, CREATED_AT],
        )?;
        if visible {
            self.conn.execute(
                "INSERT INTO session_view (dir_id, path, kind, item_id, version, writable)
                 VALUES (?1, ?2, 'file', ?3, 1, 1)",
                params![self.dir_id, path, item_id],
            )?;
        }
        Ok(item_id)
    }

    pub fn add_symlink(&self, path: &str, target: &str) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO session_view (dir_id, path, kind, target) VALUES (?1, ?2, 'symlink', ?3)",
            params![self.dir_id, path, target],
        )?;
        Ok(())
    }

    /// A small synthetic drive: notes, a ringed item that the view leaves out, a symlink view.
    pub fn add_synthetic(&mut self) -> anyhow::Result<()> {
        self.add_item("notes/readme.md", b"# Notes\n\nSynthetic notes for the spike.\n", &[], true)?;
        self.add_item("notes/todo.txt", b"buy milk\nwrite spike\n", &[], true)?;
        self.add_item("projects/acme/plan.md", b"Plan for Acme Robotics (synthetic).\n", &[], true)?;
        self.add_item("projects/acme/budget.csv", b"item,amount\nparts,100\n", &[], true)?;
        self.add_item("finance/2025-taxes.txt", b"synthetic ringed content\n", &["ring:finance"], false)?;
        self.add_symlink("_by/project/acme/plan.md", "../../../projects/acme/plan.md")?;
        Ok(())
    }

    /// Loads a directory tree (for example a Git checkout, `.git` included) as items under `prefix`.
    pub fn load_tree(&mut self, src: &Path, prefix: &str) -> anyhow::Result<usize> {
        self.conn.execute_batch("BEGIN")?;
        let n = self.load_dir(src, prefix);
        self.conn.execute_batch(if n.is_ok() { "COMMIT" } else { "ROLLBACK" })?;
        n
    }

    fn load_dir(&mut self, dir: &Path, prefix: &str) -> anyhow::Result<usize> {
        let mut n = 0;
        let mut entries: Vec<_> = fs::read_dir(dir)?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let ft = e.file_type()?;
            if ft.is_dir() {
                n += self.load_dir(&e.path(), &path)?;
            } else if ft.is_symlink() {
                let t = fs::read_link(e.path())?;
                if t.is_relative() {
                    self.add_symlink(&path, &t.to_string_lossy())?;
                    n += 1;
                }
            } else if ft.is_file() {
                let bytes = fs::read(e.path())?;
                self.add_item(&path, &bytes, &[], true)?;
                n += 1;
            }
        }
        Ok(n)
    }
}

/// Writes the session's view as a plain directory tree: what the thin drive mounts today, and
/// the baseline for the benchmarks.
pub fn materialize(data: &Path, dir_id: &str, out: &Path) -> anyhow::Result<usize> {
    let mut conn = store::open(data)?;
    let (_, rows) = store::load_view(&mut conn, dir_id)?;
    let mtime = std::time::UNIX_EPOCH + std::time::Duration::from_secs(crate::time::parse_iso(CREATED_AT) as u64);
    let mut n = 0;
    for r in rows {
        let dst = out.join(&r.path);
        fs::create_dir_all(dst.parent().unwrap())?;
        match (r.kind.as_str(), r.blob_hash, r.target) {
            ("file", Some(h), _) => {
                fs::copy(store::blob_path(data, &h), &dst)?;
                fs::set_permissions(&dst, fs::Permissions::from_mode(0o644))?;
                fs::File::options().write(true).open(&dst)?.set_modified(mtime)?;
            }
            ("symlink", _, Some(t)) => std::os::unix::fs::symlink(t, &dst)?,
            _ => continue,
        }
        n += 1;
    }
    Ok(n)
}
