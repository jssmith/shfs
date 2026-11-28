// The shell surfaces (v2, v3) without a sandbox: tools, read/write/edit,
// automatic merge with coalescing and conflicts, the drive command's socket
// (spoken to from the host, as the sandbox's drive command would).
import { afterEach, expect, test } from 'vitest';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { upload, settle, sessionDrive } from '../testing.js';
import { mcpEnv, type McpEnv } from './test-env.js';
import type { Surface } from '../context.js';
import { SHELL_SKILL } from './skill.js';
import { numberLines, SKILL_URI } from './shell.js';
import { parseRequest } from '../sessions/socket.js';
import { safeWrite } from '../util/fsafe.js';

let port = 9450;
const open: McpEnv[] = [];
async function env(surface: Surface): Promise<McpEnv> {
  const e = await mcpEnv(surface, port++);
  open.push(e);
  return e;
}
afterEach(async () => {
  for (const e of open.splice(0)) await e.close();
});

async function content(e: McpEnv, p: string): Promise<string | null> {
  const v = e.ctx.drive.reachableView().find((x) => x.path === p);
  return v ? (await e.ctx.drive.blobs.get(v.blob_hash)).toString() : null;
}
const sessionPackages = (e: McpEnv) => e.ctx.drive.packages().filter((p) => p.kind === 'checkpoint');
async function start(e: McpEnv, purpose = 'tidy my notes'): Promise<{ sid: string; dir: string; text: string }> {
  const r = await e.call('start_session', { purpose });
  const dir = e.ctx.drive.db.prepare('SELECT dir_id FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { dir_id: string };
  return { sid: String(r.structured.session_id), dir: dir.dir_id, text: r.text };
}

/** What the sandbox's drive command does: one JSON line out, one JSON line back. */
function driveCmd(sock: string, payload: unknown): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d: string) => (buf += d));
    c.on('end', () => resolve(JSON.parse(buf)));
    c.on('error', reject);
    c.end(typeof payload === 'string' ? payload : `${JSON.stringify(payload)}\n`);
  });
}

test('v2 offers start_session, bash, read, write, edit and the skill resource; v3 only start_session and bash', async () => {
  const v2 = await env('v2');
  const t2 = (await v2.client.listTools()).tools;
  expect(t2.map((t) => t.name).sort()).toEqual(['bash', 'edit', 'read', 'start_session', 'write']);
  for (const t of t2) expect(t.outputSchema?.properties, t.name).toHaveProperty('ok');
  const bash = t2.find((t) => t.name === 'bash')!;
  expect(Object.keys(bash.inputSchema.properties!).sort()).toEqual(['command', 'description', 'session_id', 'timeout']);
  expect(Object.keys(t2.find((t) => t.name === 'read')!.inputSchema.properties!).sort()).toEqual(['file_path', 'limit', 'offset', 'session_id']);
  expect(Object.keys(t2.find((t) => t.name === 'edit')!.inputSchema.properties!).sort()).toEqual(['file_path', 'new_string', 'old_string', 'replace_all', 'session_id']);
  expect(t2.find((t) => t.name === 'start_session')!.description).toContain('Pull together my 2025 tax documents');
  expect(v2.client.getInstructions()).toContain("may not include everything the person has");
  const res = await v2.client.listResources();
  expect(res.resources.map((r) => r.uri)).toEqual([SKILL_URI]);
  const skill = await v2.client.readResource({ uri: SKILL_URI });
  expect((skill.contents[0] as { text: string }).text).toBe(SHELL_SKILL);

  const v3 = await env('v3');
  const t3 = (await v3.client.listTools()).tools;
  expect(t3.map((t) => t.name).sort()).toEqual(['bash', 'start_session']);
  expect(t3.find((t) => t.name === 'bash')!.description).toContain('cat -n');
  expect((await v3.client.listResources()).resources.map((r) => r.uri)).toEqual([SKILL_URI]);
});

test('start_session says the view may be partial and how to work', async () => {
  const e = await env('v2');
  await upload(e.ctx, { 'notes/a.md': 'a\n', 'money/card.txt': 'Card 4539 1488 0343 6467\n' });
  await settle(e.ctx);
  const s = await start(e);
  expect(s.text).toContain('may not include everything the person has');
  expect(s.text).toContain('Hidden from sessions: Finance (1 item)');
  expect(s.text).toContain('saved to the drive when the call that makes them ends');
  expect(s.text).toContain('drive help');
});

test('numberLines is cat -n with offset and limit', () => {
  expect(numberLines('a\nb\nc\n').out).toBe('     1\ta\n     2\tb\n     3\tc');
  const n = numberLines('a\nb\nc\nd', 2, 2);
  expect(n).toEqual({ out: '     2\tb\n     3\tc', total: 4, first: 2, last: 3 });
});

