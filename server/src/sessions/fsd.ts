// The session file system daemon (fs/, `agent-drive-fs`), for AGENT_DRIVE_FS=daemon:
// one `agent-drive-fs mount` per session while its sandbox runs, the control socket
// (docs/contracts.md §2), and the subcommands the server uses to reach upper/ without
// following anything the session put there (risk R14; Node has no openat2).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, promises as fsp } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { MERGE_IGNORE } from '../merge/ignore.js';
import { KeyedMutex } from '../util/mutex.js';

export type FsMode = 'copy' | 'daemon';

export function parseFsMode(v: string | undefined): FsMode {
  const s = (v ?? 'copy').trim() || 'copy';
  if (s !== 'copy' && s !== 'daemon') throw new Error(`AGENT_DRIVE_FS must be copy or daemon; got "${s}"`);
  return s;
}

/** One entry of `agent-drive-fs export`: a name in upper/. */
export interface UpperEntry {
  path: string;
  type: 'f' | 'd' | 'l' | 'o';
  size: number;
  mode: number;
  mtime_ns: string;
  /** Regular files that are not tool caches, when hashed or copied. */
  sha256?: string;
  /** A tool cache (merge/ignore.ts): never hashed or copied. */
  ignored?: boolean;
}

export interface UpperManifest {
  entries: UpperEntry[];
  /** Complete lines of `whiteouts`: paths the session deleted or renamed away. */
  whiteouts: string[];
}

/** An export with copies: the regular files of upper/, in a directory only the server can reach. */
export interface UpperCopy extends UpperManifest {
  dir: string;
  dispose(): Promise<void>;
}

/** The request `agent-drive-fs rebase` and the control socket take (fs/src/maintain.rs). */
export interface RebaseRequest {
  remove?: { path: string; sha256: string }[];
  drop_whiteouts?: string[];
  unwhite?: string[];
}

interface Run {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function runBin(bin: string, args: string[], input?: Buffer | string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

async function runOk(bin: string, args: string[], input?: Buffer | string): Promise<Buffer> {
  const r = await runBin(bin, args, input);
  if (r.code !== 0) throw new Error(`agent-drive-fs ${args[0]} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`);
  return r.stdout;
}

/** One line to the control socket and its reply; null when no daemon is listening. */
function control(sock: string, line: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = '';
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error(`no answer on ${sock} within ${timeoutMs} ms`));
    }, timeoutMs);
    c.setEncoding('utf8');
    c.on('connect', () => c.write(`${line}\n`));
    c.on('data', (d: string) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      c.end();
      resolve(buf.slice(0, i));
    });
    c.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') resolve(null);
      else reject(e);
    });
  });
}

/**
 * After an epoch bump: ask the session's daemon to apply the view now (`refresh`, answered
 * with `ok <epoch>` once the kernel has dropped stale entries). Returns the epoch, or null
 * when no daemon runs for the session (nothing to do, as in copy mode).
 */
export async function requestRefresh(sock: string, timeoutMs = 5000): Promise<number | null> {
  const r = await control(sock, 'refresh', timeoutMs);
  if (r === null) return null;
  const m = /^ok (\d+)/.exec(r);
  if (!m) throw new Error(`refresh: ${r}`);
  return Number(m[1]);
}

/** Mount points under this host's mount table (for stale mounts after a crash). */
function isMounted(dir: string): boolean {
  try {
    const want = path.resolve(dir);
    return readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n')
      .some((l) => l.split(' ')[4]?.replace(/\\040/g, ' ') === want);
  } catch {
    return false;
  }
}

async function lazyUnmount(dir: string): Promise<void> {
  if (!isMounted(dir)) return;
  const r = await runBin('fusermount3', ['-u', '-z', dir]).catch(() => null);
  if ((!r || r.code !== 0) && isMounted(dir)) await runBin('umount', ['-l', dir]).catch(() => null);
}

interface Proc {
  child: ChildProcess;
  mnt: string;
  exited: Promise<void>;
  alive: boolean;
}

