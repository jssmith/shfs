// The shell surfaces end to end in gVisor: bash, the drive command over the
// session's Unix socket, the save at the end of each changing call (and its
// conflicts), idle sessions coming back, and one session's socket out of
// another's reach.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { put } from '../../../cli/src/index.js';
import { connectAgent, startDrive, RUNSC, ROOTFS, type Agent, type Drive } from './harness.js';

const haveSandbox = !!(RUNSC && ROOTFS);

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

  test('each changing bash command is saved before its result returns; drive save sets the message', async () => {
    const sid = String((await agent.call('start_session', { purpose: 'update the garden plan' })).structured.session_id);
    const which = await agent.call('bash', { session_id: sid, command: 'command -v drive; echo $0; ls -la /run/drive; drive help | head -3', description: 'Look at the drive command' });
    expect(which.text).toContain('/opt/drive/bin/drive');
    expect(which.text).toContain('bash');
    expect(which.text).toMatch(/drive\.sock/);
    expect(which.text).toContain('name: agent-drive');
    expect(which.structured.save).toBeNull();

    const b1 = await agent.call('bash', { session_id: sid, command: "sed -i 's/tomatoes/basil/' home/notes/plan.md", description: 'Plant basil instead' });
    expect(b1.text).toMatch(/Saved to the drive: update home\/notes\/plan\.md \(package pk_[a-z2-7]+\)\.$/);
    expect(b1.structured.save).toMatchObject({ ok: true, changes: [{ kind: 'update', path: 'home/notes/plan.md' }] });
    expect(await content(d, 'home/notes/plan.md')).toBe('# Garden plan\n\nPlant basil in May.\n');
    const b2 = await agent.call('bash', { session_id: sid, command: 'echo "Water daily." >> home/notes/plan.md && sort home/notes/seeds.txt > home/notes/sorted.txt' });
    expect(b2.text).toContain('Saved to the drive: update home/notes/plan.md, create home/notes/sorted.txt');
    expect(packages(d).map((p) => p.summary_claimed)).toEqual(['Plant basil instead', 'echo "Water daily." >> home/notes/plan.md && sort home/notes/seeds.txt > home/notes/sorted.txt']);
    expect(await content(d, 'home/notes/sorted.txt')).toBe('basil\ntomato\n');

    const st = await agent.call('bash', { session_id: sid, command: 'drive status' });
    expect(st.text).not.toContain('[drive]');
    expect(st.text).toContain('Purpose: update the garden plan');
    expect(st.text).toContain('Unsaved changes: none.');
    expect(st.text).toContain('may not include everything the person has');

    // A command that changes nothing (or only /work, or a tool cache) saves nothing.
    const quiet = await agent.call('bash', { session_id: sid, command: 'cat home/notes/plan.md > /work/copy.md; mkdir -p home/__pycache__ && echo x > home/__pycache__/a.pyc' });
    expect(quiet.structured.save).toBeNull();
    expect(packages(d)).toHaveLength(2);

    const save = await agent.call('bash', { session_id: sid, command: 'echo "- compost" >> home/notes/plan.md && drive save "Add compost to the plan" && drive status | grep "Last save"' });
    expect(save.text).toContain('exit code: 0');
    expect(save.text).toMatch(/Saved to the drive: update home\/notes\/plan\.md \(package pk_/);
    expect(save.text).toContain('(drive save)');
    expect(save.structured.save).toBeNull(); // drive save took the change; nothing left for the end of the call
    expect(packages(d).at(-1)!.summary_claimed).toBe('Add compost to the plan');
    expect(packages(d)).toHaveLength(3);
    expect(await content(d, 'home/notes/plan.md')).toContain('- compost');

    const search = await agent.call('bash', { session_id: sid, command: 'drive search basil; drive search --all basil; cat /work/search-1.txt' });
    expect(search.text).toContain('/drive/home/notes/plan.md');
    expect(search.text).toContain('Full list (');
    expect(search.text).toContain('# drive search basil');
  }, 60_000);

  test('a conflicting save is reported plainly in the same call', async () => {
    const sid = String((await agent.call('start_session', { purpose: 'edit the seeds' })).structured.session_id);
    await seed(d, tmp, { 'notes/seeds.txt': 'tomato\nbasil\nfrom the person\n' }); // the person, meanwhile
    const r = await agent.call('bash', { session_id: sid, command: 'echo carrot >> home/notes/seeds.txt' });
    expect(r.text).toMatch(/merge_conflict: nothing was saved to the drive\. home\/notes\/seeds\.txt: changed in the drive/);
    expect(r.text).toContain('/work/conflicts/home/notes/seeds.txt');
    expect(r.structured.save).toMatchObject({ ok: false, reason: 'merge_conflict' });
    const look = await agent.call('bash', { session_id: sid, command: 'cat home/notes/seeds.txt; cat /work/conflicts/home/notes/seeds.txt' });
    expect(look.text).toContain('from the person');
    expect(look.text).toContain('carrot');
    expect(await content(d, 'home/notes/seeds.txt')).toBe('tomato\nbasil\nfrom the person\n');
  }, 60_000);

  test('an idle session loses its sandbox and the next call carries on in a new one', async () => {
    const sid = String((await agent.call('start_session', { purpose: 'idle and back' })).structured.session_id);
    await agent.call('bash', { session_id: sid, command: 'echo remembered > /work/note.txt' });
    const dir = (d.ctx.drive.db.prepare("SELECT dir_id FROM sessions WHERE purpose = 'idle and back'").get() as { dir_id: string }).dir_id;
    const id = d.ctx.sessions.sandboxId(dir);
    expect(await d.ctx.sessions.sandbox.list()).toContain(id);
    d.ctx.drive.db.prepare('UPDATE sessions SET last_call_at = ? WHERE dir_id = ?').run(new Date(Date.now() - d.ctx.sessions.idleAfterMs - 1000).toISOString(), dir);
    expect((await d.ctx.sessions.sweep()).idle).toEqual([dir]);
    expect(await d.ctx.sessions.sandbox.list()).not.toContain(id);
    const back = await agent.call('bash', { session_id: sid, command: 'cat /work/note.txt; drive status | head -1' });
    expect(back.isError).toBe(false);
    expect(back.text).toContain('remembered');
    expect(back.text).toContain('Purpose: idle and back');
    expect(await d.ctx.sessions.sandbox.list()).toContain(id);
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

describe.skipIf(!haveSandbox)('v3 in gVisor (needs AGENT_DRIVE_RUNSC and AGENT_DRIVE_ROOTFS)', () => {
  let d: Drive;
  let agent: Agent;
  let tmp: string;
  beforeAll(async () => {
    d = await startDrive(9417, { surface: 'v3' });
    tmp = mkdtempSync(path.join(os.tmpdir(), 'a4-shell3-'));
    await seed(d, tmp, { 'notes/plan.md': 'one\ntwo\nthree\n' });
    agent = await connectAgent(d.url, 'shell3-agent');
  });
  afterAll(async () => {
    await agent?.close();
    await d?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('only start_session and bash; files are read and written through the shell and merge automatically', async () => {
    const tools = (await agent.client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['bash', 'start_session']);
    expect((await agent.call('read', { session_id: 'x', file_path: 'y' })).isError).toBe(true);
    const sid = String((await agent.call('start_session', { purpose: 'number the plan' })).structured.session_id);
    const cat = await agent.call('bash', { session_id: sid, command: 'cat -n home/notes/plan.md' });
    expect(cat.text).toContain('     2\ttwo');
    const w = await agent.call('bash', { session_id: sid, command: "cat > home/notes/new.md <<'EOF'\nwritten through the shell\nEOF", description: 'Write a new note' });
    expect(w.text).toContain('Saved to the drive: create home/notes/new.md');
    expect(await content(d, 'home/notes/new.md')).toBe('written through the shell\n');
  }, 60_000);
});
