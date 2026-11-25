// gVisor sandboxes through runsc: read-only root from an image directory,
// no network, /drive and /work bind-mounted, tmpfs /tmp. Systrap platform.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ExecResult, Sandbox, SandboxSpec } from './sandbox.js';

export interface RunscOptions {
  runsc: string; // path to the runsc binary
  stateRoot: string; // runsc --root
  rootfs: string; // read-only root file system directory (never modified)
  prefix: string; // sandbox name prefix, e.g. 'ad-'
  memoryBytes?: number;
}

const MAX_CAPTURE = 16 * 1024 * 1024;

function spawnCollect(cmd: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outN = 0;
    let errN = 0;
    let timedOut = false;
    child.stdout.on('data', (b: Buffer) => {
      if (outN < MAX_CAPTURE) out.push(b);
      outN += b.length;
    });
    child.stderr.on('data', (b: Buffer) => {
      if (errN < MAX_CAPTURE) err.push(b);
      errN += b.length;
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? (signal ? 128 + 9 : 1), stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
  });
}

export class RunscSandbox implements Sandbox {
  constructor(private o: RunscOptions) {
    mkdirSync(o.stateRoot, { recursive: true });
  }

  private base(): string[] {
    return [`--root=${this.o.stateRoot}`];
  }

  private config(spec: SandboxSpec): object {
    const caps = ['CAP_AUDIT_WRITE', 'CAP_KILL', 'CAP_NET_BIND_SERVICE', 'CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_FOWNER', 'CAP_SETUID', 'CAP_SETGID'];
    return {
      ociVersion: '1.0.0',
      process: {
        user: { uid: 0, gid: 0 },
        args: ['sleep', 'infinity'],
        env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'TERM=xterm', 'HOME=/work', 'LANG=C.UTF-8'],
        cwd: '/drive',
        capabilities: { bounding: caps, effective: caps, inheritable: caps, permitted: caps },
        rlimits: [{ type: 'RLIMIT_NOFILE', hard: 4096, soft: 4096 }],
        noNewPrivileges: true,
        terminal: false,
      },
      root: { path: this.o.rootfs, readonly: true },
      hostname: 'drive',
      mounts: [
        { destination: '/proc', type: 'proc', source: 'proc' },
        { destination: '/dev', type: 'tmpfs', source: 'tmpfs' },
        { destination: '/sys', type: 'sysfs', source: 'sysfs', options: ['nosuid', 'noexec', 'nodev', 'ro'] },
        { destination: '/drive', type: 'bind', source: spec.driveDir, options: ['rbind', 'rw'] },
        { destination: '/work', type: 'bind', source: spec.workDir, options: ['rbind', 'rw'] },
        { destination: '/tmp', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'nodev', 'size=536870912'] },
      ],
      linux: {
        namespaces: [{ type: 'pid' }, { type: 'network' }, { type: 'ipc' }, { type: 'uts' }, { type: 'mount' }],
      },
    };
  }

  async state(id: string): Promise<string | null> {
    const r = await spawnCollect(this.o.runsc, [...this.base(), 'state', id], { timeoutMs: 10000 });
    if (r.exitCode !== 0) return null;
    try {
      return (JSON.parse(r.stdout.toString()) as { status: string }).status;
    } catch {
      return null;
    }
  }

  async create(spec: SandboxSpec): Promise<void> {
    if (!spec.id.startsWith(this.o.prefix)) throw new Error('sandbox id must carry the prefix');
    const st = await this.state(spec.id);
    if (st === 'running') return;
    if (st) await this.destroy(spec.id);
    if (!existsSync(this.o.rootfs)) throw new Error(`sandbox image missing: ${this.o.rootfs}`);
    const bundle = path.join(spec.stateDir, 'bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, 'config.json'), JSON.stringify(this.config(spec), null, 1));
    // Detached sandboxes get files for stdio, never pipes: checkpoint/restore needs that.
    const logFd = openSync(path.join(spec.stateDir, 'sandbox.log'), 'a');
    const nullFd = openSync('/dev/null', 'r');
    try {
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(
          this.o.runsc,
          [...this.base(), '--network=none', '--platform=systrap', '--file-access-mounts=shared', 'run', '-detach', '-bundle', bundle, spec.id],
          { stdio: [nullFd, logFd, logFd] },
        );
        child.on('error', reject);
        child.on('close', (c) => resolve(c ?? 1));
      });
      if (code !== 0) throw new Error(`runsc run failed (exit ${code}); see ${path.join(spec.stateDir, 'sandbox.log')}`);
    } finally {
      closeSync(logFd);
      closeSync(nullFd);
    }
  }

  async exec(id: string, command: string, opts: { timeoutMs: number; stdin?: string; cwd?: string }): Promise<ExecResult> {
    const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    // `timeout` inside the sandbox kills the command; the host-side timer is a backstop.
    const args = [...this.base(), 'exec', '--cwd', opts.cwd ?? '/drive', id, 'timeout', '-s', 'KILL', String(secs), 'sh', '-c', command];
    const r = await spawnCollect(this.o.runsc, args, { stdin: opts.stdin, timeoutMs: opts.timeoutMs + 5000 });
    if (r.exitCode === 137 && !r.timedOut) r.timedOut = true;
    return r;
  }

  async destroy(id: string): Promise<void> {
    await spawnCollect(this.o.runsc, [...this.base(), 'kill', id, 'KILL'], { timeoutMs: 10000 }).catch(() => undefined);
    await spawnCollect(this.o.runsc, [...this.base(), 'delete', '--force', id], { timeoutMs: 20000 }).catch(() => undefined);
  }

  /** runsc leaves an nsfs mount for --network=none in its state root; release it on shutdown. */
  async releaseRoot(): Promise<void> {
    if (!existsSync(path.join(this.o.stateRoot, 'null-netns'))) return;
    if ((await this.list()).length) return;
    await spawnCollect('umount', [path.join(this.o.stateRoot, 'null-netns')], { timeoutMs: 10000 }).catch(() => undefined);
  }

  async list(): Promise<string[]> {
    const r = await spawnCollect(this.o.runsc, [...this.base(), 'list', '-quiet'], { timeoutMs: 10000 }).catch(() => null);
    if (!r || r.exitCode !== 0) return [];
    return r.stdout
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(this.o.prefix));
  }
}
