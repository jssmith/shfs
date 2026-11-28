// Daemon mode (AGENT_DRIVE_FS=daemon) specifics: upper/ holds only what the session wrote,
// deletes are whiteouts, the server reaches upper/ only through agent-drive-fs, and the view
// changes reach the mount at once. Needs root, /dev/fuse and a built agent-drive-fs (fs/).
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, type Context } from '../context.js';
import { upload, settle } from '../testing.js';
import { NoExecSandbox } from './sandbox.js';
import { testFsBin } from './fsd.js';
import { diffSession, mergeSession } from '../merge/merge.js';
import { trashItem } from '../merge/undo.js';

const BIN = testFsBin();
const haveDaemon = process.getuid?.() === 0 && existsSync('/dev/fuse') && existsSync(BIN);

describe.skipIf(!haveDaemon)('daemon mode (needs root, /dev/fuse and fs/target/*/agent-drive-fs)', () => {
  let ctx: Context;
  let dir: string;
  let outside: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'fsd-test-'));
    outside = mkdtempSync(path.join(os.tmpdir(), 'fsd-outside-'));
    writeFileSync(path.join(outside, 'host-secret.txt'), 'host file');
    ctx = createContext(
      { dataDir: dir, port: 0, publicUrl: 'http://localhost', runsc: null, runscRoot: path.join(dir, 'runsc'), rootfs: '', sandboxPrefix: 'fsd-t-', surface: 'v0', fs: 'daemon', fsBin: BIN },
      new NoExecSandbox(),
    );
  });
  afterEach(async () => {
    await ctx.close();
    expect(readFileSync('/proc/self/mountinfo', 'utf8')).not.toContain(dir);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  async function session(files: Record<string, string>) {
    await upload(ctx, files);
    await settle(ctx);
    const { row } = await ctx.sessions.start('c', 'p', {});
    const d = ctx.sessions.dirs(row.dir_id);
    await ctx.sessions.lock.run(row.dir_id, () => ctx.sessions.ensureFs(row.dir_id));
    const whiteouts = () => (existsSync(path.join(d.root, 'whiteouts')) ? readFileSync(path.join(d.root, 'whiteouts'), 'utf8').split('\n').filter(Boolean).sort() : []);
    const upperFiles = () => {
      const out: string[] = [];
      const walk = (p: string, rel: string) => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(path.join(p, e.name), r);
          else out.push(r);
        }
      };
      walk(d.upper, '');
      return out.sort();
    };
    const merge = () => ctx.sessions.lock.run(row.dir_id, () => mergeSession(ctx.sessions, row.dir_id, 'checkpoint', ''));
    return { dir_id: row.dir_id, d, mnt: d.mnt, whiteouts, upperFiles, merge };
  }

  test('upper/ holds only what the session wrote; deletes are whiteouts; a merge resets both', async () => {
    const s = await session({ 'docs/a.txt': 'alpha', 'docs/b.txt': 'beta', 'docs/c.txt': 'gamma', 'keep.txt': 'keep' });
    expect(s.upperFiles()).toEqual([]);
    expect(readdirSync(path.join(s.mnt, 'docs')).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    writeFileSync(path.join(s.mnt, 'docs/a.txt'), 'alpha 2');
    unlinkSync(path.join(s.mnt, 'docs/b.txt'));
    mkdirSync(path.join(s.mnt, 'moved'));
    renameSync(path.join(s.mnt, 'docs/c.txt'), path.join(s.mnt, 'moved/c.txt'));
    expect(s.upperFiles()).toEqual(['docs/a.txt', 'moved/c.txt']);
    expect(s.whiteouts()).toEqual(['docs/b.txt', 'docs/c.txt']);
    const r = await s.merge();
    expect(r.ok).toBe(true);
    expect(r.changes.map((c) => `${c.kind} ${c.path}`).sort()).toEqual(['archive docs/b.txt', 'move moved/c.txt', 'update docs/a.txt']);
    // The view serves the merged files now; the session's copies and whiteouts are gone.
    expect(s.upperFiles()).toEqual([]);
    expect(s.whiteouts()).toEqual([]);
    expect(readFileSync(path.join(s.mnt, 'docs/a.txt'), 'utf8')).toBe('alpha 2');
    expect(readdirSync(path.join(s.mnt, 'docs')).sort()).toEqual(['a.txt']);
    expect(await diffSession(ctx.sessions, s.dir_id)).toEqual([]);
  });

  test('a path both whited out and in upper/ is a replacement, merged as an update', async () => {
    const s = await session({ 'r.txt': 'old' });
    unlinkSync(path.join(s.mnt, 'r.txt'));
    writeFileSync(path.join(s.mnt, 'r.txt'), 'new');
    expect(s.whiteouts()).toEqual(['r.txt']);
    expect(s.upperFiles()).toEqual(['r.txt']);
    expect((await diffSession(ctx.sessions, s.dir_id)).map((c) => `${c.kind} ${c.path}`)).toEqual(['update r.txt']);
    // A whited-out folder with one file made again: the rest stays deleted.
    const t = await session({ 'f/x.txt': 'x', 'f/y.txt': 'y' });
    rmSync(path.join(t.mnt, 'f'), { recursive: true });
    mkdirSync(path.join(t.mnt, 'f'));
    writeFileSync(path.join(t.mnt, 'f/x.txt'), 'x2');
    expect((await diffSession(ctx.sessions, t.dir_id)).map((c) => `${c.kind} ${c.path}`).sort()).toEqual(['archive f/y.txt', 'update f/x.txt']);
  });

  test('symlinks planted through the mount never lead the server outside', async () => {
    const s = await session({ 'evil/f.txt': 'drive file', 'ok.txt': 'fine' });
    rmSync(path.join(s.mnt, 'evil'), { recursive: true });
    symlinkSync(outside, path.join(s.mnt, 'evil'));
    symlinkSync(path.join(outside, 'host-secret.txt'), path.join(s.mnt, 'link.txt'));
    // In upper/ on the host they are real symlinks to host paths.
    expect(readFileSync(path.join(s.d.upper, 'evil/host-secret.txt'), 'utf8')).toBe('host file');
    await expect(ctx.sessions.read(s.dir_id, 'link.txt')).rejects.toThrow(/not_found/);
    await expect(ctx.sessions.read(s.dir_id, 'evil/host-secret.txt')).rejects.toThrow(/not_found/);
    await ctx.sessions.write(s.dir_id, 'evil/new.txt', 'written by agent');
    await ctx.sessions.write(s.dir_id, 'link.txt', 'over the link');
    expect(readdirSync(outside)).toEqual(['host-secret.txt']);
    expect(readFileSync(path.join(outside, 'host-secret.txt'), 'utf8')).toBe('host file');
    const m = await ctx.sessions.fsd!.manifest(s.dir_id, { hash: true });
    expect(m.entries.find((e) => e.path === 'evil')!.type).toBe('d');
    const r = await s.merge();
    expect(r.ok).toBe(true);
    expect(r.changes.map((c) => `${c.kind} ${c.path}`).sort()).toEqual(['archive evil/f.txt', 'create evil/new.txt', 'create link.txt']);
    expect(readdirSync(outside)).toEqual(['host-secret.txt']);
    // Planted again after the merge, as a folder the next diff would walk.
    symlinkSync(outside, path.join(s.mnt, 'evil2'));
    expect((await diffSession(ctx.sessions, s.dir_id)).map((c) => c.path)).toEqual([]);
  });

  test('a trashed item leaves the mount at once, even when the session copied it up unchanged', async () => {
    const s = await session({ 'k.txt': 'keep', 't.txt': 'trash me', 'u.txt': 'trash me too' });
    chmodSync(path.join(s.mnt, 't.txt'), 0o644); // a copy-up with the same content
    writeFileSync(path.join(s.mnt, 'u.txt'), 'changed by the session');
    expect(s.upperFiles()).toEqual(['t.txt', 'u.txt']);
    for (const p of ['t.txt', 'u.txt']) {
      const it = ctx.drive.reachableView().find((v) => v.path === p)!;
      trashItem(ctx.drive, it.item_id);
      await ctx.sessions.applyVisibility(it.item_id);
    }
    expect(existsSync(path.join(s.mnt, 't.txt'))).toBe(false);
    expect(s.upperFiles()).toEqual(['u.txt']);
    // The changed copy stays: the next merge reports the conflict.
    const r = await s.merge();
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ path: 'u.txt', reason: 'changed in the drive since this session last checkpointed', yours: '/work/conflicts/u.txt' }]);
    expect(readFileSync(path.join(s.d.work, 'conflicts/u.txt'), 'utf8')).toBe('changed by the session');
    expect(existsSync(path.join(s.mnt, 'u.txt'))).toBe(false);
    expect(s.upperFiles()).toEqual([]);
  });

  test('a conflict puts the drive\'s version back in /drive and the session\'s in /work/conflicts', async () => {
    const s = await session({ 'x.txt': 'v1' });
    writeFileSync(path.join(s.mnt, 'x.txt'), 'v1 by session');
    unlinkSync(path.join(s.mnt, 'x.txt'));
    writeFileSync(path.join(s.mnt, 'x.txt'), 'v1 by session, again');
    await upload(ctx, { 'x.txt': 'v2 by the person' });
    await settle(ctx);
    const r = await s.merge();
    expect(r.ok).toBe(false);
    expect(readFileSync(path.join(s.mnt, 'x.txt'), 'utf8')).toBe('v2 by the person');
    expect(readFileSync(path.join(s.d.work, 'conflicts/x.txt'), 'utf8')).toBe('v1 by session, again');
    expect(s.whiteouts()).toEqual([]);
    writeFileSync(path.join(s.mnt, 'x.txt'), 'v2 plus session');
    expect((await s.merge()).ok).toBe(true);
  });

  test('host tools read the view, write through the mount, and the stamp sees deletes', async () => {
    const s = await session({ 'n/a.md': 'a\n' });
    expect((await ctx.sessions.read(s.dir_id, 'n/a.md')).text).toBe('a\n');
    const st0 = await ctx.sessions.driveStamp(s.dir_id);
    unlinkSync(path.join(s.mnt, 'n/a.md'));
    const st1 = await ctx.sessions.driveStamp(s.dir_id);
    expect(st1).not.toBe(st0);
    await expect(ctx.sessions.read(s.dir_id, 'n/a.md')).rejects.toThrow(/not_found/);
    await ctx.sessions.write(s.dir_id, 'n/a.md', 'b\n');
    expect(readFileSync(path.join(s.mnt, 'n/a.md'), 'utf8')).toBe('b\n');
    const e = await ctx.sessions.editFile(s.dir_id, '/drive/n/a.md', 'b', 'c', false);
    expect(e.text).toBe('c\n');
    expect(readFileSync(path.join(s.d.upper, 'n/a.md'), 'utf8')).toBe('c\n');
    expect(await ctx.sessions.driveStamp(s.dir_id)).not.toBe(st1);
    // The daemon stops with the sandbox; reads still work without it.
    await ctx.sessions.destroySandbox(s.dir_id);
    expect(ctx.sessions.fsd!.running(s.dir_id)).toBe(false);
    expect((await ctx.sessions.read(s.dir_id, 'n/a.md')).text).toBe('c\n');
    expect(statSync(s.mnt).isDirectory()).toBe(true);
  });
});
