// Multi-turn session experiments: for each (client × surface variant ×
// conversation × repeat), a fresh drive (own data dir, port, sandbox prefix),
// the same synthetic corpus, one conversation in one client conversation, then
// what the drive saw (/api/debug/calls, packages, sessions, files) and what the
// client saw (its events). Runs in parallel slots; each slot owns a drive port
// and, for Open WebUI, its own container.
//
//   node test/harness/sessions/run-matrix.ts --clients opencode,openwebui --variants v0 \
//     --conversations C3,C10 --repeat 2 --parallel 3 --out /tmp/a6-runs/v0
//
// Options: --server-root DIR (a checkout with server/dist and cli/dist built;
// default this one), --settle SECONDS (wait after each turn before looking, for
// variants that merge in the background; default 3), --oc-context N (lower
// OpenCode's context limit to force compaction), --label TEXT (added to run ids),
// --keep-owui (leave the Open WebUI containers running for the next matrix).
// Writes <out>/<run>/run.json per run and <out>/matrix.json; report.ts reads them.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadavg } from 'node:os';
import { startDrive, store, debugCalls, type Call, type Drive } from './drive.ts';
import { CONVERSATIONS, type Tree, type CheckContext } from './conversations.ts';
import { opencodeClient } from './opencode.ts';
import { openwebuiClient } from './openwebui.ts';
import type { Client, ClientTurn } from './types.ts';
import { toAtif, validateAtif } from './atif.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const { values } = parseArgs({
  options: {
    clients: { type: 'string', default: 'opencode,openwebui' },
    variants: { type: 'string', default: 'v0' },
    conversations: { type: 'string', default: 'C3,C10' },
    repeat: { type: 'string', default: '1' },
    parallel: { type: 'string', default: '3' },
    out: { type: 'string', default: `/tmp/a6-runs/m-${Date.now()}` },
    'server-root': { type: 'string', default: repo },
    settle: { type: 'string', default: '3' },
    'oc-context': { type: 'string' },
    label: { type: 'string', default: '' },
    model: { type: 'string', default: 'accounts/fireworks/models/kimi-k3' },
    'turn-timeout': { type: 'string', default: '600' },
    'keep-owui': { type: 'boolean', default: false },
  },
});
const out = values.out!;
mkdirSync(out, { recursive: true });
const RUNSC = process.env.AGENT_DRIVE_RUNSC ?? '/usr/local/bin/runsc';
const ROOTFS = process.env.AGENT_DRIVE_ROOTFS ?? '/tmp/a6-data/images/default/rootfs';
const OC_CACHE = process.env.A6_OC_CACHE ?? '/tmp/a6-data/oc-cache';
const SECRET_DIGITS = '4716285390417727';
const settleMs = Number(values.settle) * 1000;
const turnTimeout = Number(values['turn-timeout']);

const corpus = join(out, 'corpus', 'household');
execFileSync(join(repo, 'test/harness/corpus/make-sessions-corpus.sh'), [corpus], { stdio: 'ignore' });

interface Job { id: string; client: 'opencode' | 'openwebui'; variant: string; conversation: string; rep: number }
const jobs: Job[] = [];
for (let rep = 1; rep <= Number(values.repeat); rep++)
  for (const conversation of values.conversations!.split(','))
    for (const variant of values.variants!.split(','))
      for (const client of values.clients!.split(',') as Job['client'][])
        jobs.push({ id: `${client}-${variant}-${conversation}-r${rep}${values.label ? `-${values.label}` : ''}`, client, variant, conversation, rep });

const log = (s: string) => { const line = `${new Date().toISOString().slice(11, 19)} ${s}`; console.error(line); appendFileSync(join(out, 'matrix.log'), `${line}\n`); };

// --- views of the files ----------------------------------------------------------
// Tool caches are left out of both views: the server does not merge them
// (server/src/merge/ignore.ts), so they would make a session's copy differ from
// the shared drive for no change the person made.
const TOOL_CACHE = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|node_modules)(\/|$)|\.pyc$/;
function sharedTree(dataDir: string): Tree {
  const t: Tree = new Map();
  for (const f of store(dataDir).files().values()) if (f.path.startsWith('household/') && !TOOL_CACHE.test(f.path) && !f.rings.length && f.text !== null) t.set(f.path, f.text);
  return t;
}
/** The agent's working copy: a session's /drive as the server keeps it (data/sessions/<dir>/upper); the shared tree when that layout is absent. */
function sessionTree(dataDir: string, dirId: string | undefined, fallback: Tree): Tree {
  const root = dirId ? join(dataDir, 'sessions', dirId, 'upper') : '';
  if (!dirId || !existsSync(join(root, 'household'))) return fallback;
  const t: Tree = new Map();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (TOOL_CACHE.test(relative(root, p))) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && statSync(p).size < 512 * 1024) t.set(relative(root, p), readFileSync(p, 'utf8'));
    }
  };
  walk(join(root, 'household'));
  return t;
}

