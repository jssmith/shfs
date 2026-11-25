// How many runs fit on this machine at once without distorting what they
// measure? No model: N drives start at once, each with a scripted client doing
// what a coding turn does in the sandbox (pytest a few times, write, merge),
// on the v0 tool names. Prints sandbox-call latencies per N.
//   node test/harness/sessions/bench-parallel.ts [--max 4] [--rounds 5] [--out /tmp/a6-runs/bench]
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { loadavg } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDrive } from './drive.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const { values } = parseArgs({ options: { max: { type: 'string', default: '4' }, rounds: { type: 'string', default: '5' }, out: { type: 'string', default: '/tmp/a6-runs/bench' } } });
const out = values.out!;
mkdirSync(out, { recursive: true });
const corpus = join(out, 'corpus', 'household');
execFileSync(join(repo, 'test/harness/corpus/make-sessions-corpus.sh'), [corpus], { stdio: 'ignore' });

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };

async function one(slot: number): Promise<{ startMs: number; firstRun: number; runs: number[]; finish: number }> {
  const t0 = Date.now();
  const d = await startDrive({ runDir: join(out, `s${slot}`), port: 9690 + slot, prefix: `a6-b${slot}-`, surface: 'v0', serverRoot: repo, corpusDir: corpus,
    rootfs: '/tmp/a6-data/images/default/rootfs', runsc: '/usr/local/bin/runsc', connectionName: 'a6-bench' });
  const startMs = Date.now() - t0;
  const c = new Client({ name: 'a6-bench', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(d.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${d.token}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = Date.now();
    const r = await c.callTool({ name, arguments: args });
    return { ms: Date.now() - t, text: (r.content as { text?: string }[]).map((x) => x.text ?? '').join('') };
  };
  const sid = /ds_[a-z0-9]+/.exec((await call('start_session', { purpose: 'bench' })).text)![0];
  const runs: number[] = [];
  let firstRun = 0;
  for (let i = 0; i < Number(values.rounds); i++) {
    const r = await call('run', { session_id: sid, command: 'cd household/projects/unitconv && python3 -m pytest -q -p no:cacheprovider' });
    if (!/passed/.test(r.text)) throw new Error(`pytest failed: ${r.text.slice(0, 200)}`);
    if (i === 0) firstRun = r.ms; else runs.push(r.ms);
  }
  await call('write', { session_id: sid, path: 'household/notes/bench.md', content: `bench ${slot}\n` });
  const finish = (await call('finish', { session_id: sid, summary: 'bench' })).ms;
  await c.close();
  await d.stop();
  rmSync(join(out, `s${slot}`), { recursive: true, force: true });
  return { startMs, firstRun, runs, finish };
}

for (let n = 1; n <= Number(values.max); n++) {
  const l0 = loadavg()[0]!;
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => one(i)));
  const runs = rs.flatMap((r) => r.runs);
  console.log(JSON.stringify({
    parallel: n,
    drive_start_ms: Math.max(...rs.map((r) => r.startMs)),
    first_run_ms_max: Math.max(...rs.map((r) => r.firstRun)),
    pytest_run_ms: { median: pct(runs, 0.5), p90: pct(runs, 0.9), max: Math.max(...runs) },
    finish_ms_max: Math.max(...rs.map((r) => r.finish)),
    load1_before: +l0.toFixed(2), load1_after: +loadavg()[0]!.toFixed(2),
  }));
}
