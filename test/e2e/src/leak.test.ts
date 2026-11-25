// Leak test: items the ring check rings (or cannot read) never reach an
// agent: not through search, read, run output, the session directory or
// error messages. They appear only as counts.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { put } from '../../../cli/src/index.js';
import { connectAgent, startDrive, RUNSC, ROOTFS, type Agent, type Drive } from './harness.js';

const haveSandbox = !!(RUNSC && ROOTFS);

// Synthetic markers. Names and contents of hidden items carry them.
const NAME_MARKERS = ['statement-zebra', 'recovery-zebra', 'scan-zebra'];
const CONTENT_MARKERS = ['quokkasecret', '4539', 'ALPHA-BRAVO-CHARLIE', 'wombatbinary'];
const ALL = [...NAME_MARKERS, ...CONTENT_MARKERS];

function noMarkers(s: string, markers = ALL): void {
  for (const m of markers) expect(s, `leaked ${m}`).not.toContain(m);
}

function walkAll(dir: string, out: { name: string; content: string }[] = []): { name: string; content: string }[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkAll(p, out);
    else if (e.isFile() && statSync(p).size < 10_000_000) out.push({ name: p, content: readFileSync(p).toString('latin1') });
    else out.push({ name: p, content: '' });
  }
  return out;
}

describe.skipIf(!haveSandbox)('ringed items never reach an agent (needs AGENT_DRIVE_RUNSC and AGENT_DRIVE_ROOTFS)', () => {
  let d: Drive;
  let agent: Agent;
  let tmp: string;
  beforeAll(async () => {
    d = await startDrive(9412);
    tmp = mkdtempSync(path.join(os.tmpdir(), 'a4-leak-'));
  });
  afterAll(async () => {
    await agent?.close();
    await d?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('hidden items show up only as counts', async () => {
    const root = path.join(tmp, 'home');
    const files: Record<string, string | Buffer> = {
      'money/statement-zebra.txt': 'Account statement for a synthetic person. Card 4539 1488 0343 6467. Codeword quokkasecret.\n',
      'keys/recovery-zebra.txt': 'Your recovery code is ALPHA-BRAVO-CHARLIE. Keep it safe. quokkasecret\n',
      'scans/scan-zebra.bin': Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(' wombatbinary quokkasecret ')]),
      'notes/statement-guide.txt': 'How to read a bank statement: look at the totals first.\n',
    };
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      writeFileSync(path.join(root, p), c);
    }
    await put(root, { url: d.url, token: d.deviceToken, labels: [] });
    await d.ctx.jobs.idle();
    expect(d.ctx.drive.hiddenCounts()).toEqual({ 'held:uncertain': 1, 'ring:credentials': 1, 'ring:finance': 1 });

    agent = await connectAgent(d.url, 'leak-agent');
    const outputs: string[] = [];
    const call = async (tool: string, args: Record<string, unknown>) => {
      const r = await agent.call(tool, args);
      outputs.push(r.text, JSON.stringify(r.structured));
      return r;
    };

    const start = await call('start_session', { purpose: 'look for bank statements' });
    const sid = String(start.structured.session_id);
    expect(start.text).toContain('in_ring: ring:finance (1 item)');
    expect(start.text).toContain('in_ring: ring:credentials (1 item)');
    expect(start.text).toContain('1 file');

    const s1 = await call('search', { session_id: sid, query: 'statement' });
    expect(s1.text).toContain('/drive/home/notes/statement-guide.txt');
    expect(s1.text).toContain('in_ring: ring:finance (1 item)');
    const s2 = await call('search', { session_id: sid, query: 'quokkasecret' });
    expect(s2.text).toContain('No matches you can see');
    expect(s2.structured.hidden).toEqual({ 'ring:finance': 1, 'ring:credentials': 1 });
    await call('search', { session_id: sid, query: 'zebra' });
    await call('search', { session_id: sid, query: 'recovery code' });

    // Reading a hidden path gives exactly the answer a missing path gives.
    const hiddenRead = await agent.call('read', { session_id: sid, path: 'home/money/statement-zebra.txt' });
    const missingRead = await agent.call('read', { session_id: sid, path: 'home/money/nothing-here.txt' });
    expect(hiddenRead.isError).toBe(true);
    expect(hiddenRead.text.replace('statement-zebra', 'X')).toBe(missingRead.text.replace('nothing-here', 'X'));
    noMarkers(hiddenRead.text, CONTENT_MARKERS);
    expect(hiddenRead.text).not.toContain('ring');

    // The shell sees nothing of them.
    const sh = await call('run', { session_id: sid, command: 'ls -laR /drive /work; grep -r -l quokkasecret / 2>/dev/null; find / -xdev -name "*zebra*" 2>/dev/null; cat /drive/home/keys/* 2>&1; echo done' });
    expect(sh.text).toContain('statement-guide.txt');
    expect(sh.text).toContain('done');

    await call('resume_session', { session_id: sid });
    await call('write', { session_id: sid, path: 'home/notes/summary.md', content: 'Found one guide to statements.\n' });
    const cp = await call('checkpoint', { session_id: sid, summary: 'summary of what I found' });
    expect(cp.isError).toBe(false);
    await call('run', { session_id: sid, command: 'ls -laR /drive' });
    await call('get_skill', { session_id: sid });
    // Error paths.
    await call('read', { session_id: 'ds_aaaaaaaaaaaaaaaaaaaaaaaaaa', path: 'x' });
    await call('run', { session_id: sid, command: 'exit 3' });

    for (const o of outputs) noMarkers(o);
    // The session's directories on the host hold none of it, in names or content.
    for (const f of walkAll(path.join(d.dataDir, 'sessions'))) {
      noMarkers(f.name);
      noMarkers(f.content, CONTENT_MARKERS);
    }
  }, 120_000);
});
