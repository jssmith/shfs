//! The session's view of the store at one epoch: what `session_view` says it may see.

use std::collections::{BTreeMap, HashMap};

use crate::store::ViewRow;

#[derive(Debug, Clone, PartialEq)]
pub enum Lower {
    File {
        item_id: String,
        version: i64,
        blob: String,
        size: u64,
        mtime: i64,
        writable: bool,
        /// Permission bits as served (the row's mode, or 0o644; write bits cleared when not
        /// writable).
        mode: u32,
    },
    Symlink {
        target: String,
    },
    Dir {
        mode: u32,
    },
}

pub const DEFAULT_FILE_MODE: u32 = 0o644;
pub const DEFAULT_DIR_MODE: u32 = 0o755;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildKind {
    File,
    Symlink,
    Dir,
}

#[derive(Debug, Default)]
pub struct View {
    pub epoch: i64,
    /// Files and symlinks by path (no leading slash).
    pub entries: HashMap<String, Lower>,
    /// Directory path ("" is the root) to its children.
    pub dirs: HashMap<String, BTreeMap<String, ChildKind>>,
    /// Modes of directories that have a `kind = 'dir'` row with a mode; others are 0o755.
    pub dir_modes: HashMap<String, u32>,
}

pub fn parent_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

pub fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") }
}

fn normalise(p: &str) -> Option<String> {
    let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    if parts.is_empty() || parts.contains(&"..") {
        return None;
    }
    Some(parts.join("/"))
}

impl View {
    pub fn build(epoch: i64, rows: Vec<ViewRow>) -> View {
        let mut v = View { epoch, ..Default::default() };
        v.dirs.insert(String::new(), BTreeMap::new());
        for r in rows {
            let Some(path) = normalise(&r.path) else {
                log::warn!("skipping bad view path {:?}", r.path);
                continue;
            };
            if r.kind == "dir" {
                v.add_dir(&path, r.mode);
                continue;
            }
            let (lower, kind) = match r.kind.as_str() {
                "file" => match (r.item_id, r.version, r.blob_hash, r.size) {
                    (Some(item_id), Some(version), Some(blob), Some(size)) => (
                        Lower::File {
                            item_id,
                            version,
                            blob,
                            size: size.max(0) as u64,
                            mtime: r.created_at.as_deref().map(crate::time::parse_iso).unwrap_or(0),
                            writable: r.writable,
                            mode: r.mode.unwrap_or(DEFAULT_FILE_MODE) & if r.writable { 0o7777 } else { !0o222 & 0o7777 },
                        },
                        ChildKind::File,
                    ),
                    _ => {
                        log::warn!("skipping file row without a version: {path}");
                        continue;
                    }
                },
                "symlink" => match r.target {
                    Some(target) => (Lower::Symlink { target }, ChildKind::Symlink),
                    None => continue,
                },
                _ => continue,
            };
            // Intermediate directories.
            let mut parent = String::new();
            let comps: Vec<&str> = path.split('/').collect();
            let mut clash = false;
            for c in &comps[..comps.len() - 1] {
                let child = join(&parent, c);
                if v.entries.contains_key(&child) {
                    clash = true;
                    break;
                }
                v.dirs.entry(parent.clone()).or_default().insert(c.to_string(), ChildKind::Dir);
                v.dirs.entry(child.clone()).or_default();
                parent = child;
            }
            if clash || v.dirs.contains_key(&path) {
                log::warn!("skipping {path}: a file and a directory share a path");
                continue;
            }
            v.dirs.entry(parent).or_default().insert(comps[comps.len() - 1].to_string(), kind);
            v.entries.insert(path, lower);
        }
        v
    }

    /// A `kind = 'dir'` row: the directory and the ones above it, unless a file or symlink
    /// row already holds one of those paths.
    fn add_dir(&mut self, path: &str, mode: Option<u32>) {
        let comps: Vec<&str> = path.split('/').collect();
        let mut p = String::new();
        for c in &comps {
            p = join(&p, c);
            if self.entries.contains_key(&p) {
                log::warn!("skipping directory row {path}: {p} is a file");
                return;
            }
        }
        let mut parent = String::new();
        for c in &comps {
            let child = join(&parent, c);
            self.dirs.entry(parent.clone()).or_default().insert(c.to_string(), ChildKind::Dir);
            self.dirs.entry(child.clone()).or_default();
            parent = child;
        }
        if let Some(m) = mode {
            self.dir_modes.insert(path.to_string(), m & 0o7777);
        }
    }

    pub fn get(&self, path: &str) -> Option<Lower> {
        if self.dirs.contains_key(path) {
            return Some(Lower::Dir { mode: self.dir_modes.get(path).copied().unwrap_or(DEFAULT_DIR_MODE) });
        }
        self.entries.get(path).cloned()
    }

    /// Paths that differ between two views: removed, added, or changed (another item, version,
    /// target or kind).
    pub fn changed_paths(&self, new: &View) -> Vec<String> {
        let mut out = Vec::new();
        for p in self.entries.keys().chain(self.dirs.keys()) {
            if self.get(p) != new.get(p) {
                out.push(p.clone());
            }
        }
        for p in new.entries.keys().chain(new.dirs.keys()) {
            if self.get(p).is_none() {
                out.push(p.clone());
            }
        }
        out.retain(|p| !p.is_empty());
        out
    }

    /// Every file and symlink at or under `dir`.
    pub fn descendants<'a>(&'a self, dir: &'a str) -> impl Iterator<Item = (&'a String, &'a Lower)> {
        let prefix = format!("{dir}/");
        self.entries
            .iter()
            .filter(move |(p, _)| dir.is_empty() || p.starts_with(&prefix))
    }
}
