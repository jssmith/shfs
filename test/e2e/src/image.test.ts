// The sandbox runs with the image's environment and user (image.json from
// sandbox/build.sh), and that user can write /drive and /work.
// Needs AGENT_DRIVE_RUNSC and AGENT_DRIVE_TEST_IMAGE_ROOTFS (a rootfs with image.json next to it).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, type Context } from '../../../server/src/context.js';
import { ingestUpload } from '../../../server/src/ingest/upload.js';
import { mergeSession } from '../../../server/src/merge/merge.js';
import { loadImageSettings } from '../../../server/src/sessions/image.js';
import { RUNSC } from './harness.js';

const ROOTFS = process.env.AGENT_DRIVE_TEST_IMAGE_ROOTFS;

describe.skipIf(!(RUNSC && ROOTFS))('sandbox image settings (needs AGENT_DRIVE_RUNSC and AGENT_DRIVE_TEST_IMAGE_ROOTFS)', () => {
  let ctx: Context;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'a4-img-'));
    ctx = createContext({ dataDir: dir, port: 0, publicUrl: 'http://127.0.0.1', runsc: RUNSC!, runscRoot: path.join('/run', 'a4-img'), rootfs: ROOTFS!, sandboxPrefix: 'a4-img-' });
  });
  afterAll(async () => {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync('/run/a4-img', { recursive: true, force: true });
  });

  test('env, user and writable mounts', async () => {
    const img = loadImageSettings(ROOTFS!);
    expect(img.user.uid).not.toBe(0);
    const h = await ctx.drive.blobs.put(Buffer.from('hello\n'));
    ingestUpload(ctx.drive, [{ path: 'notes/a.txt', hash: h, size: 6 }], [], 'test');
    ctx.jobs.kick();
    await ctx.jobs.idle();
    const { row } = await ctx.sessions.start('c', 'p', {});
    const r = await ctx.sessions.run(row.dir_id, 'id -u; pwd; echo "NODE_PATH=$NODE_PATH HOME=$HOME"; echo more >> notes/a.txt && mkdir -p out && echo new > out/b.txt && echo w > /work/w.txt && echo writes-ok', 30);
    expect(r.stderr).toBe('');
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe(String(img.user.uid));
    expect(lines[1]).toBe('/drive');
    expect(lines[2]).toContain('NODE_PATH=/usr/local/lib/node_modules');
    expect(lines[2]).toContain('HOME=/work');
    expect(lines[3]).toBe('writes-ok');
    const m = await ctx.sessions.lock.run(row.dir_id, () => mergeSession(ctx.sessions, row.dir_id, 'checkpoint', ''));
    expect(m.ok).toBe(true);
    expect(m.changes.map((c) => `${c.kind} ${c.path}`).sort()).toEqual(['create out/b.txt', 'update notes/a.txt']);
    // After the rebase, host-written files are still writable by the sandbox user.
    const r2 = await ctx.sessions.run(row.dir_id, 'echo again >> notes/a.txt && echo ok', 30);
    expect(r2.stdout.trim()).toBe('ok');
  }, 60_000);
});
