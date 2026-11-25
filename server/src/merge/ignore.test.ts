import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempContext, upload, settle } from '../testing.js';
import { mergeSession } from './merge.js';
import { isToolCache, summariseIgnored } from './ignore.js';
import { archiveToolCaches } from './cleanup.js';
import { undoPackage } from './undo.js';

let ctx: ReturnType<typeof tempContext>;
beforeEach(() => {
  ctx = tempContext();
});
afterEach(async () => {
  await ctx.dispose();
});

test('the ignore list matches caches and build output, not real content', () => {
  for (const p of ['a/__pycache__/m.cpython-312.pyc', 'x.pyc', 'p/.pytest_cache/v/cache/nodeids', 'web/node_modules/left-pad/index.js', '.venv/bin/python', 'venv/lib/x.py', 'crate/target/debug/app', '.mypy_cache/3.12/x.json', '.ruff_cache/CACHEDIR.TAG', 'notes/.DS_Store', '.cache/pip/x'])
    expect(isToolCache(p), p).toBe(true);
  for (const p of ['dist/report.pdf', 'build/notes.md', 'targets.md', 'my_pycache_notes.txt', 'notes/cache.md', 'node_modules.txt'])
    expect(isToolCache(p), p).toBe(false);
  expect(summariseIgnored(['a/__pycache__/x.pyc', 'a/__pycache__/y.pyc', 'z.pyc'])).toEqual(['a/__pycache__/ (2 files)', 'z.pyc']);
});

test('checkpoint skips tool caches, reports them, and leaves them in the working copy', async () => {
  await upload(ctx, { 'proj/m.py': 'x = 1\n' });
  await settle(ctx);
  const { row } = await ctx.sessions.start('c', 'p', {});
  const up = ctx.sessions.dirs(row.dir_id).upper;
  mkdirSync(path.join(up, 'proj/__pycache__'));
  writeFileSync(path.join(up, 'proj/__pycache__/m.cpython-312.pyc'), Buffer.from([0, 1, 2]));
  mkdirSync(path.join(up, 'proj/.pytest_cache/v'), { recursive: true });
  writeFileSync(path.join(up, 'proj/.pytest_cache/v/lastfailed'), '{}');
  writeFileSync(path.join(up, 'proj/test_m.py'), 'def test(): pass\n');
  const r = await mergeSession(ctx.sessions, row.dir_id, 'checkpoint', '');
  expect(r.ok).toBe(true);
  expect(r.changes).toEqual([{ kind: 'create', path: 'proj/test_m.py' }]);
  expect(r.ignored.sort()).toEqual(['proj/.pytest_cache/v/lastfailed', 'proj/__pycache__/m.cpython-312.pyc']);
  expect(ctx.drive.reachableView().map((v) => v.path)).toEqual(['proj/m.py', 'proj/test_m.py']);
  expect(ctx.drive.hiddenCounts()).toEqual({});
  // Still in the working copy after the rebase.
  expect(existsSync(path.join(up, 'proj/__pycache__/m.cpython-312.pyc'))).toBe(true);
  // A second checkpoint with only caches merges nothing.
  const r2 = await mergeSession(ctx.sessions, row.dir_id, 'finish', '');
  expect(r2.ok).toBe(true);
  expect(r2.changes).toEqual([]);
});

test('archive-tool-caches archives caches merged earlier, as one undoable package', async () => {
  await upload(ctx, { 'p/__pycache__/a.pyc': 'bytes', 'p/a.py': 'a', 'p/.pytest_cache/README.md': 'cache' });
  await settle(ctx);
  const r = archiveToolCaches(ctx.drive);
  expect(r.paths).toEqual(['p/.pytest_cache/README.md', 'p/__pycache__/a.pyc']);
  expect(ctx.drive.snapshot().get(ctx.drive.liveItemAt('p/a.py')!.item_id)!.state).toBe('live');
  expect(archiveToolCaches(ctx.drive).pkg_id).toBeNull();
  expect(undoPackage(ctx.drive, r.pkg_id!).reverted.length).toBe(2);
  expect(ctx.drive.reconstruct()).toEqual(ctx.drive.snapshot());
});
