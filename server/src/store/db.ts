// Opening and migrating drive.db. node:sqlite is synchronous, which keeps
// every transaction free of interleaving: nothing awaits inside one.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = DatabaseSync;
export type Row = Record<string, unknown>;

function findSql(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, name), path.join(here, '..', '..', 'src', 'store', name)];
  for (const c of candidates) if (existsSync(c)) return readFileSync(c, 'utf8');
  throw new Error(`store: cannot find ${name}`);
}

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'drive.db'));
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(findSql('schema.sql'));
  db.exec(findSql('server-schema.sql'));
  // Columns added to server-private tables after a data directory was created.
  const addColumn = (table: string, column: string, type: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn('calls', 'registered_name', 'TEXT');
  addColumn('session_meta', 'lifecycle', "TEXT NOT NULL DEFAULT 'active'");
  addColumn('session_meta', 'current_turn', 'TEXT');
  addColumn('session_meta', 'last_call_end', 'INTEGER');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

const depth = new WeakMap<DB, number>();

/** Run `fn` in a transaction (nested calls join the outer one). Rolls back on throw. */
export function tx<T>(db: DB, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try {
      return fn();
    } finally {
      depth.set(db, d);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

export function all<T = Row>(db: DB, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}
export function get<T = Row>(db: DB, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}
export function run(db: DB, sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as never[]));
}

export function getMeta(db: DB, key: string): string | undefined {
  return get<{ value: string }>(db, 'SELECT value FROM meta WHERE key = ?', key)?.value;
}
export function setMeta(db: DB, key: string, value: string): void {
  run(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}
