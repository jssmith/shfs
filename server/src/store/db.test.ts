import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.js';

test('openDb adds columns that older data directories lack', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a4-db-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'drive.db'));
    // The calls table as the first thin drive created it.
    old.exec(`CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, grant_id TEXT, client_id TEXT, client_name TEXT, client_version TEXT,
      transport_session_id TEXT, tool TEXT NOT NULL, dir_id TEXT, session_arg TEXT, transport_changed INTEGER NOT NULL DEFAULT 0, gap_session_ms INTEGER,
      gap_connection_ms INTEGER, duration_ms INTEGER, ok INTEGER NOT NULL, error_reason TEXT)`);
    old.close();
    const db = openDb(dir);
    const cols = (db.prepare('PRAGMA table_info(calls)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('registered_name');
    db.close();
    openDb(dir).close(); // idempotent
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
