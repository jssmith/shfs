// Sessions: the secret id, the working space and its view, and the tools
// that act inside it. The working space is the materialised fallback of
// docs/contracts.md §2: the server writes `sessions/<dir_id>/upper/` from the
// session's view itself and mounts it at /drive.
import { mkdirSync, promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { all, get, run, tx } from '../store/db.js';
import type { Drive } from '../store/drive.js';
import { searchSession, hiddenCountsOf, type SearchResult } from './search.js';
import { cleanDrivePath, safeHash, safeRead, safeRemove, safeWrite, walkFiles } from '../util/fsafe.js';
import { newId, newSessionId, now, secretHash, SESSION_ID_RE } from '../util/ids.js';
import { KeyedMutex } from '../util/mutex.js';
import type { Sandbox } from './sandbox.js';
import { isToolCache } from '../merge/ignore.js';
import { chownTree } from './image.js';
import { SessionSocket } from './socket.js';
import { fileURLToPath } from 'node:url';

export const OUTPUT_CAP = 64 * 1024;
export const READ_CAP = 256 * 1024;
export const WRITE_CAP = 4 * 1024 * 1024;
/** How much of a file the shell surfaces' read tool loads (it then pages by lines). */
export const FILE_TOOL_CAP = 16 * 1024 * 1024;

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

export interface SessionDirs { root: string; upper: string; work: string; state: string; sock: string }

/** Handles one `drive` command from inside a session's sandbox (v2, v3; sessions/drive-command.ts). */
export type DriveCommandHandler = (dir_id: string, argv: string[]) => Promise<{ stdout: string; stderr?: string; exit: number }>;

/** Where the drive command lives on the host, mounted read-only into sandboxes at /opt/drive/bin. */
export const DRIVE_BIN_DIR = fileURLToPath(new URL('../../../sandbox/bin/', import.meta.url));

export class Sessions {
  readonly lock = new KeyedMutex();
  /** Set on the shell surfaces: sandboxes then get the drive command and a socket to answer it. */
  driveCommand?: DriveCommandHandler;
  private sockets = new Map<string, SessionSocket>();
  /** Sessions with a command running (holding the lock), and work done on its behalf meanwhile. */
  private leases = new Map<string, Set<Promise<unknown>>>();
  private nested = new KeyedMutex();

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
    return { root, upper: path.join(root, 'upper'), work: path.join(root, 'work'), state: path.join(root, 'state'), sock: path.join(root, 'sock') };
  }

  /**
   * Run `fn` holding the session's lock. While a command holds it (run), the
   * drive command inside that command must not wait for it: such work runs
   * under the command's hold instead, one at a time, and the command does not
   * release the lock before it is done.
   */
  async underLock<T>(dir_id: string, fn: () => Promise<T>): Promise<T> {
    const lease = this.leases.get(dir_id);
    if (!lease) return this.lock.run(dir_id, fn);
    const p = this.nested.run(dir_id, fn);
    lease.add(p);
    try {
      return await p;
    } finally {
      lease.delete(p);
    }
  }

  /** The socket the session's drive command talks to; started with its sandbox. */
  private async ensureSocket(dir_id: string): Promise<SessionSocket | null> {
    const handler = this.driveCommand;
    if (!handler) return null;
    const have = this.sockets.get(dir_id);
    if (have) return have;
    const u = this.sandbox.user ?? { uid: 0, gid: 0 };
    const sock = await SessionSocket.listen(this.dirs(dir_id).sock, u, (argv) => {
      const row = this.byDir(dir_id);
      if (!row || row.status === 'finished' || row.status === 'stopped' || row.status === 'paused')
        return Promise.resolve({ stdout: '', stderr: `drive: this session is ${row?.status ?? 'gone'}\n`, exit: 1 });
      return handler(dir_id, argv);
    });
    this.sockets.set(dir_id, sock);
    return sock;
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

  async run(dir_id: string, command: string, timeoutSec: number, opts: { shell?: 'sh' | 'bash' } = {}): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; fullOutput?: string }> {
    return this.lock.run(dir_id, async () => {
      const d = this.dirs(dir_id);
      const id = this.sandboxId(dir_id);
      // A non-root sandbox user must own what the host wrote into /drive and /work.
      const u = this.sandbox.user;
      if (u && u.uid !== 0) {
        await chownTree(d.upper, u.uid, u.gid);
        await chownTree(d.work, u.uid, u.gid);
      }
      const sock = await this.ensureSocket(dir_id);
      await this.sandbox.create({
        id, driveDir: d.upper, workDir: d.work, stateDir: d.state,
        ...(sock ? { readOnlyMounts: [{ source: DRIVE_BIN_DIR, destination: '/opt/drive/bin' }, { source: d.sock, destination: '/run/drive' }], hostSockets: true, pathPrefix: '/opt/drive/bin' } : {}),
      });
      const t0 = Date.now();
      const lease = new Set<Promise<unknown>>();
      this.leases.set(dir_id, lease);
      let r;
      try {
        r = await this.sandbox.exec(id, command, { timeoutMs: Math.round(timeoutSec * 1000), shell: opts.shell });
      } finally {
        // Work the command started through the drive command finishes before the lock goes.
        while (lease.size) await Promise.allSettled([...lease]);
        this.leases.delete(dir_id);
      }
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

  /**
   * A path as the shell tools take it: under /drive (absolute, or relative to
   * /drive) or under /work. Anything else is invalid_path.
   */
  resolvePath(p: string): { where: 'drive' | 'work'; rel: string; shown: string } {
    const s = p.replace(/\\/g, '/').trim();
    if (s === '/work' || s.startsWith('/work/')) {
      const rel = cleanDrivePath(s.slice('/work'.length));
      return { where: 'work', rel, shown: `/work/${rel}` };
    }
    if (s.startsWith('/') && !(s === '/drive' || s.startsWith('/drive/'))) throw new Error('invalid_path: read, write and edit work on files under /drive and /work; use bash for anything else');
    const rel = cleanDrivePath(s);
    return { where: 'drive', rel, shown: `/drive/${rel}` };
  }

  private rootOf(dir_id: string, where: 'drive' | 'work'): string {
    const d = this.dirs(dir_id);
    return where === 'drive' ? d.upper : d.work;
  }

  /** Read a file under /drive or /work, up to `cap` bytes. Missing and hidden read the same. */
  async readAny(dir_id: string, p: string, cap = FILE_TOOL_CAP): Promise<{ shown: string; data: Buffer; size: number; binary: boolean }> {
    const r = this.resolvePath(p);
    return this.lock.run(dir_id, async () => {
      const got = await safeRead(this.rootOf(dir_id, r.where), r.rel, cap);
      if (!got) throw new ToolError('not_found', `${r.shown} does not exist in this session`);
      const base = r.where === 'drive' ? get<{ item_id: string }>(this.drive.db, 'SELECT item_id FROM session_base WHERE dir_id = ? AND path = ?', dir_id, r.rel) : undefined;
      this.drive.activity({ dir_id, actor: 'agent', op: 'read', item_id: base?.item_id ?? null, bytes: got.data.length, detail: { path: r.shown } });
      return { shown: r.shown, data: got.data, size: got.size, binary: got.data.subarray(0, 8192).includes(0) };
    });
  }

  /** Write a file under /drive or /work (creating folders). */
  async writeAny(dir_id: string, p: string, content: string): Promise<{ shown: string; where: 'drive' | 'work'; rel: string; bytes: number }> {
    const r = this.resolvePath(p);
    const bytes = Buffer.byteLength(content);
    if (bytes > WRITE_CAP) throw new ToolError('too_large', `write takes up to ${WRITE_CAP / 1024 / 1024} MB; this content is ${bytes} bytes`);
    return this.lock.run(dir_id, async () => {
      await safeWrite(this.rootOf(dir_id, r.where), r.rel, content);
      this.drive.activity({ dir_id, actor: 'agent', op: 'write', detail: { path: r.shown, bytes } });
      return { ...r, bytes };
    });
  }

  /** Replace exact text in a file; old_string must be unique unless replaceAll. */
  async editFile(dir_id: string, p: string, oldStr: string, newStr: string, replaceAll: boolean): Promise<{ shown: string; where: 'drive' | 'work'; rel: string; count: number; text: string; at: number }> {
    const r = this.resolvePath(p);
    if (!oldStr) throw new ToolError('edit_no_match', 'old_string is empty');
    if (oldStr === newStr) throw new ToolError('edit_no_change', 'old_string and new_string are the same');
    return this.lock.run(dir_id, async () => {
      const root = this.rootOf(dir_id, r.where);
      const got = await safeRead(root, r.rel, WRITE_CAP + 1);
      if (!got) throw new ToolError('not_found', `${r.shown} does not exist in this session`);
      if (got.size > WRITE_CAP) throw new ToolError('too_large', `${r.shown} is ${got.size} bytes; edit takes files up to ${WRITE_CAP / 1024 / 1024} MB`);
      if (got.data.subarray(0, 8192).includes(0)) throw new ToolError('binary_file', `${r.shown} is a binary file`);
      const text = got.data.toString('utf8');
      let count = 0;
      for (let i = text.indexOf(oldStr); i >= 0; i = text.indexOf(oldStr, i + oldStr.length)) count++;
      if (count === 0) throw new ToolError('edit_no_match', `old_string was not found in ${r.shown}`);
      if (count > 1 && !replaceAll) throw new ToolError('edit_not_unique', `old_string appears ${count} times in ${r.shown}`);
      const at = text.indexOf(oldStr);
      const out = replaceAll ? text.split(oldStr).join(newStr) : text.slice(0, at) + newStr + text.slice(at + oldStr.length);
      await safeWrite(root, r.rel, out);
      this.drive.activity({ dir_id, actor: 'agent', op: 'edit', detail: { path: r.shown, replaced: replaceAll ? count : 1 } });
      return { ...r, count: replaceAll ? count : 1, text: out, at };
    });
  }

  /** A cheap fingerprint of /drive (paths, sizes, modification times; tool caches left out): did a command change anything? */
  async driveStamp(dir_id: string): Promise<string> {
    const h = createHash('sha256');
    const root = this.dirs(dir_id).upper;
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (isToolCache(e.isDirectory() ? `${r}/x` : r)) continue;
        const st = await fsp.lstat(path.join(dir, e.name)).catch(() => null);
        if (!st) continue;
        h.update(`${r}\0${st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'o'}\0${st.size}\0${st.mtimeMs}\n`);
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      }
    };
    await walk(root, '');
    return h.digest('hex');
  }

  /** Search what this session can see; hidden items match on metadata only (sessions/search.ts). */
  search(dir_id: string, query: string): SearchResult {
    const r = searchSession(this.drive, dir_id, query);
    this.drive.activity({
      dir_id, actor: 'agent', op: 'search',
      bytes: r.results.slice(0, 50).reduce((n, x) => n + x.snippet.length, 0),
      detail: { query: query.slice(0, 500), results: r.results.length, hidden: hiddenCountsOf(r.hidden) },
    });
    return r;
  }

  async destroySandbox(dir_id: string): Promise<void> {
    await this.sandbox.destroy(this.sandboxId(dir_id));
    await this.sockets.get(dir_id)?.close();
    this.sockets.delete(dir_id);
  }

  /** Stop every sandbox this server's prefix owns, and every session socket (shutdown, tests). */
  async destroyAll(): Promise<void> {
    for (const id of await this.sandbox.list()) await this.sandbox.destroy(id);
    for (const s of this.sockets.values()) await s.close();
    this.sockets.clear();
  }

  /** Start the session's socket without a sandbox (tests). */
  async socketFor(dir_id: string): Promise<string | null> {
    return (await this.ensureSocket(dir_id))?.path ?? null;
  }

  async removeDirs(dir_id: string): Promise<void> {
    await fsp.rm(this.dirs(dir_id).root, { recursive: true, force: true });
  }
}
