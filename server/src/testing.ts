// Helpers for tests: a drive in a temporary directory, without runsc.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, type Context } from './context.js';
import { ingestUpload } from './ingest/upload.js';
import { NoExecSandbox } from './sessions/sandbox.js';
import type { Sandbox } from './sessions/sandbox.js';

export function tempContext(sandbox: Sandbox = new NoExecSandbox()): Context & { dir: string; dispose(): Promise<void> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a4-test-'));
  const ctx = createContext(
    { dataDir: dir, port: 0, publicUrl: 'http://localhost', runsc: null, runscRoot: path.join(dir, 'runsc'), rootfs: '', sandboxPrefix: 'a4-t-' },
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
