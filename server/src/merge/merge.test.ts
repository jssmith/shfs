import { afterEach, beforeEach, expect, test } from 'vitest';
import { readFileSync, existsSync, writeFileSync, unlinkSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tempContext, upload, settle } from '../testing.js';
import { mergeSession } from './merge.js';
import { trashItem, undoPackage } from './undo.js';

let ctx: ReturnType<typeof tempContext>;
beforeEach(() => {
  ctx = tempContext();
});
afterEach(async () => {
  await ctx.dispose();
});

const CARD = '4539 1488 0343 6467'; // synthetic, Luhn-valid, not on the rules' list of published test numbers

test('uploads are unreachable until checked, ringed ones stay hidden', async () => {
  await upload(ctx, { 'notes/a.md': '# hello', 'notes/card.txt': `card ${CARD}` }, ['topic:project:demo']);
  expect(ctx.drive.reachableView()).toEqual([]);
  await settle(ctx);
  expect(ctx.drive.reachableView().map((v) => v.path)).toEqual(['notes/a.md']);
  expect(ctx.drive.hiddenCounts()).toEqual({ 'ring:finance': 1 });
  expect(ctx.drive.reconstruct()).toEqual(ctx.drive.snapshot());
});

test('session edit, create, delete and move merge; undo reverts', async () => {
  await upload(ctx, { 'docs/a.txt': 'alpha', 'docs/b.txt': 'beta', 'docs/c.txt': 'gamma' });
  await settle(ctx);
  const { row } = await ctx.sessions.start('conn1', 'tidy the docs', {});
  const up = ctx.sessions.dirs(row.dir_id).upper;
  expect(readFileSync(path.join(up, 'docs/a.txt'), 'utf8')).toBe('alpha');
  writeFileSync(path.join(up, 'docs/a.txt'), 'alpha 2');
  writeFileSync(path.join(up, 'docs/new.txt'), 'new file');
  unlinkSync(path.join(up, 'docs/b.txt'));
  mkdirSync(path.join(up, 'moved'));
  renameSync(path.join(up, 'docs/c.txt'), path.join(up, 'moved/c.txt'));
  const res = await ctx.sessions.lock.run(row.dir_id, () => mergeSession(ctx.sessions, row.dir_id, 'checkpoint', 'did things'));
  expect(res.ok).toBe(true);
  expect(res.changes.map((c) => c.kind).sort()).toEqual(['archive', 'create', 'move', 'update']);
  const paths = ctx.drive.reachableView().map((v) => v.path);
  expect(paths).toEqual(['docs/a.txt', 'docs/new.txt', 'moved/c.txt']);
  expect(ctx.drive.reconstruct()).toEqual(ctx.drive.snapshot());

  const u = undoPackage(ctx.drive, res.pkg_id!);
  expect(u.conflicts).toEqual([]);
  expect(ctx.drive.reachableView().map((v) => v.path)).toEqual(['docs/a.txt', 'docs/b.txt', 'docs/c.txt']);
  const a = ctx.drive.reachableView().find((v) => v.path === 'docs/a.txt')!;
  expect((await ctx.drive.blobs.get(a.blob_hash)).toString()).toBe('alpha');
  expect(ctx.drive.reconstruct()).toEqual(ctx.drive.snapshot());
});

test('a merge with a conflict changes nothing', async () => {
  await upload(ctx, { 'a.txt': 'one', 'b.txt': 'two' });
  await settle(ctx);
  const s1 = (await ctx.sessions.start('c', 'p1', {})).row;
  const s2 = (await ctx.sessions.start('c', 'p2', {})).row;
  writeFileSync(path.join(ctx.sessions.dirs(s1.dir_id).upper, 'a.txt'), 'one by s1');
  writeFileSync(path.join(ctx.sessions.dirs(s2.dir_id).upper, 'a.txt'), 'one by s2');
  writeFileSync(path.join(ctx.sessions.dirs(s2.dir_id).upper, 'c.txt'), 'three');
  expect((await mergeSession(ctx.sessions, s1.dir_id, 'checkpoint', '')).ok).toBe(true);
  const before = JSON.stringify([[...ctx.drive.snapshot().entries()], ctx.drive.packages().length]);
  const r2 = await mergeSession(ctx.sessions, s2.dir_id, 'checkpoint', '');
  expect(r2.ok).toBe(false);
  expect(r2.conflicts.map((c) => c.path)).toEqual(['a.txt']);
  expect(JSON.stringify([[...ctx.drive.snapshot().entries()], ctx.drive.packages().length])).toBe(before);
});

