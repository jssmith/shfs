// One fresh drive per run: its own data directory, port and sandbox prefix,
// the synthetic corpus uploaded and ring-checked, a direct MCP connection for
// the client. Read-only views of the store for the checks (the drive's SQLite
// file and blobs, opened read-only), independent of the MCP surface variant.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, createWriteStream, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const OWNER_PASSWORD = 'a6-synthetic-pw';

export interface DriveOptions {
  runDir: string;
  port: number;
  prefix: string; // sandbox name prefix, e.g. a6-r03-
  surface: string; // AGENT_DRIVE_SURFACE
  serverRoot: string; // a checkout with server/dist and cli/dist built
  corpusDir: string; // a folder made by make-sessions-corpus.sh (uploaded as household/)
  rootfs: string;
  runsc: string;
  connectionName: string;
}

export interface Drive {
  url: string;
  mcpUrl: string;
  dataDir: string;
  token: string;
  cookie: string;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cli(o: DriveOptions, dataDir: string, args: string[], input?: string): string {
  return execFileSync('node', [join(o.serverRoot, 'server/dist/main.js'), ...args], {
    env: { ...process.env, AGENT_DRIVE_DATA: dataDir, AGENT_DRIVE_PORT: String(o.port) },
    input: input ?? '', encoding: 'utf8',
  });
}

export async function startDrive(o: DriveOptions): Promise<Drive> {
  const dataDir = join(o.runDir, 'data');
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  cli(o, dataDir, ['owner', 'set-password'], `${OWNER_PASSWORD}\n`);
  const device = cli(o, dataDir, ['device', 'add', 'a6-uploader']).split('\n')[1]!.trim();
  const conn = JSON.parse(cli(o, dataDir, ['connection', 'add', o.connectionName])) as { access_token: string };

  const log = createWriteStream(join(o.runDir, 'server.log'));
  const proc: ChildProcess = spawn('node', [join(o.serverRoot, 'server/dist/main.js'), 'serve'], {
    env: {
      ...process.env,
      AGENT_DRIVE_DATA: dataDir, AGENT_DRIVE_PORT: String(o.port), AGENT_DRIVE_SURFACE: o.surface,
      AGENT_DRIVE_RUNSC: o.runsc, AGENT_DRIVE_ROOTFS: o.rootfs, AGENT_DRIVE_SANDBOX_PREFIX: o.prefix,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.pipe(log);
  proc.stderr!.pipe(log);
  const url = `http://localhost:${o.port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/healthz`)).ok) break; } catch { /* not yet */ }
    if (i > 100 || proc.exitCode !== null) throw new Error(`drive on :${o.port} did not start; see ${o.runDir}/server.log`);
    await sleep(100);
  }
  execFileSync('node', [join(o.serverRoot, 'cli/dist/index.js'), 'put', o.corpusDir], {
    env: { ...process.env, AGENT_DRIVE_URL: url, AGENT_DRIVE_TOKEN: device }, encoding: 'utf8',
  });
  // Wait for the ring check to finish on every uploaded version.
  for (let i = 0; ; i++) {
    const pending = store(dataDir).pendingChecks();
    if (pending === 0) break;
    if (i > 300) throw new Error('ring check did not finish');
    await sleep(100);
  }
  const login = await fetch(`${url}/login`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'owner', password: OWNER_PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`owner sign-in failed: ${login.status}`);

  return {
    url, mcpUrl: `${url}/mcp`, dataDir, token: conn.access_token, cookie,
    async stop() {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
        for (let i = 0; i < 100 && proc.exitCode === null; i++) await sleep(100);
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }
      // Belt and braces: no sandbox with this run's prefix may outlive the run.
      try {
        const root = join(dataDir, 'runsc');
        const list = execFileSync(o.runsc, ['--root', root, 'list', '-quiet'], { encoding: 'utf8' }).split('\n').filter((n) => n.startsWith(o.prefix));
        for (const n of list) execFileSync(o.runsc, ['--root', root, 'delete', '-force', n]);
      } catch { /* no state root */ }
    },
  };
}

export type Call = {
  id: number; ts: string; client_name: string | null; registered_name: string | null; transport_session_id: string | null;
  tool: string; dir_id: string | null; session_arg: string | null; transport_changed: number; gap_session_ms: number | null;
  duration_ms: number | null; ok: number; error_reason: string | null;
};

export async function debugCalls(d: Drive): Promise<Call[]> {
  const r = await fetch(`${d.url}/api/debug/calls?limit=5000`, { headers: { cookie: d.cookie } });
  if (!r.ok) throw new Error(`/api/debug/calls: ${r.status}`);
  return ((await r.json()) as { calls: Call[] }).calls.sort((a, b) => a.id - b.id);
}

export interface FileView { path: string; item_id: string; text: string | null; rings: string[] }

/** Read-only views of a drive's store. */
export function store(dataDir: string) {
  const dbPath = join(dataDir, 'drive.db');
  const open = () => new DatabaseSync(dbPath, { readOnly: true });
  const q = <T>(sql: string, ...p: (string | number)[]): T[] => {
    const db = open();
    try { return db.prepare(sql).all(...p) as T[]; } finally { db.close(); }
  };
  const blob = (hash: string) => readFileSync(join(dataDir, 'blobs', hash.slice(0, 2), hash));
  return {
    pendingChecks(): number {
      if (!existsSync(dbPath)) return 1;
      return q<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'")[0]!.n
        + q<{ n: number }>("SELECT COUNT(*) AS n FROM item_versions WHERE ring_check = 'pending'")[0]!.n;
    },
    /** Live files of the shared drive (what the person sees), text decoded when small. */
    files(): Map<string, FileView> {
      const rows = q<{ path: string; item_id: string; blob_hash: string; size: number; rings: string }>(
        `SELECT i.path, i.item_id, v.blob_hash, v.size, v.rings FROM items i JOIN item_versions v ON v.item_id = i.item_id AND v.version = i.current_version WHERE i.state = 'live'`);
      return new Map(rows.map((r) => [r.path, { path: r.path, item_id: r.item_id, rings: JSON.parse(r.rings) as string[], text: r.size < 512 * 1024 ? blob(r.blob_hash).toString('utf8') : null }]));
    },
    packages(): { pkg_id: string; kind: string; summary_claimed: string | null; operations: string; created_at: string }[] {
      return q("SELECT rowid AS n, pkg_id, kind, summary_claimed, operations, created_at FROM packages ORDER BY rowid");
    },
    sessions(): { dir_id: string; purpose: string; status: string; created_at: string; last_call_at: string }[] {
      return q('SELECT dir_id, purpose, status, created_at, last_call_at FROM sessions ORDER BY created_at');
    },
  };
}

/** Write the shared drive's live files under `dest` (ringed items left out), for running tests. */
export function materialize(files: Map<string, FileView>, dest: string, prefix = ''): void {
  rmSync(dest, { recursive: true, force: true });
  for (const f of files.values()) {
    if (!f.path.startsWith(prefix) || f.rings.length || f.text === null) continue;
    const p = join(dest, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.text);
  }
}
