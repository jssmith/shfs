// The surfaces behind AGENT_DRIVE_SURFACE, over HTTP with the SDK client,
// without a sandbox: tool lists, wording, typed results.
import { afterEach, expect, test } from 'vitest';
import { upload, settle } from '../testing.js';
import { mcpEnv, type McpEnv } from './test-env.js';
import { parseSurface, type Surface } from '../context.js';
import { CLASSIC_WORDING } from './classic.js';
import { SERVER_INSTRUCTIONS } from './skill.js';

let port = 9430;
const open: McpEnv[] = [];
async function surfaceEnv(surface: Surface): Promise<McpEnv> {
  const e = await mcpEnv(surface, port++);
  open.push(e);
  return e;
}

afterEach(async () => {
  for (const e of open.splice(0)) await e.close();
});

test('AGENT_DRIVE_SURFACE picks one of four surfaces, v0 by default', () => {
  expect(parseSurface(undefined)).toBe('v0');
  expect(parseSurface('v2')).toBe('v2');
  expect(() => parseSurface('v9')).toThrow(/v0, v1, v2, v3/);
});

test('v0 is the checkpoint-2 surface, untyped', async () => {
  const e = await surfaceEnv('v0');
  expect(e.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  const { tools } = await e.client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(['checkpoint', 'finish', 'get_skill', 'read', 'resume_session', 'run', 'search', 'start_session', 'write']);
  expect(tools.find((t) => t.name === 'finish')!.description).toBe('Merge your changes and close the session.');
  expect(tools.every((t) => !t.outputSchema)).toBe(true);
  const r = await e.call('read', { path: 'x' });
  expect(r.text).toBe('needs_session: pass the session_id from start_session; start one with start_session(purpose) if you have none');
});

test('v1 rewords finish, checkpoint, instructions and start_session; results are typed', async () => {
  const e = await surfaceEnv('v1');
  await upload(e.ctx, { 'notes/plan.md': 'line one\n' });
  await settle(e.ctx);
  expect(e.client.getInstructions()).toContain('One session per conversation, not per request: reuse the session_id for follow-up requests.');
  const { tools } = await e.client.listTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  expect(Object.keys(by).sort()).toEqual(['checkpoint', 'finish', 'get_skill', 'read', 'resume_session', 'run', 'search', 'start_session', 'write']);
  expect(by.finish!.description).toBe(
    'Merge your changes and close the session. Only call this when the person says they are done or the conversation is ending. For the next request in the same conversation, keep using the same session_id; use checkpoint to merge work as you go.',
  );
  expect(by.checkpoint!.description).toContain('Call this when a piece of work is done, before you answer the person.');
  expect(by.start_session!.description).toContain('Pull together my 2025 tax documents');
  const props = (n: string) => by[n]!.inputSchema.properties as Record<string, { description?: string }>;
  expect(props('run').command!.description).toBe(CLASSIC_WORDING.v1.command);
  expect(props('search').query!.description).toBe(CLASSIC_WORDING.v1.query);
  expect(props('read').path!.description).toBe(CLASSIC_WORDING.v1.path);
  expect(props('write').content!.description).toBe(CLASSIC_WORDING.v1.content);
  for (const t of tools) expect(t.outputSchema?.properties, t.name).toHaveProperty('ok');

  const start = await e.call('start_session', { purpose: 'edit the plan' });
  expect(start.structured.ok).toBe(true);
  expect(start.text).toContain('Keep this session_id for this whole conversation, including later requests.');
  const sid = String(start.structured.session_id);

  const none = await e.call('read', { path: 'x' });
  expect(none.isError).toBe(true);
  expect(none.structured).toMatchObject({ ok: false, reason: 'needs_session' });
  expect(none.text).toMatch(/^needs_session: /);
  expect(none.text).toMatch(/Call start_session\(purpose\) and pass the session_id it returns to every other tool\.$/);

  const missing = await e.call('read', { session_id: sid, path: 'notes/nope.md' });
  expect(missing.structured).toMatchObject({ ok: false, reason: 'not_found', next_step: expect.any(String) });
  expect(missing.text).toMatch(/^not_found: .*\. Check the path/);

  expect((await e.call('read', { session_id: sid, path: 'notes/plan.md' })).structured.ok).toBe(true);
  await e.call('write', { session_id: sid, path: 'notes/plan.md', content: 'line one\nline two\n' });
  await upload(e.ctx, { 'notes/plan.md': 'the person changed it\n' });
  await settle(e.ctx);
  const cp = await e.call('checkpoint', { session_id: sid, summary: 'add a line' });
  expect(cp.structured).toMatchObject({ ok: false, reason: 'merge_conflict' });
  expect(cp.text).toMatch(/^merge_conflict: nothing was merged\..*then call checkpoint again\.$/s);
  const fin = await e.call('finish', { session_id: sid, summary: 'nothing' });
  expect(fin.structured.ok).toBe(true);
  const after = await e.call('read', { session_id: sid, path: 'notes/plan.md' });
  expect(after.structured).toMatchObject({ ok: false, reason: 'finished', next_step: 'Start a new session with start_session(purpose).' });
});
