// MCP tools over HTTP without a sandbox: a failed finish leaves the session
// open and a second finish works; the call log carries both client names.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp, type HttpServer } from '../http.js';
import { tempContext, upload, settle } from '../testing.js';
import { all } from '../store/db.js';

const PORT = 9423 + Number(process.env.AGENT_DRIVE_TEST_PORT_OFFSET ?? 0);
let ctx: ReturnType<typeof tempContext>;
let http: HttpServer;
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
  return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: !!r.isError, structured: r.structuredContent ?? {} };
}

beforeAll(async () => {
  ctx = tempContext();
  ctx.config.port = PORT;
  ctx.config.publicUrl = `http://127.0.0.1:${PORT}`;
  http = await startHttp(ctx);
  const conn = http.provider.directConnection('Open WebUI');
  client = new Client({ name: 'mcp', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { authorization: `Bearer ${conn.tokens.access_token}` } } }));
});
afterAll(async () => {
  await client.close();
  await http.close();
  await ctx.dispose();
});

test('a failed finish says the session is still open; resume and a second finish work', async () => {
  await upload(ctx, { 'notes/plan.md': 'v1\n', 'notes/other.md': 'other\n' });
  await settle(ctx);
  const sid = String((await call('start_session', { purpose: 'edit the plan' })).structured.session_id);
  await call('write', { session_id: sid, path: 'notes/plan.md', content: 'v1 plus agent line\n' });
  await call('write', { session_id: sid, path: 'notes/new.md', content: 'a new note\n' });
  // The person changes the same file meanwhile.
  await upload(ctx, { 'notes/plan.md': 'v2 by the person\n' });
  await settle(ctx);

  const fin = await call('finish', { session_id: sid, summary: 'edited the plan' });
  expect(fin.isError).toBe(true);
  expect(fin.text).toMatch(/^merge_conflict: /);
  expect(fin.text).toContain('NOT finished');
  expect(fin.text).toContain('needs_resolution');
  expect(fin.text).toContain('/work/conflicts/notes/plan.md');
  expect(fin.structured.status).toBe('needs_resolution');
  const dir = ctx.sessions.byDir(all<{ dir_id: string }>(ctx.drive.db, 'SELECT dir_id FROM sessions')[0]!.dir_id)!;
  expect(dir.status).toBe('needs_resolution');
  const work = ctx.sessions.dirs(dir.dir_id).work;
  expect(readFileSync(path.join(work, 'conflicts/notes/plan.md'), 'utf8')).toBe('v1 plus agent line\n');

  const res = await call('resume_session', { session_id: sid });
  expect(res.isError).toBe(false);
  expect(res.text).toContain('needs_resolution');
  expect(res.text).toContain('create notes/new.md');

  // /drive now shows the person's version; the agent redoes its change on top.
  expect((await call('read', { session_id: sid, path: 'notes/plan.md' })).text).toBe('v2 by the person\n');
  await call('write', { session_id: sid, path: 'notes/plan.md', content: 'v2 by the person\nplus agent line\n' });
  const fin2 = await call('finish', { session_id: sid, summary: 'edited the plan' });
  expect(fin2.isError).toBe(false);
  expect(fin2.text).toContain('Session finished');
  const plan = ctx.drive.reachableView().find((v) => v.path === 'notes/plan.md')!;
  expect((await ctx.drive.blobs.get(plan.blob_hash)).toString()).toBe('v2 by the person\nplus agent line\n');
  expect(ctx.drive.reachableView().some((v) => v.path === 'notes/new.md')).toBe(true);
  expect(existsSync(path.join(work, 'conflicts/notes/plan.md'))).toBe(true);
});

test('the call log records the registered client name next to the initialize name', async () => {
  const rows = all<{ client_name: string; registered_name: string }>(ctx.drive.db, 'SELECT client_name, registered_name FROM calls');
  expect(rows.length).toBeGreaterThan(3);
  for (const r of rows) {
    expect(r.client_name).toBe('mcp');
    expect(r.registered_name).toBe('Open WebUI');
  }
});
