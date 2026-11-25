-- Agent Drive store schema, version 1.
-- Shared contract: the TypeScript server owns and migrates it; the Rust file
-- system daemon (fs/) reads it and appends to `activity`. See docs/contracts.md.
-- Blobs live outside SQLite at $AGENT_DRIVE_DATA/blobs/<hash[0:2]>/<hash>, sha256 hex.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');

-- One row per item; `path` is its place in the plain tree (tech spec §6).
CREATE TABLE IF NOT EXISTS items (
  item_id          TEXT PRIMARY KEY,
  path             TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('live', 'archived', 'trashed', 'redacted')),
  current_version  INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS items_live_path ON items (path) WHERE state = 'live';

CREATE TABLE IF NOT EXISTS item_versions (
  item_id     TEXT NOT NULL REFERENCES items (item_id),
  version     INTEGER NOT NULL,
  blob_hash   TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  ring_check  TEXT NOT NULL CHECK (ring_check IN ('pending', 'done')),
  rings       TEXT NOT NULL DEFAULT '[]',   -- JSON array of ring label paths found
  pkg_id      TEXT,                        -- the package that created this version
  created_at  TEXT NOT NULL,
  PRIMARY KEY (item_id, version)
);

-- Labels by id; `path` is the hierarchical display path, e.g. topic:company:acme-robotics.
CREATE TABLE IF NOT EXISTS labels (
  label_id  TEXT PRIMARY KEY,
  path      TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS item_labels (
  item_id      TEXT NOT NULL REFERENCES items (item_id),
  label_id     TEXT NOT NULL REFERENCES labels (label_id),
  assigned_by  TEXT NOT NULL CHECK (assigned_by IN ('drive', 'person', 'session')),
  confidence   REAL,
  assigned_at  TEXT NOT NULL,
  PRIMARY KEY (item_id, label_id)
);

-- Text read out of a version (text layer, OCR, plain), for search and the ring check.
CREATE TABLE IF NOT EXISTS extracted_text (
  item_id     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  method      TEXT NOT NULL,      -- 'plain' | 'text-layer' | 'ocr' | 'none'
  confidence  REAL NOT NULL,
  text        TEXT NOT NULL,
  PRIMARY KEY (item_id, version)
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5 (item_id UNINDEXED, path, labels, text);

-- History: packages form a DAG over states.
CREATE TABLE IF NOT EXISTS packages (
  pkg_id            TEXT PRIMARY KEY,
  parent_state      TEXT,              -- the state this package applies to
  result_state      TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('upload', 'checkpoint', 'finish', 'idle', 'undo', 'person')),
  session_id_hash   TEXT,
  summary_claimed   TEXT,
  summary_observed  TEXT,
  operations        TEXT NOT NULL,     -- JSON: [{op, item_id, from_version?, to_version?, path?, from_path?}]
  created_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS states (
  state_id    TEXT PRIMARY KEY,
  pkg_id      TEXT,
  created_at  TEXT NOT NULL
);

-- Sessions. The secret session id is never stored; only its hash.
CREATE TABLE IF NOT EXISTS sessions (
  session_id_hash  TEXT PRIMARY KEY,
  dir_id           TEXT NOT NULL UNIQUE,   -- names the session's directories; not secret
  connection_id    TEXT NOT NULL,
  purpose          TEXT NOT NULL,
  base_state       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('open', 'needs_resolution', 'paused', 'stopped', 'finished')),
  created_at       TEXT NOT NULL,
  last_call_at     TEXT NOT NULL
);

-- What each session may see under /drive, maintained by the server.
-- The file system daemon serves exactly these rows and re-reads them when
-- `session_view_epoch.epoch` changes, so trash and ring changes apply at once.
CREATE TABLE IF NOT EXISTS session_view (
  dir_id    TEXT NOT NULL,
  path      TEXT NOT NULL,       -- path under /drive, no leading slash
  kind      TEXT NOT NULL CHECK (kind IN ('file', 'symlink')),
  item_id   TEXT,                -- for kind = 'file'
  version   INTEGER,             -- for kind = 'file'
  target    TEXT,                -- for kind = 'symlink', relative target
  writable  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (dir_id, path)
);
CREATE TABLE IF NOT EXISTS session_view_epoch (
  dir_id  TEXT PRIMARY KEY,
  epoch   INTEGER NOT NULL
);

-- Activity, including every file open reported by the daemon (op = 'open').
CREATE TABLE IF NOT EXISTS activity (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               TEXT NOT NULL,
  dir_id           TEXT,
  actor            TEXT NOT NULL,     -- 'agent' | 'person' | 'drive' | 'fs'
  op               TEXT NOT NULL,
  item_id          TEXT,
  bytes_returned   INTEGER,
  detail           TEXT               -- JSON
);
