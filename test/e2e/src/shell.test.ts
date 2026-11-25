// The shell surfaces end to end in gVisor: bash, the drive command over the
// session's Unix socket, automatic merge (landing, coalescing, conflicts),
// and one session's socket out of another's reach.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { put } from '../../../cli/src/index.js';
import { connectAgent, startDrive, RUNSC, ROOTFS, type Agent, type Drive } from './harness.js';

const haveSandbox = !!(RUNSC && ROOTFS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function content(d: Drive, p: string): Promise<string | null> {
  const e = d.ctx.drive.reachableView().find((v) => v.path === p);
  return e ? (await d.ctx.drive.blobs.get(e.blob_hash)).toString() : null;
}
const packages = (d: Drive) => d.ctx.drive.packages().filter((p) => p.kind === 'checkpoint');

async function seed(d: Drive, tmp: string, files: Record<string, string>): Promise<void> {
  const root = path.join(tmp, 'home');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), c);
  }
  await put(root, { url: d.url, token: d.deviceToken, labels: [] });
  await d.ctx.jobs.idle();
}

describe.skipIf(!haveSandbox)('v2 in gVisor (needs AGENT_DRIVE_RUNSC and AGENT_DRIVE_ROOTFS)', () => {
  let d: Drive;
  let agent: Agent;
  let tmp: string;
  beforeAll(async () => {
    d = await startDrive(9416, { surface: 'v2' });
    tmp = mkdtempSync(path.join(os.tmpdir(), 'a4-shell-'));
    await seed(d, tmp, { 'notes/plan.md': '# Garden plan\n\nPlant tomatoes in May.\n', 'notes/seeds.txt': 'tomato\nbasil\n' });
    agent = await connectAgent(d.url, 'shell-agent');
  });
  afterAll(async () => {
    await agent?.close();
    await d?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('bash changes merge automatically, once per burst; drive save merges at once', async () => {
    const sid = String((await agent.call('start_session', { purpose: 'update the garden plan' })).structured.session_id);
    const which = await agent.call('bash', { session_id: sid, command: 'command -v drive; echo $0; ls -la /run/drive; drive help | head -3', description: 'Look at the drive command' });
    expect(which.text).toContain('/opt/drive/bin/drive');
    expect(which.text).toContain('bash');
    expect(which.text).toMatch(/drive\.sock/);
    expect(which.text).toContain('name: agent-drive');
    expect(which.structured.unsaved_changes).toEqual([]);

    // Three changing commands in a burst: one package after the last.
    const b1 = await agent.call('bash', { session_id: sid, command: "sed -i 's/tomatoes/basil/' home/notes/plan.md", description: 'Plant basil instead' });
    expect(b1.text).toContain('Unsaved changes under /drive: update home/notes/plan.md. They save to the drive automatically in about 2 s.');
    await agent.call('bash', { session_id: sid, command: 'echo "Water daily." >> home/notes/plan.md' });
    await agent.call('bash', { session_id: sid, command: 'sort home/notes/seeds.txt > home/notes/sorted.txt', description: 'Sort the seed list' });
    expect(packages(d)).toHaveLength(0);
    await sleep(2600);
    expect(packages(d)).toHaveLength(1);
    expect(packages(d)[0]!.summary_claimed).toBe('Saved automatically after: Plant basil instead; echo "Water daily." >> home/notes/plan.md; Sort the seed list');
    expect(await content(d, 'home/notes/plan.md')).toBe('# Garden plan\n\nPlant basil in May.\nWater daily.\n');
    expect(await content(d, 'home/notes/sorted.txt')).toBe('basil\ntomato\n');

    const st = await agent.call('bash', { session_id: sid, command: 'drive status' });
    expect(st.text).toMatch(/^\[drive\] Saved to the drive: update home\/notes\/plan\.md, create home\/notes\/sorted\.txt/);
    expect(st.text).toContain('Purpose: update the garden plan');
    expect(st.text).toContain('Unsaved changes: none.');
    expect(st.text).toContain('may not include everything the person has');

    // A command that changes nothing (or only /work, or a tool cache) schedules nothing.
    const quiet = await agent.call('bash', { session_id: sid, command: 'cat home/notes/plan.md > /work/copy.md; mkdir -p home/__pycache__ && echo x > home/__pycache__/a.pyc' });
    expect(quiet.structured.unsaved_changes).toEqual([]);

    const save = await agent.call('bash', { session_id: sid, command: 'echo "- compost" >> home/notes/plan.md && drive save "Add compost to the plan" && drive status | grep "Last save"' });
    expect(save.text).toContain('exit code: 0');
    expect(save.text).toMatch(/Saved to the drive: update home\/notes\/plan\.md \(package pk_/);
    expect(save.text).toContain('(drive save)');
    expect(packages(d).at(-1)!.summary_claimed).toBe('Add compost to the plan');
    expect(await content(d, 'home/notes/plan.md')).toContain('- compost');
    await sleep(2600);
    expect(packages(d)).toHaveLength(2); // the save took the changes; no extra automatic package

    const search = await agent.call('bash', { session_id: sid, command: 'drive search basil; drive search --all basil; cat /work/search-1.txt' });
    expect(search.text).toContain('/drive/home/notes/plan.md');
    expect(search.text).toContain('Full list (');
    expect(search.text).toContain('# drive search basil');
  }, 60_000);

  test('a conflicting automatic merge is reported plainly on the next call', async () => {
    const sid = String((await agent.call('start_session', { purpose: 'edit the seeds' })).structured.session_id);
    await agent.call('bash', { session_id: sid, command: 'echo carrot >> home/notes/seeds.txt' });
    await seed(d, tmp, { 'notes/seeds.txt': 'tomato\nbasil\nfrom the person\n' }); // the person, meanwhile
    await sleep(2600);
    const r = await agent.call('bash', { session_id: sid, command: 'cat home/notes/seeds.txt; cat /work/conflicts/home/notes/seeds.txt' });
    expect(r.text).toMatch(/^\[drive\] merge_conflict: nothing was saved to the drive by the automatic save\. home\/notes\/seeds\.txt: changed in the drive/);
    expect(r.text).toContain('/work/conflicts/home/notes/seeds.txt');
    expect(r.text).toContain('from the person');
    expect(r.text).toContain('carrot');
    expect(await content(d, 'home/notes/seeds.txt')).toBe('tomato\nbasil\nfrom the person\n');
  }, 60_000);

  test("one session's socket is out of another session's reach", async () => {
    const a = String((await agent.call('start_session', { purpose: 'session A' })).structured.session_id);
    const b = String((await agent.call('start_session', { purpose: 'session B' })).structured.session_id);
    await agent.call('bash', { session_id: b, command: 'true' });
    const dirs = d.ctx.drive.db.prepare('SELECT dir_id, purpose FROM sessions').all() as { dir_id: string; purpose: string }[];
    const dirB = dirs.find((x) => x.purpose === 'session B')!.dir_id;
    const hostSockB = path.join(d.ctx.sessions.dirs(dirB).sock, 'drive.sock');
    const probe = [
      'ls -la /run/drive',
      'drive status | head -1',
      `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${hostSockB}')" 2>&1 | tail -1`,
      `ls ${path.dirname(hostSockB)} 2>&1 | tail -1`,
      'touch /run/drive/x 2>&1 | tail -1',
      'ls /run/drive /opt/drive/bin',
    ].join('; echo @@@; ');
    const r = await agent.call('bash', { session_id: a, command: probe });
    const parts = r.text.split('@@@');
    expect(parts[1]).toContain('Purpose: session A');
    expect(parts[2]).toMatch(/No such file or directory|FileNotFoundError/);
    expect(parts[3]).toContain('No such file or directory');
    expect(parts[4]).toMatch(/Read-only file system|Permission denied/);
    expect(parts[5]!.match(/drive\.sock/g)).toHaveLength(1);
    expect((await agent.call('bash', { session_id: b, command: 'drive status | head -1' })).text).toContain('Purpose: session B');
  }, 60_000);
});
