// Sessions: the secret id, the working space and its view, and the tools
// that act inside it. The working space is the materialised fallback of
// docs/contracts.md §2: the server writes `sessions/<dir_id>/upper/` from the
// session's view itself and mounts it at /drive.
import { mkdirSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { all, get, run, tx } from '../store/db.js';
import type { Drive, ViewEntry } from '../store/drive.js';
import { cleanDrivePath, safeHash, safeRead, safeRemove, safeWrite, walkFiles } from '../util/fsafe.js';
import { newId, newSessionId, now, secretHash, SESSION_ID_RE } from '../util/ids.js';
import { KeyedMutex } from '../util/mutex.js';
import type { Sandbox } from './sandbox.js';
import { isToolCache } from '../merge/ignore.js';

export const OUTPUT_CAP = 64 * 1024;
export const READ_CAP = 256 * 1024;
export const WRITE_CAP = 4 * 1024 * 1024;

export class ToolError extends Error {
  constructor(readonly reason: string, message: string) {
    super(`${reason}: ${message}`);
  }
}

export interface SessionRow {
  session_id_hash: string;
  dir_id: string;
  connection_id: string;
  purpose: string;
  base_state: string;
  status: 'open' | 'needs_resolution' | 'paused' | 'stopped' | 'finished';
  created_at: string;
  last_call_at: string;
}

export interface SessionDirs { root: string; upper: string; work: string; state: string }

export class Sessions {
  readonly lock = new KeyedMutex();

  constructor(
    readonly drive: Drive,
    readonly sessionsDir: string,
    readonly sandbox: Sandbox,
    readonly sandboxPrefix: string,
  ) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  dirs(dir_id: string): SessionDirs {
    if (!/^sd_[a-z2-7]+$/.test(dir_id)) throw new Error('bad dir id');
    const root = path.join(this.sessionsDir, dir_id);
    return { root, upper: path.join(root, 'upper'), work: path.join(root, 'work'), state: path.join(root, 'state') };
  }

  sandboxId(dir_id: string): string {
    return `${this.sandboxPrefix}${dir_id.replace(/_/g, '-')}`;
  }

  // ---------- identity ----------

  async start(connection_id: string, purpose: string, client: { name?: string; version?: string; registered?: string; transport?: string }): Promise<{ session_id: string; row: SessionRow }> {
    const session_id = newSessionId();
    const dir_id = newId('sd');
    const ts = now();
    const d = this.dirs(dir_id);
    for (const p of [d.upper, d.work, d.state]) mkdirSync(p, { recursive: true });
    tx(this.drive.db, () => {
      run(
        this.drive.db,
        "INSERT INTO sessions (session_id_hash, dir_id, connection_id, purpose, base_state, status, created_at, last_call_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
        secretHash(session_id), dir_id, connection_id, purpose, this.drive.currentState(), ts, ts,
      );
      run(
        this.drive.db,
        'INSERT INTO session_meta (dir_id, client_name, client_version, registered_name, first_transport_id, last_transport_id) VALUES (?, ?, ?, ?, ?, ?)',
        dir_id, client.name ?? null, client.version ?? null, client.registered ?? null, client.transport ?? null, client.transport ?? null,
      );
      this.drive.activity({ dir_id, actor: 'agent', op: 'start_session', detail: { purpose } });
    });
    await this.lock.run(dir_id, () => this.materialise(dir_id));
    return { session_id, row: this.byDir(dir_id)! };
  }

  byDir(dir_id: string): SessionRow | undefined {
    return get<SessionRow>(this.drive.db, 'SELECT * FROM sessions WHERE dir_id = ?', dir_id);
  }

  /** Look up a session by its secret id; only the connection that created it may use it. */
  lookup(session_id: unknown, connection_id: string): { row?: SessionRow; arg: 'none' | 'matched' | 'unknown' | 'malformed' | 'other_connection' } {
    if (session_id === undefined || session_id === null || session_id === '') return { arg: 'none' };
    if (typeof session_id !== 'string' || !SESSION_ID_RE.test(session_id)) return { arg: 'malformed' };
    const row = get<SessionRow>(this.drive.db, 'SELECT * FROM sessions WHERE session_id_hash = ?', secretHash(session_id));
    if (!row) return { arg: 'unknown' };
    if (row.connection_id !== connection_id) return { arg: 'other_connection' };
    return { row, arg: 'matched' };
  }

  touch(dir_id: string): void {
    run(this.drive.db, 'UPDATE sessions SET last_call_at = ? WHERE dir_id = ?', now(), dir_id);
  }

  // ---------- the view ----------

  /**
   * Make the session's base the drive's current reachable state, and make
   * upper/ match it exactly. Called at start and after every merge (rebase).
   * The caller holds the session lock.
   */
  async materialise(dir_id: string): Promise<void> {
    const db = this.drive.db;
    const view = this.drive.reachableView();
    const state = this.drive.currentState();
    const d = this.dirs(dir_id);
    mkdirSync(d.upper, { recursive: true });
    const want = new Map(view.map((v) => [v.path, v]));
    for (const v of view) {
      const h = await safeHash(d.upper, v.path);
      if (h !== v.blob_hash) await safeWrite(d.upper, v.path, await this.drive.blobs.get(v.blob_hash));
    }
    // Tool caches are never merged but stay in the working copy for the tools that made them.
    for (const f of await walkFiles(d.upper, { hash: false })) if (!want.has(f.path) && !isToolCache(f.path)) await safeRemove(d.upper, f.path);
    tx(db, () => {
      run(db, 'DELETE FROM session_view WHERE dir_id = ?', dir_id);
      run(db, 'DELETE FROM session_base WHERE dir_id = ?', dir_id);
      for (const v of view) {
        run(db, "INSERT INTO session_view (dir_id, path, kind, item_id, version, target, writable) VALUES (?, ?, 'file', ?, ?, NULL, 1)", dir_id, v.path, v.item_id, v.version);
        run(db, 'INSERT INTO session_base (dir_id, path, item_id, version, blob_hash) VALUES (?, ?, ?, ?, ?)', dir_id, v.path, v.item_id, v.version, v.blob_hash);
      }
      run(db, 'UPDATE sessions SET base_state = ? WHERE dir_id = ?', state, dir_id);
      this.bumpEpoch(dir_id);
    });
  }

  bumpEpoch(dir_id: string): void {
    run(this.drive.db, 'INSERT INTO session_view_epoch (dir_id, epoch) VALUES (?, 1) ON CONFLICT(dir_id) DO UPDATE SET epoch = epoch + 1', dir_id);
  }

  base(dir_id: string): Map<string, { item_id: string; version: number; blob_hash: string }> {
    return new Map(
      all<{ path: string; item_id: string; version: number; blob_hash: string }>(this.drive.db, 'SELECT path, item_id, version, blob_hash FROM session_base WHERE dir_id = ?', dir_id).map((r) => [
        r.path,
        { item_id: r.item_id, version: r.version, blob_hash: r.blob_hash },
      ]),
    );
  }

  viewPaths(dir_id: string): Set<string> {
    return new Set(all<{ path: string }>(this.drive.db, 'SELECT path FROM session_view WHERE dir_id = ?', dir_id).map((r) => r.path));
  }

  /**
   * Live visibility (tech spec §3.3): an item that is trashed or ringed leaves
   * every session's view at once. Its file is removed from the working space
   * unless the session changed it (then the next merge reports a conflict).
   */
  async applyVisibility(item_id: string): Promise<void> {
    if (this.drive.reachable(item_id)) return;
    const rows = all<{ dir_id: string; path: string }>(this.drive.db, 'SELECT dir_id, path FROM session_view WHERE item_id = ?', item_id);
    for (const r of rows) {
      const d = this.dirs(r.dir_id);
      const baseHash = get<{ blob_hash: string }>(this.drive.db, 'SELECT blob_hash FROM session_base WHERE dir_id = ? AND path = ?', r.dir_id, r.path)?.blob_hash;
      tx(this.drive.db, () => {
        run(this.drive.db, 'DELETE FROM session_view WHERE dir_id = ? AND path = ?', r.dir_id, r.path);
        this.bumpEpoch(r.dir_id);
      });
      const h = await safeHash(d.upper, r.path);
      if (h !== null && h === baseHash) await safeRemove(d.upper, r.path);
    }
  }

  // ---------- tools ----------

  summary(dir_id: string): { files: number; top: Record<string, number>; hidden: Record<string, number>; topics: string[] } {
    const view = all<{ path: string }>(this.drive.db, 'SELECT path FROM session_view WHERE dir_id = ?', dir_id);
    const top: Record<string, number> = {};
    for (const v of view) {
      const t = v.path.includes('/') ? `${v.path.split('/')[0]}/` : '(top level)';
      top[t] = (top[t] ?? 0) + 1;
    }
    const purpose = this.byDir(dir_id)?.purpose.toLowerCase() ?? '';
    // Only topics carried by items this session can see: a topic name on a ringed item says something about it.
    const topics = all<{ path: string }>(
      this.drive.db,
      "SELECT DISTINCT l.path FROM labels l JOIN item_labels il ON il.label_id = l.label_id JOIN session_view v ON v.item_id = il.item_id AND v.dir_id = ? WHERE l.path LIKE 'topic:%'",
      dir_id,
    )
      .map((r) => r.path)
      .filter((p) => p.split(':').slice(1).some((seg) => seg.split('-').some((w) => w.length > 2 && purpose.includes(w))));
    return { files: view.length, top, hidden: this.drive.hiddenCounts(), topics };
  }

  async run(dir_id: string, command: string, timeoutSec: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; fullOutput?: string }> {
    return this.lock.run(dir_id, async () => {
      const d = this.dirs(dir_id);
      const id = this.sandboxId(dir_id);
      await this.sandbox.create({ id, driveDir: d.upper, workDir: d.work, stateDir: d.state });
      const t0 = Date.now();
      const r = await this.sandbox.exec(id, command, { timeoutMs: timeoutSec * 1000 });
      const total = r.stdout.length + r.stderr.length;
      let stdout = r.stdout;
      let stderr = r.stderr;
      let truncated = false;
      let fullOutput: string | undefined;
      const n = (get<{ run_count: number }>(this.drive.db, 'SELECT run_count FROM session_meta WHERE dir_id = ?', dir_id)?.run_count ?? 0) + 1;
      run(this.drive.db, 'UPDATE session_meta SET run_count = ? WHERE dir_id = ?', n, dir_id);
      if (total > OUTPUT_CAP) {
        truncated = true;
        const outCap = Math.min(stdout.length, Math.max(OUTPUT_CAP - Math.min(stderr.length, OUTPUT_CAP / 4), OUTPUT_CAP / 2));
        stdout = stdout.subarray(0, outCap);
        stderr = stderr.subarray(0, OUTPUT_CAP - outCap);
        const rel = `.drive-output/run-${n}.txt`;
        await safeWrite(d.work, rel, Buffer.concat([Buffer.from(`$ ${command}\n--- stdout ---\n`), r.stdout, Buffer.from('\n--- stderr ---\n'), r.stderr]));
        fullOutput = `/work/${rel}`;
      }
      this.drive.activity({ dir_id, actor: 'agent', op: 'run', bytes: stdout.length + stderr.length, detail: { command: command.slice(0, 2000), exit: r.exitCode, ms: Date.now() - t0, timed_out: r.timedOut, total_bytes: total } });
      return { exitCode: r.exitCode, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut: r.timedOut, truncated, fullOutput };
    });
  }

  async read(dir_id: string, p: string): Promise<{ path: string; text: string; size: number; truncated: boolean; binary: boolean }> {
    const rel = cleanDrivePath(p);
    return this.lock.run(dir_id, async () => {
      const d = this.dirs(dir_id);
      // Same answer for a missing path and a hidden one: nothing to learn from the error.
      const got = await safeRead(d.upper, rel, READ_CAP);
      if (!got) throw new ToolError('not_found', `/drive/${rel} does not exist in this session`);
      const binary = got.data.subarray(0, 8192).includes(0);
      const base = get<{ item_id: string }>(this.drive.db, 'SELECT item_id FROM session_base WHERE dir_id = ? AND path = ?', dir_id, rel);
      const text = binary ? '' : got.data.toString('utf8');
      this.drive.activity({ dir_id, actor: 'agent', op: 'read', item_id: base?.item_id ?? null, bytes: text.length, detail: { path: rel } });
      return { path: `/drive/${rel}`, text, size: got.size, truncated: got.size > READ_CAP, binary };
    });
  }

  async write(dir_id: string, p: string, content: string): Promise<{ path: string; bytes: number }> {
    const rel = cleanDrivePath(p);
    if (Buffer.byteLength(content) > WRITE_CAP) throw new ToolError('too_large', 'write is for small text files; use run for larger ones');
    return this.lock.run(dir_id, async () => {
      const d = this.dirs(dir_id);
      await safeWrite(d.upper, rel, content);
      this.drive.activity({ dir_id, actor: 'agent', op: 'write', detail: { path: rel, bytes: Buffer.byteLength(content) } });
      return { path: `/drive/${rel}`, bytes: Buffer.byteLength(content) };
    });
  }

  search(dir_id: string, query: string): { results: { path: string; snippet: string; note?: string }[]; hidden: Record<string, number> } {
    const db = this.drive.db;
    const view = new Map(all<{ item_id: string; path: string }>(db, 'SELECT item_id, path FROM session_view WHERE dir_id = ?', dir_id).map((r) => [r.item_id, r.path]));
    const results: { path: string; snippet: string; note?: string }[] = [];
    const hidden: Record<string, number> = {};
    for (const hit of this.drive.searchRaw(query)) {
      const vp = view.get(hit.item_id);
      if (vp) {
        results.push({ path: `/drive/${vp}`, snippet: hit.snippet });
        continue;
      }
      const reach: ViewEntry | null = this.drive.reachable(hit.item_id);
      if (reach) {
        results.push({ path: `/drive/${reach.path}`, snippet: hit.snippet, note: 'new since this session began; it appears in /drive after your next checkpoint' });
        continue;
      }
      const it = this.drive.item(hit.item_id);
      if (!it || it.state !== 'live') continue;
      for (const ring of this.drive.hidingRings(hit.item_id)) hidden[ring] = (hidden[ring] ?? 0) + 1;
    }
    this.drive.activity({ dir_id, actor: 'agent', op: 'search', bytes: results.reduce((n, r) => n + r.snippet.length, 0), detail: { query: query.slice(0, 500), results: results.length, hidden } });
    return { results: results.slice(0, 50), hidden };
  }

  async destroySandbox(dir_id: string): Promise<void> {
    await this.sandbox.destroy(this.sandboxId(dir_id));
  }

  /** Stop every sandbox this server's prefix owns (shutdown, tests). */
  async destroyAll(): Promise<void> {
    for (const id of await this.sandbox.list()) await this.sandbox.destroy(id);
  }

  async removeDirs(dir_id: string): Promise<void> {
    await fsp.rm(this.dirs(dir_id).root, { recursive: true, force: true });
  }
}