/** The daemons of one server: one per session with a running sandbox, plus the subcommands. */
export class FsDaemons {
  private procs = new Map<string, Proc>();
  /** Starting, stopping and on-disk rebases of one session, one at a time: a daemon that starts reads whiteouts, which an on-disk rebase replaces. */
  private life = new KeyedMutex();

  constructor(
    readonly bin: string,
    readonly dataDir: string,
    /** For the daemon's process name. */
    readonly prefix: string,
  ) {}

  private sessionDir(dir_id: string): string {
    return path.join(this.dataDir, 'sessions', dir_id);
  }

  mnt(dir_id: string): string {
    return path.join(this.sessionDir(dir_id), 'mnt');
  }

  controlSock(dir_id: string): string {
    return path.join(this.sessionDir(dir_id), 'control.sock');
  }

  running(dir_id: string): boolean {
    return this.procs.get(dir_id)?.alive ?? false;
  }

  /** True if a daemon for this session ran and died (its sandbox's /drive is gone). */
  died(dir_id: string): boolean {
    const p = this.procs.get(dir_id);
    return !!p && !p.alive;
  }

  /**
   * Start the session's daemon and wait until its mount is live. Kernel caching on (60 s
   * timeouts, decision 0003), invalidated on every view change through the control socket.
   * `owner`: the sandbox's user, for store items and everything created in upper/.
   */
  async start(dir_id: string, owner?: { uid: number; gid: number }): Promise<void> {
    if (this.running(dir_id)) return;
    await this.life.run(dir_id, () => this.startNow(dir_id, owner));
  }

