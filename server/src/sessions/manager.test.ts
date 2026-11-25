import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempContext, upload, settle } from '../testing.js';
import { mergeSession, diffSession } from '../merge/merge.js';
import { ringCheck } from '../ingest/reading-stub.js';
import { newSessionId } from '../util/ids.js';

let ctx: ReturnType<typeof tempContext>;
let outside: string;
beforeEach(() => {
  ctx = tempContext();
  outside = mkdtempSync(path.join(os.tmpdir(), 'a4-outside-'));
  writeFileSync(path.join(outside, 'host-secret.txt'), 'host file');
});
afterEach(async () => {
  await ctx.dispose();
  rmSync(outside, { recursive: true, force: true });
});

test('session ids are ds_ plus 26 base32 characters and stored only hashed', async () => {
  expect(newSessionId()).toMatch(/^ds_[a-z2-7]{26}$/);
  const { session_id } = await ctx.sessions.start('c1', 'p', {});
  const row = ctx.drive.db.prepare('SELECT * FROM sessions').get() as Record<string, string>;
  expect(Object.values(row)).not.toContain(session_id);
  expect(ctx.sessions.lookup(session_id, 'c1').arg).toBe('matched');
  expect(ctx.sessions.lookup(session_id, 'c2').arg).toBe('other_connection');
  expect(ctx.sessions.lookup(undefined, 'c1').arg).toBe('none');
});

test('symlinks planted in the working space never lead the host outside it', async () => {
  await upload(ctx, { 'evil/f.txt': 'drive file', 'ok.txt': 'fine' });
  await settle(ctx);
  const { row } = await ctx.sessions.start('c', 'p', {});
  const up = ctx.sessions.dirs(row.dir_id).upper;
  // The sandbox replaces a directory with a symlink to a host path, and adds file symlinks.
  rmSync(path.join(up, 'evil'), { recursive: true });
  symlinkSync(outside, path.join(up, 'evil'));
  symlinkSync(path.join(outside, 'host-secret.txt'), path.join(up, 'link.txt'));
  await expect(ctx.sessions.read(row.dir_id, 'link.txt')).rejects.toThrow(/not_found/);
  await expect(ctx.sessions.read(row.dir_id, 'evil/host-secret.txt')).rejects.toThrow(/not_found/);
  await ctx.sessions.write(row.dir_id, 'evil/new.txt', 'written by agent');
  expect(readdirSync(outside)).toEqual(['host-secret.txt']);
  const changes = await diffSession(ctx.sessions, row.dir_id);
  // The write replaced the planted directory link with a real directory; the link file is ignored.
  expect(changes.map((c) => `${c.kind} ${c.path}`).sort()).toEqual(['archive evil/f.txt', 'create evil/new.txt']);
  // Rebase writes the view back without following the planted links.
  const r = await mergeSession(ctx.sessions, row.dir_id, 'checkpoint', '');
  expect(r.ok).toBe(true);
  expect(readdirSync(outside)).toEqual(['host-secret.txt']);
  expect(existsSync(path.join(up, 'link.txt'))).toBe(true); // left alone, never merged
});

test('stub ring rules', async () => {
  const rc = (text: string) => ringCheck({ text, name: 'x.txt', mime: 'text/plain', source: 'upload', batchLabels: [] });
  expect((await rc('card 4111 1111 1111 1111')).rings).toEqual(['ring:finance']);
  expect((await rc('number 4111 1111 1111 1112')).rings).toEqual([]); // fails Luhn
  expect((await rc('IBAN GB82 WEST 1234 5698 7654 32')).rings).toEqual(['ring:finance']);
  expect((await rc('My Recovery Code: abc')).rings).toEqual(['ring:credentials']);
  expect((await rc('-----BEGIN RSA PRIVATE KEY-----')).rings).toEqual(['ring:credentials']);
  expect((await rc('a shopping list')).rings).toEqual([]);
  expect((await ringCheck({ text: '', name: 'x.png', mime: 'image/png', source: 'upload', batchLabels: [] })).uncertain).toBe(true);
});