test('undo never overwrites later work', async () => {
  const up1 = await upload(ctx, { 'x.txt': 'v1' });
  await settle(ctx);
  const s = (await ctx.sessions.start('c', 'p', {})).row;
  writeFileSync(path.join(ctx.sessions.dirs(s.dir_id).upper, 'x.txt'), 'v2 by session');
  const m = await mergeSession(ctx.sessions, s.dir_id, 'checkpoint', '');
  expect(m.ok).toBe(true);
  const u = undoPackage(ctx.drive, up1.pkg_id!);
  expect(u.conflicts.length).toBe(1);
  const x = ctx.drive.reachableView().find((v) => v.path === 'x.txt')!;
  expect((await ctx.drive.blobs.get(x.blob_hash)).toString()).toBe('v2 by session');
  // The person chooses "revert" for that item.
  const f = undoPackage(ctx.drive, up1.pkg_id!, { force: [x.item_id] });
  expect(f.reverted.length).toBe(1);
  expect(ctx.drive.reachableView()).toEqual([]);
});

test('trash hides an item from open sessions at once; the session cannot resurrect it', async () => {
  await upload(ctx, { 'k.txt': 'keep', 't.txt': 'trash me' });
  await settle(ctx);
  const s = (await ctx.sessions.start('c', 'p', {})).row;
  const up = ctx.sessions.dirs(s.dir_id).upper;
  const t = ctx.drive.reachableView().find((v) => v.path === 't.txt')!;
  trashItem(ctx.drive, t.item_id);
  await ctx.sessions.applyVisibility(t.item_id);
  expect(existsSync(path.join(up, 't.txt'))).toBe(false);
  const r = await mergeSession(ctx.sessions, s.dir_id, 'checkpoint', '');
  expect(r.ok).toBe(true);
  expect(r.changes).toEqual([]);
});

test('a session write that the ring check rings is merged but leaves the view', async () => {
  const s = (await ctx.sessions.start('c', 'p', {})).row;
  const up = ctx.sessions.dirs(s.dir_id).upper;
  writeFileSync(path.join(up, 'pay.txt'), `IBAN DE89 3704 0044 0532 0130 00`);
  const r = await mergeSession(ctx.sessions, s.dir_id, 'checkpoint', '');
  expect(r.ok).toBe(true);
  expect(r.withheld).toEqual([{ path: 'pay.txt', rings: ['ring:finance'] }]);
  expect(existsSync(path.join(up, 'pay.txt'))).toBe(false);
  expect(ctx.drive.hiddenCounts()).toEqual({ 'ring:finance': 1 });
});

test('a change onto a hidden item\'s path goes ahead; the hidden item moves aside unseen', async () => {
  await upload(ctx, { 'docs/card.txt': `card ${CARD}` });
  await settle(ctx); // ringed
  const s = (await ctx.sessions.start('c', 'p', {})).row;
  const up = ctx.sessions.dirs(s.dir_id).upper;
  mkdirSync(path.join(up, 'docs'), { recursive: true });
  writeFileSync(path.join(up, 'docs/card.txt'), 'my own notes');
  // An unchecked upload lands at another path the session also writes.
  await upload(ctx, { 'docs/pending.txt': 'not checked yet' });
  writeFileSync(path.join(up, 'docs/pending.txt'), 'agent text');
  const r = await mergeSession(ctx.sessions, s.dir_id, 'checkpoint', '');
  expect(r.ok).toBe(true);
  expect(r.conflicts).toEqual([]);
  expect(r.changes.map((c) => `${c.kind} ${c.path}`).sort()).toEqual(['create docs/card.txt', 'create docs/pending.txt']);
  expect(JSON.stringify(r)).not.toMatch(/\(2\)|hidden|ring/);
  const items = ctx.drive.snapshot();
  const paths = [...items.values()].filter((t) => t.state === 'live').map((t) => t.path).sort();
  expect(paths).toEqual(['docs/card (2).txt', 'docs/card.txt', 'docs/pending (2).txt', 'docs/pending.txt']);
  expect(ctx.drive.reachableView().map((v) => v.path)).toEqual(['docs/card.txt', 'docs/pending.txt']);
  expect(ctx.drive.reconstruct()).toEqual(ctx.drive.snapshot());
  await settle(ctx);
  expect(ctx.drive.hiddenCounts()).toEqual({ 'ring:finance': 1 });
});

test('a create onto a visible item added since the base is still a path_taken conflict', async () => {
  const s = (await ctx.sessions.start('c', 'p', {})).row;
  await upload(ctx, { 'x.txt': 'from the person' });
  await settle(ctx);
  writeFileSync(path.join(ctx.sessions.dirs(s.dir_id).upper, 'x.txt'), 'from the agent');
  const r = await mergeSession(ctx.sessions, s.dir_id, 'checkpoint', '');
  expect(r.ok).toBe(false);
  expect(r.conflicts[0]!.reason).toMatch(/^path_taken/);
});
