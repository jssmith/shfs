// Helpers for tests: a drive in a temporary directory, without runsc.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, type Context } from './context.js';
import { ingestUpload } from './ingest/upload.js';
import { NoExecSandbox } from './sessions/sandbox.js';
import type { Sandbox } from './sessions/sandbox.js';
import type { Surface } from './context.js';
import { parseFsMode, testFsBin, type FsMode } from './sessions/fsd.js';

/** The session file system the suites run against: AGENT_DRIVE_TEST_FS=daemon serves /drive with fs/'s daemon (needs root, /dev/fuse and a built agent-drive-fs). */
export const TEST_FS: FsMode = parseFsMode(process.env.AGENT_DRIVE_TEST_FS);
export const TEST_FS_CONFIG = { fs: TEST_FS, fsBin: testFsBin() };

export function tempContext(sandbox: Sandbox = new NoExecSandbox(), surface: Surface = 'v0'): Context & { dir: string; dispose(): Promise<void> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a4-test-'));
  const ctx = createContext(
    { dataDir: dir, port: 0, publicUrl: 'http://localhost', runsc: null, runscRoot: path.join(dir, 'runsc'), rootfs: '', sandboxPrefix: 'a4-t-', surface, ...TEST_FS_CONFIG },
    sandbox,
  );
  return Object.assign(ctx, {
    dir,
    async dispose() {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    },
  });
}

export async function upload(ctx: Context, files: Record<string, string>, labels: string[] = []) {
  const list = [];
  for (const [p, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    list.push({ path: p, hash: await ctx.drive.blobs.put(data), size: data.length });
  }
  return ingestUpload(ctx.drive, list, labels, 'test');
}

/** Run the check loop to completion and apply live visibility. */
export async function settle(ctx: Context): Promise<void> {
  ctx.jobs.kick();
  await ctx.jobs.idle();
}

/**
 * The session's /drive on the host, for a test that acts as the sandbox would: upper/ in copy
 * mode, the daemon's mount in daemon mode (started here if it is not running).
 */
export async function sessionDrive(ctx: Context, dir_id: string): Promise<string> {
  await ctx.sessions.lock.run(dir_id, () => ctx.sessions.ensureFs(dir_id));
  return ctx.sessions.driveDir(dir_id);
}
