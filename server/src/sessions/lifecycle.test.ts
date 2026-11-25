// Turns (packages grouped by gaps between calls, undo a whole turn) and
// session lifecycle (idle: sandbox gone, the next call carries on; expired:
// a typed error), over MCP and the app API, with a fake sandbox.
import { afterEach, expect, test } from 'vitest';
import { upload, settle } from '../testing.js';
import { mcpEnv, type McpEnv } from '../mcp/test-env.js';
import { run } from '../store/db.js';
import { setOwnerPassword } from '../auth/owner.js';
import type { ExecResult, Sandbox, SandboxSpec } from './sandbox.js';
import { TURN_GAP_MS } from './turns.js';

/** Records what happens to sandboxes; every command succeeds and prints "ok". */
class FakeSandbox implements Sandbox {
  running = new Set<string>();
  created = 0;
  destroyed = 0;
  async create(spec: SandboxSpec): Promise<void> {
    if (this.running.has(spec.id)) return;
    this.running.add(spec.id);
    this.created++;
  }
  async exec(): Promise<ExecResult> {
    return { exitCode: 0, stdout: Buffer.from('ok\n'), stderr: Buffer.alloc(0), timedOut: false };
  }
  async destroy(id: string): Promise<void> {
    if (this.running.delete(id)) this.destroyed++;
  }
  async list(): Promise<string[]> {
    return [...this.running];
  }
}

let port = 9470;
const open: McpEnv[] = [];
afterEach(async () => {
  for (const e of open.splice(0)) await e.close();
});
async function env(surface: 'v0' | 'v2' | 'v3', sandbox?: Sandbox): Promise<McpEnv> {
  const e = await mcpEnv(surface, port++, sandbox);
  open.push(e);
  return e;
}
async function start(e: McpEnv): Promise<{ sid: string; dir: string }> {
  const r = await e.call('start_session', { purpose: 'tidy my notes' });
  const dir = (e.ctx.drive.db.prepare('SELECT dir_id FROM sessions ORDER BY rowid DESC LIMIT 1').get() as { dir_id: string }).dir_id;
  return { sid: String(r.structured.session_id), dir };
}
async function content(e: McpEnv, p: string): Promise<string | null> {
  const v = e.ctx.drive.reachableView().find((x) => x.path === p);
  return v ? (await e.ctx.drive.blobs.get(v.blob_hash)).toString() : null;
}
/** Pretend the session's last call was `ms` ago. */
function quietFor(e: McpEnv, dir: string, ms: number): void {
  run(e.ctx.drive.db, 'UPDATE session_meta SET last_call_end = ? WHERE dir_id = ?', Date.now() - ms, dir);
  run(e.ctx.drive.db, 'UPDATE sessions SET last_call_at = ? WHERE dir_id = ?', new Date(Date.now() - ms).toISOString(), dir);
}
async function owner(e: McpEnv) {
  setOwnerPassword(e.ctx.drive.db, 'synthetic-pw');
  const login = await fetch(`${e.ctx.config.publicUrl}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=synthetic-pw' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return {
    get: async (p: string) => (await fetch(`${e.ctx.config.publicUrl}${p}`, { headers: { cookie } })).json(),
    post: async (p: string, body: unknown) =>
      (await fetch(`${e.ctx.config.publicUrl}${p}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-drive-app': '1' }, body: JSON.stringify(body) })).json(),
  };
}

