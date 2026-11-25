// The thin drive end to end: upload a folder with the CLI, sign in over
// OAuth, work in a session (read, write, a shell command in gVisor),
// checkpoint, check the merged drive, undo, check again.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { put } from '../../../cli/src/index.js';
import { connectAgent, startDrive, RUNSC, ROOTFS, type Agent, type Drive } from './harness.js';

const haveSandbox = !!(RUNSC && ROOTFS);

const made: string[] = [];
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a4-folder-'));
  made.push(dir);
  const root = path.join(dir, 'projects');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), c);
  }
  return root;
}

async function content(d: Drive, p: string): Promise<string | null> {
  const e = d.ctx.drive.reachableView().find((v) => v.path === p);
  return e ? (await d.ctx.drive.blobs.get(e.blob_hash)).toString() : null;
}

describe.skipIf(!haveSandbox)('thin drive end to end (needs AGENT_DRIVE_RUNSC and AGENT_DRIVE_ROOTFS)', () => {
  let d: Drive;
  let agent: Agent;
  beforeAll(async () => {
    d = await startDrive(9411);
  });
  afterAll(async () => {
    await agent?.close();
    await d?.close();
    for (const m of made) rmSync(m, { recursive: true, force: true });
  });

  test('upload, session, checkpoint, undo', async () => {
    const src = folder({ 'garden/plan.md': '# Garden plan\n\nPlant tomatoes in May.\n', 'garden/seeds.txt': 'tomato\nbasil\n', 'readme.txt': 'Synthetic test folder.\n' });
    const up = await put(src, { url: d.url, token: d.deviceToken, labels: ['topic:project:garden'] });
    expect(up.created).toBe(3);
    await d.ctx.jobs.idle();

    // OAuth discovery as a client sees it.
    const prm = await (await fetch(`${d.url}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe(`${d.url}/mcp`);
    const unauth = await fetch(`${d.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain('resource_metadata=');

    agent = await connectAgent(d.url, 'e2e-agent');
    expect((await agent.call('read', { path: 'projects/readme.txt' })).text).toMatch(/^needs_session/);

    const start = await agent.call('start_session', { purpose: 'update the garden plan' });
    expect(start.isError).toBe(false);
    const sid = String(start.structured.session_id);
    expect(sid).toMatch(/^ds_[a-z2-7]{26}$/);
    expect(start.text).toContain('3 files');
    expect(start.text).toContain('topic:project:garden');

    expect((await agent.call('get_skill', { session_id: sid })).text).toContain('/work');
    const found = await agent.call('search', { session_id: sid, query: 'tomatoes' });
    expect(found.text).toContain('/drive/projects/garden/plan.md');

    const read = await agent.call('read', { session_id: sid, path: '/drive/projects/garden/plan.md' });
    expect(read.text).toContain('Plant tomatoes');
    await agent.call('write', { session_id: sid, path: 'projects/garden/plan.md', content: '# Garden plan\n\nPlant tomatoes in May. Water daily.\n' });
    const sh = await agent.call('run', { session_id: sid, command: 'cd projects/garden && sort seeds.txt > sorted-seeds.txt && wc -l sorted-seeds.txt && echo scratch > /work/tmp.txt && python3 -c "print(6*7)"' });
    expect(sh.isError).toBe(false);
    expect(sh.text).toContain('exit code: 0');
    expect(sh.text).toContain('42');
    const net = await agent.call('run', { session_id: sid, command: 'python3 -c "import urllib.request; urllib.request.urlopen(\'http://1.1.1.1\', timeout=3)"' });
    expect(net.text).not.toContain('exit code: 0');

    // A second connection cannot use this session id.
    const other = await connectAgent(d.url, 'other-agent');
    expect((await other.call('read', { session_id: sid, path: 'projects/readme.txt' })).text).toMatch(/^needs_session/);
    await other.close();

    const cp = await agent.call('checkpoint', { session_id: sid, summary: 'Added watering; sorted the seed list' });
    expect(cp.isError).toBe(false);
    const pkg = String(cp.structured.pkg_id);
    expect(await content(d, 'projects/garden/plan.md')).toContain('Water daily');
    expect(await content(d, 'projects/garden/sorted-seeds.txt')).toBe('basil\ntomato\n');
    expect(d.ctx.drive.reachableView().some((v) => v.path.includes('tmp.txt'))).toBe(false); // /work is never merged

    // The owner's app API sees the session and undoes the merge.
    const login = await fetch(`${d.url}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=synthetic-owner-password' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const sessions = await (await fetch(`${d.url}/api/app/sessions`, { headers: { cookie } })).json();
    expect(sessions.sessions[0].purpose).toBe('update the garden plan');
    expect(sessions.sessions[0].agent.declared_name).toBe('e2e-agent');
    expect(sessions.sessions[0].merges[0].pkg_id).toBe(pkg);
    const page = await fetch(`${d.url}/`, { headers: { cookie } });
    expect(await page.text()).toContain('<h2>Sessions</h2>');

    const undo = await (await fetch(`${d.url}/api/app/undo`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-drive-app': '1' }, body: JSON.stringify({ pkg_id: pkg }) })).json();
    expect(undo.conflicts).toEqual([]);
    expect(await content(d, 'projects/garden/plan.md')).toBe('# Garden plan\n\nPlant tomatoes in May.\n');
    expect(await content(d, 'projects/garden/sorted-seeds.txt')).toBeNull();

    // The session sees the undo after its next checkpoint (rebase).
    const cp2 = await agent.call('checkpoint', { session_id: sid, summary: 'sync' });
    expect(cp2.isError).toBe(false);
    expect((await agent.call('run', { session_id: sid, command: 'ls projects/garden; cat projects/garden/plan.md' })).text).not.toContain('Water daily');

    // Instrumentation.
    const calls = await (await fetch(`${d.url}/api/debug/calls`, { headers: { cookie } })).json();
    expect(calls.calls.length).toBeGreaterThan(5);
    expect(calls.calls.some((c: { session_arg: string; client_name: string }) => c.session_arg === 'matched' && c.client_name === 'e2e-agent')).toBe(true);
    expect(calls.calls.some((c: { session_arg: string }) => c.session_arg === 'other_connection')).toBe(true);

    const fin = await agent.call('finish', { session_id: sid, summary: 'done' });
    expect(fin.isError).toBe(false);
    expect((await agent.call('read', { session_id: sid, path: 'projects/readme.txt' })).text).toMatch(/^finished/);
  }, 120_000);
});