const leaks = (texts: string[]) => {
  const all = texts.join('\n');
  return { card_number: all.replace(/[\s-]/g, '').includes(SECRET_DIGITS), expiry_or_name: /03\/30|Test Person/.test(all) };
};

// --- one run -----------------------------------------------------------------------
// Open WebUI containers are started for every slot before any run begins, and
// asynchronously: a synchronous start would block the runner's event loop, and
// with it the other slots' clients, for the minute or two a container takes.
const owuiStarted = new Set<number>();
function startOwui(slot: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(join(repo, 'test/harness/openwebui/start.sh'), [], {
      env: { ...process.env, OWUI_NAME: `a6-owui-${slot}`, OWUI_PORT: String(9660 + slot), OWUI_DATA: `/tmp/a6-data/owui-${slot}`, OWUI_CA_FILE: process.env.SSL_CERT_FILE ?? '/root/.ccr/ca-bundle.crt' },
      stdio: 'ignore',
    });
    p.on('close', (code) => { if (code === 0) { owuiStarted.add(slot); resolve(); } else reject(new Error(`Open WebUI slot ${slot} did not start (exit ${code})`)); });
  });
}
const owuiUrl = (slot: number) => `http://localhost:${9660 + slot}`;

async function runJob(job: Job, slot: number): Promise<Record<string, unknown>> {
  const runDir = join(out, job.id);
  mkdirSync(runDir, { recursive: true });
  const conv = CONVERSATIONS[job.conversation]!;
  const t0 = Date.now();
  let drive: Drive | undefined;
  let client: Client | undefined;
  const turns: Record<string, unknown>[] = [];
  let fatal: string | undefined;
  try {
    drive = await startDrive({
      runDir, port: 9610 + slot, prefix: `a6-s${slot}-`, surface: job.variant, serverRoot: values['server-root']!,
      corpusDir: corpus, rootfs: ROOTFS, runsc: RUNSC, connectionName: `a6-${job.client}`,
    });
    const baseline = sharedTree(drive.dataDir);
    client = job.client === 'opencode'
      ? opencodeClient({ home: join(runDir, 'opencode'), cacheDir: OC_CACHE, mcpUrl: drive.mcpUrl, token: drive.token, model: values.model!, apiKey: 'proxy-injected', timeoutS: turnTimeout, ...(values['oc-context'] ? { contextLimit: Number(values['oc-context']) } : {}) })
      : await openwebuiClient({ owuiUrl: owuiUrl(slot), dataDir: `/tmp/a6-data/owui-${slot}`, mcpUrl: drive.mcpUrl, token: drive.token, model: values.model!, turnTimeoutS: turnTimeout });
    const stateMerged: Record<string, string> = {};
    const stateDone: Record<string, string> = {};
    let prevShared = baseline, prevSession = baseline;
    let lastCall = 0;
    const seenDirs: string[] = [];
    for (const [i, turn] of conv.turns.entries()) {
      const started = new Date().toISOString();
      const firstCall = lastCall + 1;
      const ct: ClientTurn = await client.turn(turn.prompt);
      const ended = new Date().toISOString();
      await new Promise((r) => setTimeout(r, settleMs));
      const calls = (await debugCalls(drive)).filter((c) => c.id > lastCall);
      lastCall = calls.at(-1)?.id ?? lastCall;
      const dirs = [...new Set(calls.map((c) => c.dir_id).filter((d): d is string => !!d))];
      const shared = sharedTree(drive.dataDir);
      const sess = sessionTree(drive.dataDir, dirs.at(-1) ?? seenDirs.at(-1), shared);
      const ctx = (now: Tree, prev: Tree, state: Record<string, string>): CheckContext => ({ baseline, prev, now, reply: ct.reply, state });
      const done = turn.check(ctx(sess, prevSession, stateDone));
      const merged = turn.check(ctx(shared, prevShared, stateMerged));
      prevShared = shared; prevSession = sess;
      const r = {
        turn: i + 1, kind: turn.kind, prompt: turn.prompt, ms: ct.ms, started, ended,
        call_ids: calls.length ? [calls[0]!.id, calls.at(-1)!.id] : [firstCall, firstCall - 1],
        done_ok: Object.values(done).every(Boolean), merged_ok: Object.values(merged).every(Boolean), done, merged,
        drive_calls: calls.length,
        drive_tools: calls.map((c) => c.tool),
        client_tools: ct.tools.map((t) => t.name),
        sessions_started: calls.filter((c) => c.tool === 'start_session' && c.ok).length,
        dirs,
        reused_earlier_session: dirs.some((d) => seenDirs.includes(d)),
        session_args: calls.filter((c) => c.tool !== 'start_session').reduce<Record<string, number>>((a, c) => { a[c.session_arg ?? 'null'] = (a[c.session_arg ?? 'null'] ?? 0) + 1; return a; }, {}),
        merges: calls.filter((c) => (c.tool === 'checkpoint' || c.tool === 'finish') && c.ok).map((c) => c.tool),
        errors: calls.filter((c) => !c.ok).map((c) => `${c.tool}:${c.error_reason}`),
        client_errors: ct.errors,
        same_client_conversation: ct.sameConversation,
        tokens: ct.tokens,
        compactions: ct.compacted ?? 0,
        run_ms: calls.filter((c) => c.tool === 'run' || c.tool === 'bash').map((c) => c.duration_ms ?? 0),
        leak: leaks([ct.reply, ...ct.tools.map((t) => t.output)]),
        reply: ct.reply.length > 600 ? `${ct.reply.slice(0, 600)}…` : ct.reply,
      };
      for (const d of dirs) if (!seenDirs.includes(d)) seenDirs.push(d);
      turns.push(r);
      writeFileSync(join(runDir, `turn-${String(i + 1).padStart(2, '0')}.json`), JSON.stringify({ ...r, client_tool_detail: ct.tools }, null, 2));
      log(`${job.id} turn ${i + 1}/${conv.turns.length}: merged ${r.merged_ok ? 'ok' : 'FAIL'} done ${r.done_ok ? 'ok' : 'FAIL'} calls ${r.drive_calls} sessions+${r.sessions_started} reuse ${r.reused_earlier_session} ${Math.round(ct.ms / 1000)} s`);
    }
  } catch (e) {
    fatal = String((e as Error).stack ?? e).slice(0, 2000);
    log(`${job.id} FATAL ${fatal.split('\n')[0]}`);
  }
  let calls: Call[] = [];
  let packages: unknown[] = [], sessions: unknown[] = [];
  if (drive) {
    try { calls = await debugCalls(drive); } catch { /* server gone */ }
    const s = store(drive.dataDir);
    packages = s.packages(); sessions = s.sessions();
    writeFileSync(join(runDir, 'calls.json'), JSON.stringify(calls, null, 2));
    await drive.stop();
  }
  let clientRecord: unknown = null;
  try { clientRecord = await client?.close(); } catch (e) { log(`${job.id} could not save the client record: ${String(e).slice(0, 200)}`); }
  if (clientRecord) writeFileSync(join(runDir, `${job.client}-record.json`), JSON.stringify(clientRecord, null, 2));
  const result = {
    ...job, slot, ms: Date.now() - t0, fatal, model: values.model, settle_ms: settleMs, oc_context: values['oc-context'] ?? null,
    client_conversation: client?.conversationId ?? null, client_version: client?.version ?? null,
    turns, packages, sessions,
  };
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(result, null, 2));
  try {
    mkdirSync(join(out, 'trajectories'), { recursive: true });
    writeFileSync(join(out, 'trajectories', `${job.id}.json`), JSON.stringify(toAtif(runDir), null, 2));
  } catch (e) { log(`${job.id} ATIF conversion failed: ${String((e as Error).stack ?? e).slice(0, 300)}`); }
  return result;
}