test('read pages by lines; write and edit are saved before their result returns', async () => {
  const e = await env('v2');
  // Words, not numbers: long runs of numbers can look like identifiers to the ring check.
  const word = (i: number) => `row ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}${String.fromCharCode(97 + Math.floor(i / 676))}`;
  const long = Array.from({ length: 2500 }, (_, i) => word(i)).join('\n') + '\n';
  await upload(e.ctx, { 'notes/plan.md': 'Plant tomatoes in May.\nWater weekly.\nWater weekly.\n', 'notes/long.txt': long });
  await settle(e.ctx);
  const { sid } = await start(e);

  const r1 = await e.call('read', { session_id: sid, file_path: '/drive/notes/plan.md' });
  expect(r1.text).toBe('     1\tPlant tomatoes in May.\n     2\tWater weekly.\n     3\tWater weekly.');
  const r2 = await e.call('read', { session_id: sid, file_path: 'notes/long.txt' });
  expect(r2.text.split('\n').length, r2.text.slice(0, 300)).toBe(2001);
  expect(r2.text).toContain('(lines 1–2000 of 2500; read more with offset=2001)');
  const r3 = await e.call('read', { session_id: sid, file_path: 'notes/long.txt', offset: 2499, limit: 5 });
  expect(r3.text).toBe(`  2499\t${word(2498)}\n  2500\t${word(2499)}`);
  const outside = await e.call('read', { session_id: sid, file_path: '/etc/passwd' });
  expect(outside.structured).toMatchObject({ ok: false, reason: 'invalid_path' });

  // Edit: absent and ambiguous old_string fail clearly and change nothing.
  const absent = await e.call('edit', { session_id: sid, file_path: 'notes/plan.md', old_string: 'Plant beans', new_string: 'x' });
  expect(absent.structured).toMatchObject({ ok: false, reason: 'edit_no_match' });
  expect(absent.text).toMatch(/^edit_no_match: old_string was not found in \/drive\/notes\/plan\.md\. Read the file/);
  const twice = await e.call('edit', { session_id: sid, file_path: 'notes/plan.md', old_string: 'Water weekly.', new_string: 'Water daily.' });
  expect(twice.structured).toMatchObject({ ok: false, reason: 'edit_not_unique' });
  expect(twice.text).toContain('appears 2 times');
  expect(sessionPackages(e)).toHaveLength(0);

  // Each changing call is saved before its result returns, and says so.
  const ed = await e.call('edit', { session_id: sid, file_path: 'notes/plan.md', old_string: 'Plant tomatoes', new_string: 'Plant basil' });
  expect(ed.text).toMatch(/^Edited \/drive\/notes\/plan\.md: replaced 1 occurrence\. Saved to the drive: update notes\/plan\.md \(package pk_/);
  expect(ed.text).toContain('     1\tPlant basil in May.');
  expect(ed.structured.save).toMatchObject({ ok: true, changes: [{ kind: 'update', path: 'notes/plan.md' }] });
  expect(await content(e, 'notes/plan.md')).toBe('Plant basil in May.\nWater weekly.\nWater weekly.\n');
  await e.call('edit', { session_id: sid, file_path: 'notes/plan.md', old_string: 'Water weekly.', new_string: 'Water daily.', replace_all: true });
  const w = await e.call('write', { session_id: sid, file_path: '/drive/notes/summary.md', content: 'Basil, watered daily.\n' });
  expect(w.text).toMatch(/^Wrote 22 bytes to \/drive\/notes\/summary\.md\. Saved to the drive: create notes\/summary\.md/);
  const sw = await e.call('write', { session_id: sid, file_path: '/work/scratch.txt', content: 'scratch\n' });
  expect(sw.text).toContain('/work is scratch and is never saved');
  const pkgs = sessionPackages(e);
  expect(pkgs.map((p) => p.summary_claimed)).toEqual(['edit /drive/notes/plan.md', 'edit /drive/notes/plan.md', 'write /drive/notes/summary.md']);
  expect(await content(e, 'notes/plan.md')).toBe('Plant basil in May.\nWater daily.\nWater daily.\n');
  expect(await content(e, 'notes/summary.md')).toBe('Basil, watered daily.\n');
  expect(e.ctx.drive.reachableView().some((v) => v.path.includes('scratch'))).toBe(false);
  // No note about earlier saves on later calls.
  expect((await e.call('read', { session_id: sid, file_path: 'notes/summary.md' })).text).toBe('     1\tBasil, watered daily.');
});

test('a conflicting save merges nothing and is reported in the same call; the redo saves', async () => {
  const e = await env('v2');
  await upload(e.ctx, { 'notes/plan.md': 'v1\n', 'notes/other.md': 'other\n' });
  await settle(e.ctx);
  const { sid, dir } = await start(e);
  // The person changes the file after the session began.
  await upload(e.ctx, { 'notes/plan.md': 'v2 by the person\n' });
  await settle(e.ctx);
  const r = await e.call('write', { session_id: sid, file_path: 'notes/plan.md', content: 'v1 plus agent line\n' });
  expect(r.isError).toBe(true);
  expect(r.structured).toMatchObject({ ok: false, reason: 'merge_conflict', save: { ok: false, conflicts: [{ path: 'notes/plan.md' }] } });
  expect(r.text).toMatch(/^merge_conflict: Wrote 19 bytes to \/drive\/notes\/plan\.md in this session, but nothing was saved to the drive\. notes\/plan\.md: changed in the drive since this session last saved \(your version is saved at \/work\/conflicts\/notes\/plan\.md\)/);
  expect(r.text).toMatch(/Redo your change on top of the file in \/drive .*\.$/);
  expect(sessionPackages(e)).toHaveLength(0);
  expect(readFileSync(path.join(e.ctx.sessions.dirs(dir).work, 'conflicts/notes/plan.md'), 'utf8')).toBe('v1 plus agent line\n');
  expect((await e.call('read', { session_id: sid, file_path: 'notes/plan.md' })).text).toBe('     1\tv2 by the person');

  // drive status shows the failed save.
  const sock = (await e.ctx.sessions.socketFor(dir))!;
  const st = await driveCmd(sock, { argv: ['status'] });
  expect(st.stdout).toContain('Purpose: tidy my notes');
  expect(st.stdout).toContain('FAILED');
  expect(st.stdout).toContain('Conflicts: merge_conflict');
  expect(st.stdout).toContain('may not include everything the person has');

  const redo = await e.call('edit', { session_id: sid, file_path: 'notes/plan.md', old_string: 'v2 by the person\n', new_string: 'v2 by the person\nplus agent line\n' });
  expect(redo.text).toContain('Saved to the drive: update notes/plan.md');
  expect(await content(e, 'notes/plan.md')).toBe('v2 by the person\nplus agent line\n');
});

test('the drive command over the session socket: search, --all, save, help, and nothing else', async () => {
  const e = await env('v2');
  const files: Record<string, string> = {};
  for (let i = 0; i < 123; i++) files[`receipts/r-${String(i).padStart(4, '0')}.txt`] = `Receipt ${i} from Oak Street Grocer\n`;
  files['money/card.txt'] = 'Card 4539 1488 0343 6467 Oak Street Grocer\n';
  await upload(e.ctx, files);
  await settle(e.ctx);
  const a = await start(e, 'count my receipts');
  const b = await start(e, 'something else');
  const sockA = (await e.ctx.sessions.socketFor(a.dir))!;
  const sockB = (await e.ctx.sessions.socketFor(b.dir))!;
  expect(sockA).not.toBe(sockB);
  expect(sockA).toContain(a.dir);

  const s = await driveCmd(sockA, { argv: ['search', 'Oak', 'Street'] });
  expect(s.exit).toBe(0);
  expect(s.stdout).toMatch(/^about 120 matches you can see; the first 20:/);
  expect(s.stdout.match(/^\/drive\/receipts\//gm)).toHaveLength(20);
  expect(s.stdout).toContain('For the full list: drive search --all Oak Street');
  expect(s.stdout).toContain('Hidden from this session: none.'); // the card matches on text only
  const all = await driveCmd(sockA, { argv: ['search', '--all', 'Oak', 'Street'] });
  expect(all.stdout).toContain('Full list (123 matches) written to /work/search-1.txt.');
  const list = readFileSync(path.join(e.ctx.sessions.dirs(a.dir).work, 'search-1.txt'), 'utf8');
  expect(list.match(/^\/drive\/receipts\//gm)).toHaveLength(123);
  expect(list).not.toContain('card');
  expect((await driveCmd(sockA, { argv: ['search', '--all', 'Oak'] })).stdout).toContain('/work/search-2.txt');
  expect((await driveCmd(sockA, { argv: ['search', 'finance'] })).stdout).toContain('Hidden from this session: Finance: 1 item matches by label.');

  expect((await driveCmd(sockA, { argv: ['help'] })).stdout).toBe(SHELL_SKILL);
  expect((await driveCmd(sockA, { argv: ['rm', '-rf'] })).exit).toBe(2);
  expect((await driveCmd(sockA, 'not json\n')).stderr).toContain('bad request');
  expect((await driveCmd(sockA, { argv: [1, 2] })).stderr).toContain('bad request');
  expect(parseRequest('{"argv":["status"],"dir_id":"sd_x"}')).toEqual(['status']);

  // A request on A's socket acts on A only, whatever it claims.
  // B's command changed a file and has not ended yet (what bash's drive save sees).
  await safeWrite(await sessionDrive(e.ctx, b.dir), 'notes/b.md', 'from b\n');
  const stA = await driveCmd(sockA, { argv: ['status'], session_id: b.sid, dir_id: b.dir });
  expect(stA.stdout).toContain('Purpose: count my receipts');
  expect(stA.stdout).toContain('Unsaved changes: none.');
  const save = await driveCmd(sockA, { argv: ['save', 'nothing really'], dir_id: b.dir });
  expect(save.stdout).toContain('Nothing to save');
  expect(await content(e, 'notes/b.md')).toBeNull();

  const saveB = await driveCmd(sockB, { argv: ['save', 'Add a note about b'] });
  expect(saveB.exit).toBe(0);
  expect(saveB.stdout).toMatch(/^Saved to the drive: create notes\/b\.md \(package pk_/);
  expect(sessionPackages(e).at(-1)!.summary_claimed).toBe('Add a note about b');
  expect(await content(e, 'notes/b.md')).toBe('from b\n');
});
