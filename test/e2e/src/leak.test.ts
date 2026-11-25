// Leak test, for every surface: items the ring check rings (or cannot read)
// never reach an agent: not through search, read, shell output, the session
// directory or error messages. Search reports them only as counts that match
// on metadata (labels, kind, month), so guessing their content gives no signal.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { put } from '../../../cli/src/index.js';
import type { Surface } from '../../../server/src/context.js';
import { connectAgent, startDrive, RUNSC, ROOTFS, type Agent, type Drive } from './harness.js';

const haveSandbox = !!(RUNSC && ROOTFS);

// Synthetic markers. Names and contents of hidden items carry them.
const NAME_MARKERS = ['statement-zebra', 'recovery-zebra', 'scan-zebra'];
const CONTENT_MARKERS = ['quokkasecret', '4539', 'ALPHA-BRAVO-CHARLIE', 'wombatbinary', 'Expiry 09/29'];
const ALL = [...NAME_MARKERS, ...CONTENT_MARKERS];

// Guesses about a ringed file's text: the right one and a wrong one must get the same answer.
const GUESSES: [string, string][] = [
  ['Expiry 09/29', 'Expiry 10/29'],
  ['4539 1488 0343 6467', '4539 1488 0343 6468'],
  ['quokkasecret', 'quokkasecrex'],
  ['ALPHA-BRAVO-CHARLIE', 'ALPHA-BRAVO-DELTA'],
  ['Test Person', 'Other Person'],
  ['statement-zebra', 'statement-yak'],
];

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

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const SURFACES: { surface: Surface; port: number }[] = [
  { surface: 'v0', port: 9412 },
  { surface: 'v1', port: 9413 },
  { surface: 'v2', port: 9414 },
  { surface: 'v3', port: 9415 },
];

describe.skipIf(!haveSandbox).each(SURFACES)('ringed items never reach an agent on $surface (needs AGENT_DRIVE_RUNSC and AGENT_DRIVE_ROOTFS)', ({ surface, port }) => {
  const shell = surface === 'v2' || surface === 'v3';
  let d: Drive;
  let agent: Agent;
  let tmp: string;
  beforeAll(async () => {
    d = await startDrive(port, { surface });
    tmp = mkdtempSync(path.join(os.tmpdir(), 'a4-leak-'));
  });
  afterAll(async () => {
    await agent?.close();
    await d?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('hidden items show up only as metadata counts', async () => {
    const root = path.join(tmp, 'home');
    const files: Record<string, string | Buffer> = {
      'money/statement-zebra.txt': 'Account statement for Test Person. Card 4539 1488 0343 6467, Expiry 09/29. Codeword quokkasecret.\n',
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
    const sh = (sid: string, command: string) => call(shell ? 'bash' : 'run', { session_id: sid, command });
    // What a search shows the agent, on this surface.
    const search = async (sid: string, q: string) => {
      if (shell) return (await sh(sid, `drive search ${shq(q)}`)).text;
      const r = await call('search', { session_id: sid, query: q });
      return `${r.text}\n${JSON.stringify(r.structured)}`;
    };

    const start = await call('start_session', { purpose: 'look for bank statements' });
    const sid = String(start.structured.session_id);
    expect(start.text).toContain('1 file');
    if (!shell) {
      expect(start.text).toContain('in_ring: ring:finance (1 item)');
      expect(start.text).toContain('in_ring: ring:credentials (1 item)');
    }

    const s1 = await search(sid, 'statement');
    expect(s1).toContain('/drive/home/notes/statement-guide.txt');
    // Content guesses: the right guess and a wrong one read the same, and neither mentions hidden matches.
    for (const [right, wrong] of GUESSES) {
      const a = await search(sid, right);
      const b = await search(sid, wrong);
      expect(a, `guess ${right}`).toBe(b);
      expect(a).not.toMatch(/ring:|Finance|Credentials|Held/);
    }
    // Labels do match: the ring itself is metadata the session already has as a count.
    const byLabel = await search(sid, 'finance');
    expect(byLabel).toMatch(shell ? /Finance: 1 item matches by label/ : /in_ring: ring:finance \(1 item\)/);

    // Reading a hidden path gives exactly the answer a missing path gives.
    const readArgs = (p: string) => (shell ? { session_id: sid, file_path: p } : { session_id: sid, path: p });
    if (surface !== 'v3') {
      const hiddenRead = await agent.call('read', readArgs('home/money/statement-zebra.txt'));
      const missingRead = await agent.call('read', readArgs('home/money/nothing-here.txt'));
      expect(hiddenRead.isError).toBe(true);
      expect(hiddenRead.text.replace('statement-zebra', 'X')).toBe(missingRead.text.replace('nothing-here', 'X'));
      noMarkers(hiddenRead.text, CONTENT_MARKERS);
      expect(hiddenRead.text).not.toContain('ring');
    }

    // The shell sees nothing of them.
    const ls = await sh(sid, 'ls -laR /drive /work; grep -r -l quokkasecret / 2>/dev/null; find / -xdev -name "*zebra*" 2>/dev/null; cat /drive/home/keys/* 2>&1; echo done');
    expect(ls.text).toContain('statement-guide.txt');
    expect(ls.text).toContain('done');

    if (shell) {
      await sh(sid, 'drive status; drive help >/dev/null; drive search --all quokkasecret; cat /work/search-*.txt');
      const w =
        surface === 'v2'
          ? await call('write', { session_id: sid, file_path: 'home/notes/summary.md', content: 'Found one guide to statements.\n' })
          : await sh(sid, "printf 'Found one guide to statements.\\n' > home/notes/summary.md");
      expect(w.text).toContain('Saved to the drive: create home/notes/summary.md');
      await sh(sid, 'drive save "summary of what I found"; drive status');
      await sh(sid, 'ls -laR /drive');
      await call('bash', { session_id: 'ds_aaaaaaaaaaaaaaaaaaaaaaaaaa', command: 'ls' });
    } else {
      await call('resume_session', { session_id: sid });
      await call('write', { session_id: sid, path: 'home/notes/summary.md', content: 'Found one guide to statements.\n' });
      const cp = await call('checkpoint', { session_id: sid, summary: 'summary of what I found' });
      expect(cp.isError).toBe(false);
      await sh(sid, 'ls -laR /drive');
      await call('get_skill', { session_id: sid });
      await call('read', { session_id: 'ds_aaaaaaaaaaaaaaaaaaaaaaaaaa', path: 'x' });
    }
    await sh(sid, 'exit 3');

    for (const o of outputs) noMarkers(o);
    // The session's directories on the host hold none of it, in names or content.
    for (const f of walkAll(path.join(d.dataDir, 'sessions'))) {
      noMarkers(f.name);
      noMarkers(f.content, CONTENT_MARKERS);
    }
  }, 120_000);
});