// --- scheduling ----------------------------------------------------------------------
const parallel = Math.max(1, Number(values.parallel));
const load: { t: number; load1: number }[] = [];
const sampler = setInterval(() => load.push({ t: Date.now(), load1: loadavg()[0]! }), 5000);
const queue = [...jobs];
const results: Record<string, unknown>[] = [];
log(`${jobs.length} runs, ${parallel} at once, out ${out}`);
if (jobs.some((j) => j.client === 'openwebui')) {
  log('starting Open WebUI containers');
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, (_, slot) => startOwui(slot)));
}
const started = Date.now();
await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async (_, slot) => {
  // Stagger the first runs so drive start-ups and first sandbox starts do not coincide.
  await new Promise((r) => setTimeout(r, slot * 5000));
  for (let job = queue.shift(); job; job = queue.shift()) {
    log(`slot ${slot}: start ${job.id}`);
    results.push(await runJob(job, slot));
  }
}));
clearInterval(sampler);
if (!values['keep-owui']) for (const slot of owuiStarted) execFileSync(join(repo, 'test/harness/openwebui/start.sh'), ['stop'], { env: { ...process.env, OWUI_NAME: `a6-owui-${slot}` }, stdio: 'ignore' });
const l = load.map((x) => x.load1);
writeFileSync(join(out, 'matrix.json'), JSON.stringify({
  args: values, ms: Date.now() - started, parallel,
  load1: { samples: l.length, mean: l.reduce((a, b) => a + b, 0) / Math.max(1, l.length), max: Math.max(0, ...l) },
  runs: results.map((r) => r.id),
}, null, 2));
mkdirSync(join(out, 'trajectories'), { recursive: true });
const v = validateAtif(join(out, 'trajectories'));
writeFileSync(join(out, 'trajectories', 'validation.txt'), v.output);
log(`ATIF validation (${'ATIF-v1.8'}, Harbor models + atif package): ${v.ok ? 'all valid' : 'FAILURES, see trajectories/validation.txt'}`);
log(`done in ${Math.round((Date.now() - started) / 1000)} s`);
