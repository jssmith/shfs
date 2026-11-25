-- Server-private tables. Not part of the shared contract (schema.sql): the
-- file system daemon never reads these.

CREATE TABLE IF NOT EXISTS jobs (
  job_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,            -- 'check'
  item_id     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  done_at     TEXT
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (status, job_id);

-- Upload-only device keys (`agent-drive device add`).
CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  scope       TEXT NOT NULL,            -- 'upload'
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

-- The one owner: password hash (scrypt) and app sign-in cookies.
CREATE TABLE IF NOT EXISTS owner_auth (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash  TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash  TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- OAuth 2.1 authorization server state.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id   TEXT PRIMARY KEY,
  info        TEXT NOT NULL,            -- JSON OAuthClientInformationFull
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_requests (   -- authorization requests waiting for the owner
  req_id      TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  params      TEXT NOT NULL,            -- JSON AuthorizationParams
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  grant_id        TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  resource        TEXT,
  scopes          TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  used            INTEGER NOT NULL DEFAULT 0
);
-- A grant is a connection: one agent app's authorization. Sessions bind to it.
CREATE TABLE IF NOT EXISTS oauth_grants (
  grant_id     TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  client_name  TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  grant_id     TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  resource     TEXT,
  expires_at   INTEGER NOT NULL,
  replaced_at  INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens (grant_id);

-- What each session's working space was based on (its view when last
-- materialised), kept apart from session_view, which also changes live.
CREATE TABLE IF NOT EXISTS session_base (
  dir_id     TEXT NOT NULL,
  path       TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  blob_hash  TEXT NOT NULL,
  PRIMARY KEY (dir_id, path)
);
CREATE TABLE IF NOT EXISTS session_meta (
  dir_id               TEXT PRIMARY KEY,
  client_name          TEXT,     -- from initialize clientInfo, as declared
  client_version       TEXT,
  registered_name      TEXT,     -- from dynamic client registration, as declared
  first_transport_id   TEXT,
  last_transport_id    TEXT,
  summary_last         TEXT,
  run_count            INTEGER NOT NULL DEFAULT 0
);

-- Instrumentation: one row per MCP tool call (wave 1, uncertainty 1).
CREATE TABLE IF NOT EXISTS calls (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                    TEXT NOT NULL,
  grant_id              TEXT,
  client_id             TEXT,
  client_name           TEXT,
  client_version        TEXT,
  registered_name       TEXT,     -- client_name from the OAuth grant's registration, as declared
  transport_session_id  TEXT,
  tool                  TEXT NOT NULL,
  dir_id                TEXT,
  session_arg           TEXT,     -- 'none' | 'matched' | 'unknown' | 'malformed' | 'other_connection'
  transport_changed     INTEGER NOT NULL DEFAULT 0,
  gap_session_ms        INTEGER,  -- since the previous call in the same drive session
  gap_connection_ms     INTEGER,  -- since the previous call on the same connection
  duration_ms           INTEGER,
  ok                    INTEGER NOT NULL,
  error_reason          TEXT
);
CREATE INDEX IF NOT EXISTS calls_grant ON calls (grant_id, id);