test('packages close together form a turn; a gap starts a new one; a turn undoes as a whole', async () => {
  const e = await env('v2');
  await upload(e.ctx, { 'notes/a.md': 'a0\n' });
  await settle(e.ctx);
  const { sid, dir } = await start(e);
  await e.call('write', { session_id: sid, file_path: 'notes/a.md', content: 'a1\n' });
  await e.call('write', { session_id: sid, file_path: 'notes/b.md', content: 'b1\n' });
  quietFor(e, dir, TURN_GAP_MS + 1000); // the person reads the answer and asks again
  await e.call('write', { session_id: sid, file_path: 'notes/c.md', content: 'c1\n' });
  await e.call('write', { session_id: sid, file_path: 'notes/a.md', content: 'a2\n' });

  const app = await owner(e);
  const s = (await app.get('/api/app/sessions')).sessions[0];
  expect(s.turns.map((t: { packages: unknown[] }) => t.packages.length)).toEqual([2, 2]);
  const [second, first] = s.turns as { turn_id: string; packages: { summary_claimed: string }[] }[];
  expect(second!.packages.map((p) => p.summary_claimed)).toEqual(['write /drive/notes/a.md', 'write /drive/notes/c.md']);
  expect(first!.packages.map((p) => p.summary_claimed)).toEqual(['write /drive/notes/b.md', 'write /drive/notes/a.md']);
  expect(second!.turn_id).not.toBe(first!.turn_id);

  // Undoing the first turn: b goes; a was changed again in the second turn, so it is left and reported.
  const u1 = await app.post('/api/app/undo-turn', { turn_id: first!.turn_id });
  expect(u1.ok).toBe(false);
  expect(u1.conflicts.map((c: { path: string }) => c.path)).toEqual(['notes/a.md']);
  expect(await content(e, 'notes/b.md')).toBeNull();
  expect(await content(e, 'notes/a.md')).toBe('a2\n');
  // Undo the second turn, newest first: a back to a1, c gone.
  const u2 = await app.post('/api/app/undo-turn', { turn_id: second!.turn_id });
  expect(u2.ok, JSON.stringify(u2)).toBe(true);
  expect(u2.packages.map((p: { pkg_id: string }) => p.pkg_id)).toEqual(second!.packages.map((p) => (p as unknown as { pkg_id: string }).pkg_id));
  expect(await content(e, 'notes/a.md')).toBe('a1\n');
  expect(await content(e, 'notes/c.md')).toBeNull();
  // The first turn again: its undone package is skipped; a now carries an undo's new version, so the usual rule leaves it.
  const u3 = await app.post('/api/app/undo-turn', { turn_id: first!.turn_id });
  expect(u3.packages.map((p: { skipped?: string }) => p.skipped ?? 'tried')).toEqual(['already undone', 'tried']);
  expect(u3.conflicts.map((c: { path: string }) => c.path)).toEqual(['notes/a.md']);
  const after = (await app.get('/api/app/sessions')).sessions[0];
  expect(after.turns.map((t: { undone: boolean }) => t.undone)).toEqual([true, false]);
  expect((await app.post('/api/app/undo-turn', { turn_id: 'tn_nope' })).error).toBe('no such turn');
});

test('an idle session loses its sandbox; the next call starts a new one and carries on', async () => {
  const sb = new FakeSandbox();
  const e = await env('v3', sb);
  const { sid, dir } = await start(e);
  expect((await e.call('bash', { session_id: sid, command: 'echo hi > /work/note' })).text).toContain('ok');
  expect(sb.created).toBe(1);

  quietFor(e, dir, e.ctx.sessions.idleAfterMs + 1000);
  const swept = await e.ctx.sessions.sweep();
  expect(swept.idle).toEqual([dir]);
  expect(sb.destroyed).toBe(1);
  expect(sb.running.size).toBe(0);
  const app = await owner(e);
  expect((await app.get('/api/app/sessions')).sessions[0].status).toBe('idle');

  const again = await e.call('bash', { session_id: sid, command: 'cat /work/note' });
  expect(again.isError).toBe(false);
  expect(again.structured.ok).toBe(true);
  expect(sb.created).toBe(2);
  expect((await app.get('/api/app/sessions')).sessions[0].status).toBe('open');
  expect(e.ctx.drive.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 }); // the same session
});

test('an expired session refuses calls with a typed error, on every surface', async () => {
  const e = await env('v3');
  const { sid, dir } = await start(e);
  quietFor(e, dir, e.ctx.sessions.expireAfterMs + 1000);
  const r = await e.call('bash', { session_id: sid, command: 'ls' });
  expect(r.isError).toBe(true);
  expect(r.structured).toMatchObject({ ok: false, reason: 'expired', next_step: 'Start a new session with start_session(purpose); this one cannot be used again.' });
  expect(r.text).toBe('expired: this session expired after 30 days without calls. Start a new session with start_session(purpose); this one cannot be used again.');
  // Even after a call refreshes nothing: still expired.
  expect((await e.call('bash', { session_id: sid, command: 'ls' })).structured.reason).toBe('expired');

  const v0 = await env('v0');
  const s0 = await start(v0);
  quietFor(v0, s0.dir, v0.ctx.sessions.expireAfterMs + 1000);
  expect((await v0.ctx.sessions.sweep()).expired).toEqual([s0.dir]);
  expect((await v0.call('read', { session_id: s0.sid, path: 'x' })).text).toBe('expired: this session expired after 30 days without calls; start a new one with start_session(purpose)');
});