  private async startNow(dir_id: string, owner?: { uid: number; gid: number }): Promise<void> {
    if (this.running(dir_id)) return;
    this.procs.delete(dir_id);
    const mnt = this.mnt(dir_id);
    await lazyUnmount(mnt);
    mkdirSync(mnt, { recursive: true });
    const args = [
      'mount', '--data', this.dataDir, '--dir-id', dir_id,
      '--entry-timeout-ms', '60000', '--attr-timeout-ms', '60000',
      '--name', `${this.prefix}fs`.slice(0, 15), '--exit-with-parent',
      ...(owner && owner.uid !== 0 ? ['--uid', String(owner.uid), '--gid', String(owner.gid)] : []),
    ];
    const child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (b: Buffer) => {
      if (stderr.length < 8192) stderr += b.toString();
    });
    const p: Proc = { child, mnt, alive: true, exited: new Promise((res) => child.on('close', () => res())) };
    child.on('close', () => {
      p.alive = false;
    });
    this.procs.set(dir_id, p);
    await new Promise<void>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => fail(new Error('agent-drive-fs mount: not mounted within 10 s')), 10_000);
      const fail = (e: Error) => {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(e);
      };
      child.on('error', fail);
      child.on('close', (code) => fail(new Error(`agent-drive-fs mount exited (${code}): ${stderr.trim().slice(0, 500)}`)));
      child.stdout!.on('data', (b: Buffer) => {
        out += b.toString();
        if (out.includes('mounted ')) {
          clearTimeout(timer);
          resolve();
        }
      });
    }).catch(async (e) => {
      this.procs.delete(dir_id);
      await lazyUnmount(mnt);
      throw e;
    });
    child.stdout!.resume();
  }

  /** Stop the session's daemon (it unmounts itself); force it after 5 s. */
  async stop(dir_id: string): Promise<void> {
    await this.life.run(dir_id, () => this.stopNow(dir_id));
  }

  private async stopNow(dir_id: string): Promise<void> {
    const p = this.procs.get(dir_id);
    this.procs.delete(dir_id);
    if (p?.alive) {
      p.child.kill('SIGTERM');
      const t = setTimeout(() => p.child.kill('SIGKILL'), 5000);
      await p.exited;
      clearTimeout(t);
    }
    await lazyUnmount(this.mnt(dir_id));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((d) => this.stop(d)));
  }

  /** Metadata of upper/ (`hash`: with the sha256 of every regular file that is not a tool cache). */
  async manifest(dir_id: string, opts: { hash?: boolean } = {}): Promise<UpperManifest> {
    const out = await runOk(this.bin, ['export', '--data', this.dataDir, '--dir-id', dir_id, '--ignore', JSON.stringify(MERGE_IGNORE), ...(opts.hash ? ['--hash'] : [])]);
    return JSON.parse(out.toString()) as UpperManifest;
  }

  /** Copies of upper/'s regular files (tool caches left out) in the session's state directory, which no sandbox mounts. */
  async copy(dir_id: string): Promise<UpperCopy> {
    const state = path.join(this.sessionDir(dir_id), 'state');
    mkdirSync(state, { recursive: true });
    const dir = path.join(state, `export-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const out = await runOk(this.bin, ['export', '--data', this.dataDir, '--dir-id', dir_id, '--ignore', JSON.stringify(MERGE_IGNORE), '--out', dir]).catch(async (e) => {
      await fsp.rm(dir, { recursive: true, force: true });
      throw e;
    });
    const m = JSON.parse(out.toString()) as UpperManifest;
    return { ...m, dir, dispose: () => fsp.rm(dir, { recursive: true, force: true }) };
  }

  /** A file as the session sees it (upper/, else the view's blob unless whited out), up to `max` bytes. */
  async read(dir_id: string, rel: string, max: number, opts: { upperOnly?: boolean } = {}): Promise<{ data: Buffer; size: number; from: 'upper' | 'store' } | null> {
    const out = await runOk(this.bin, ['read', '--data', this.dataDir, '--dir-id', dir_id, '--path', rel, '--max', String(max), ...(opts.upperOnly ? ['--upper-only'] : [])]);
    const nl = out.indexOf(0x0a);
    const head = JSON.parse(out.subarray(0, nl).toString()) as { found: boolean; size?: number; from?: 'upper' | 'store' };
    if (!head.found) return null;
    return { data: out.subarray(nl + 1), size: head.size ?? 0, from: head.from ?? 'upper' };
  }

  /** Write a file into the session's mount (the daemon must run): copy-up, whiteouts and ownership are the daemon's. */
  async write(dir_id: string, rel: string, data: Buffer | string): Promise<void> {
    if (!this.running(dir_id)) throw new Error('agent-drive-fs: no daemon for this session');
    await runOk(this.bin, ['write', '--root', this.mnt(dir_id), '--path', rel], typeof data === 'string' ? Buffer.from(data) : data);
  }

  /** Apply a rebase request: by the running daemon, or on disk when none runs. */
  async rebase(dir_id: string, req: RebaseRequest): Promise<void> {
    if (!req.remove?.length && !req.drop_whiteouts?.length && !req.unwhite?.length) return;
    const json = JSON.stringify(req);
    await this.life.run(dir_id, async () => {
      if (this.running(dir_id)) {
        const r = await control(this.controlSock(dir_id), `rebase ${json}`, 30_000);
        if (r !== null) {
          if (!r.startsWith('ok ')) throw new Error(`rebase: ${r}`);
          return;
        }
      }
      await runOk(this.bin, ['rebase', '--data', this.dataDir, '--dir-id', dir_id], json);
    });
  }
}

/** The daemon binary: AGENT_DRIVE_FS_BIN, else `agent-drive-fs` on PATH. */
export function fsBinFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_DRIVE_FS_BIN || 'agent-drive-fs';
}

/** For tests: the checkout's own build when no binary is given. */
export function testFsBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_DRIVE_FS_BIN) return env.AGENT_DRIVE_FS_BIN;
  const fsDir = new URL('../../../fs/target/', import.meta.url).pathname;
  for (const p of ['release/agent-drive-fs', 'debug/agent-drive-fs']) if (existsSync(path.join(fsDir, p))) return path.join(fsDir, p);
  return 'agent-drive-fs';
}
