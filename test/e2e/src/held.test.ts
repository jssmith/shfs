// Held items end to end in gVisor (v3): a file the drive cannot read is held,
// so the session's shell does not see it; the person releases it in the app
// and the open session's shell sees it on its next command; undo hides it again.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { put } from '../../../cli/src/index.js';
import { connectAgent, startDrive, PASSWORD, RUNSC, ROOTFS, type Agent, type Drive } from './harness.js';

const haveSandbox = !!(RUNSC && ROOTFS);

describe.skipIf(!haveSandbox)('held items in gVisor (needs AGENT_DRIVE_RUNSC and AGENT_DRIVE_ROOTFS)', () => {
  let d: Drive;
  let agent: Agent;
  let tmp: string;
  beforeAll(async () => {
    d = await startDrive(9418, { surface: 'v3' });
    tmp = mkdtempSync(path.join(os.tmpdir(), 'a7-held-'));
    const root = path.join(tmp, 'home');
    mkdirSync(path.join(root, 'scans'), { recursive: true });
    writeFileSync(path.join(root, 'scans/form-otter.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(' synthetic otter scan ')]));
    writeFileSync(path.join(root, 'scans/readme.txt'), 'Scans of garden forms.\n');
    await put(root, { url: d.url, token: d.deviceToken, labels: [] });
    await d.ctx.jobs.idle();
    agent = await connectAgent(d.url, 'held-agent');
  });
  afterAll(async () => {
    await agent?.close();
    await d?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('release shows the item in an open session at once; undo hides it again', async () => {
    const login = await fetch(`${d.url}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `password=${PASSWORD}` });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const post = async (p: string, body: unknown) =>
      (await fetch(`${d.url}${p}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-drive-app': '1' }, body: JSON.stringify(body) })).json();
    const held = await (await fetch(`${d.url}/api/app/held`, { headers: { cookie } })).json();
    expect(held.items.map((i: { path: string; reason: string }) => [i.path, i.reason])).toEqual([['home/scans/form-otter.bin', 'no_text']]);

    const sid = String((await agent.call('start_session', { purpose: 'look at the scans' })).structured.session_id);
    const ls = async () => (await agent.call('bash', { session_id: sid, command: 'ls /drive/home/scans' })).text;
    expect(await ls()).not.toContain('form-otter');

    const rel = await post('/api/app/held/release', { item_ids: [held.items[0].item_id] });
    expect(rel.ok).toBe(true);
    expect(await ls()).toContain('form-otter.bin');
    const cat = await agent.call('bash', { session_id: sid, command: 'cat /drive/home/scans/form-otter.bin | tr -d "\\000\\001\\002"' });
    expect(cat.text).toContain('synthetic otter scan');
    expect(cat.structured.save ?? null).toBeNull(); // reading it changes nothing to save

    const u = await post('/api/app/undo', { pkg_id: rel.pkg_id });
    expect(u.ok).toBe(true);
    expect(await ls()).not.toContain('form-otter');
    expect(d.ctx.drive.hiddenCounts()).toEqual({ 'held:uncertain': 1 });
  }, 120_000);
});
