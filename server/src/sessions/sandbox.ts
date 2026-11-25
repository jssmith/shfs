// One sandbox per session. The runsc implementation is in runsc.ts; tests
// that do not need a real shell use DirSandbox (host-side, no exec).

export interface SandboxSpec {
  id: string; // e.g. ad-<dir_id>
  driveDir: string; // host directory mounted at /drive
  workDir: string; // host directory mounted at /work
  stateDir: string; // host directory for the bundle and logs
}

export interface ExecResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

export interface Sandbox {
  /** Create and start the sandbox (idempotent: an existing running sandbox is reused). */
  create(spec: SandboxSpec): Promise<void>;
  exec(id: string, command: string, opts: { timeoutMs: number; stdin?: string; cwd?: string }): Promise<ExecResult>;
  destroy(id: string): Promise<void>;
  /** Every sandbox this server started that is still around (for cleanup). */
  list(): Promise<string[]>;
  /** The user commands run as; /drive and /work must be writable for it. */
  readonly user?: { uid: number; gid: number };
  /** Release host state left by the runtime once no sandbox is running (optional). */
  releaseRoot?(): Promise<void>;
  // TODO(wave 2): suspend(id) and resume(id) with runsc checkpoint/restore.
}

/** A sandbox that cannot run commands; for tests of everything around run. */
export class NoExecSandbox implements Sandbox {
  async create(): Promise<void> {}
  async exec(): Promise<ExecResult> {
    return { exitCode: 127, stdout: Buffer.alloc(0), stderr: Buffer.from('no sandbox in this configuration\n'), timedOut: false };
  }
  async destroy(): Promise<void> {}
  async list(): Promise<string[]> {
    return [];
  }
}
