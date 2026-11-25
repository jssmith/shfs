// Run the E1-style tasks in OpenCode against the real drive, one at a time, and
// measure each from three sides: OpenCode's JSON events (what the agent did),
// the drive's call log (/api/debug/calls: session ids, transports), and the
// drive's items afterwards (did the work merge, did anything leak).
//
//   AGENT_DRIVE_OWNER_PASSWORD=… OC_HOME=/tmp/a3-cp2/opencode \
//   AGENT_DRIVE_MCP_URL=http://localhost:9320/mcp \
//   node test/harness/opencode/run-e1.ts [--only 01-expenses-summary] [--tasks DIR]
//
// Sign OpenCode in first (auth.sh). Writes $OC_HOME/e1/<task>.jsonl and
// $OC_HOME/e1/results.json, and prints one line per task.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect } from '../client/mcp-client.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    tasks: { type: 'string', default: join(here, 'tasks', 'e1') },
    only: { type: 'string', multiple: true, default: [] },
    timeout: { type: 'string', default: '600' },
  },
});
const mcpUrl = process.env.AGENT_DRIVE_MCP_URL ?? 'http://localhost:9320/mcp';
const server = new URL(mcpUrl).origin;
const ocHome = process.env.OC_HOME ?? '/tmp/a3-cp2/opencode';
const outDir = join(ocHome, 'e1');
mkdirSync(outDir, { recursive: true });
const ownerPassword = process.env.AGENT_DRIVE_OWNER_PASSWORD ?? process.env.AGENT_DRIVE_TEST_PASSWORD;
if (!ownerPassword) throw new Error('set AGENT_DRIVE_OWNER_PASSWORD');

interface TaskSpec { id: string; expect_merged?: string[]; expect_gone?: string[]; reply_includes?: string[]; read_only?: boolean; content_includes?: Record<string, string> }
const spec = JSON.parse(readFileSync(join(values.tasks!, 'tasks.json'), 'utf8')) as { secret: string; tasks: TaskSpec[] };

// --- the owner's view of the drive -------------------------------------------
async function ownerCookie(): Promise<string> {
  const res = await fetch(`${server}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'owner', password: ownerPassword! }),
  });
  const c = res.headers.get('set-cookie');
  if (!c) throw new Error(`owner sign-in failed: ${res.status}`);
  return c.split(';')[0]!;
}
const cookie = await ownerCookie();
async function owner<T>(path: string): Promise<T> {
  const r = await fetch(`${server}${path}`, { headers: { cookie } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}
type Item = { path: string; state: string; reachable: boolean };
type Call = { id: number; ts: string; client_name: string | null; transport_session_id: string | null; tool: string; dir_id: string | null; session_arg: string; transport_changed: number; gap_session_ms: number | null; ok: number; error_reason: string | null };

// --- a verifier: an MCP session of the harness's own, read-only ---------------
const verifier = await connect({ url: mcpUrl, login: 'form', tokenFile: join(outDir, 'verifier-token.json'),
  creds: { user: 'owner', password: ownerPassword } });
async function vcall(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await verifier.client.callTool({ name, arguments: args });
  return (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
}

// --- OpenCode -----------------------------------------------------------------
function runOpencode(prompt: string, jsonl: string): Promise<{ code: number; ms: number }> {
  return new Promise((resolve) => {
    const t = Date.now();
    const out = createWriteStream(jsonl);
    const p = spawn('timeout', [values.timeout!, join(here, 'oc.sh'), 'run', '--format', 'json', prompt], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    p.stdout.pipe(out);
    const err = createWriteStream(jsonl.replace(/\.jsonl$/, '.err'));
    p.stderr.pipe(err);
    p.on('close', (code) => resolve({ code: code ?? -1, ms: Date.now() - t }));
  });
}

type Ev = { type: string; part?: { tool?: string; state?: { status?: string; input?: Record<string, unknown>; output?: string }; text?: string; tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } } };

const results: Record<string, unknown>[] = [];
for (const task of spec.tasks) {
  if (values.only!.length && !values.only!.includes(task.id)) continue;
  const prompt = readFileSync(join(values.tasks!, `${task.id}.txt`), 'utf8').trim();
  const before = await owner<{ calls: Call[] }>('/api/debug/calls?limit=1');
  const lastId = before.calls[0]?.id ?? 0;
  const jsonl = join(outDir, `${task.id}.jsonl`);
  process.stderr.write(`running ${task.id} … `);
  const { code, ms } = await runOpencode(prompt, jsonl);
  process.stderr.write(`exit ${code} in ${ms} ms\n`);

  const events: Ev[] = readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Ev]; } catch { return []; } });
  const toolUses = events.filter((e) => e.type === 'tool_use').map((e) => ({ tool: e.part?.tool ?? '', status: e.part?.state?.status, input: e.part?.state?.input ?? {}, output: e.part?.state?.output ?? '' }));
  const reply = events.filter((e) => e.type === 'text').map((e) => e.part?.text ?? '').join('\n');
  const tok = events.filter((e) => e.type === 'step_finish').map((e) => e.part?.tokens).filter(Boolean) as NonNullable<NonNullable<Ev['part']>['tokens']>[];
  const tokens = {
    steps: tok.length,
    input: tok.reduce((a, t) => a + t.input, 0), cache_read: tok.reduce((a, t) => a + t.cache.read, 0),
    output: tok.reduce((a, t) => a + t.output, 0), reasoning: tok.reduce((a, t) => a + t.reasoning, 0),
  };
  const driveTools = toolUses.filter((t) => t.tool.startsWith('drive_')).map((t) => t.tool.slice('drive_'.length));
  const localTools = toolUses.filter((t) => !t.tool.startsWith('drive_')).map((t) => t.tool);

  // The drive's log of this run's calls (OpenCode only; the verifier is excluded).
  const all = await owner<{ calls: Call[] }>('/api/debug/calls?limit=1000');
  const calls = all.calls.filter((c) => c.id > lastId && c.client_name !== 'agent-drive-harness').reverse();
  const sessionArgs: Record<string, number> = {};
  for (const c of calls) if (c.tool !== 'start_session') sessionArgs[c.session_arg] = (sessionArgs[c.session_arg] ?? 0) + 1;
  const merged = calls.filter((c) => (c.tool === 'checkpoint' || c.tool === 'finish') && c.ok);

  const items = (await owner<{ items: Item[] }>('/api/app/items')).items.filter((i) => i.state === 'live').map((i) => i.path);
  const checks: Record<string, boolean> = {};
  for (const re of task.expect_merged ?? []) checks[`merged ${re}`] = items.some((p) => new RegExp(re).test(p));
  for (const re of task.expect_gone ?? []) checks[`gone ${re}`] = !items.some((p) => new RegExp(re).test(p));
  for (const s of task.reply_includes ?? []) checks[`reply has ${s}`] = reply.includes(s);
  const leakText = [reply, ...toolUses.map((t) => t.output)].join('\n');
  checks['no leak of the ringed card number'] = !leakText.includes(spec.secret) && !/card-for-online-orders/.test(leakText);

  // Verifier: a fresh session sees the merged drive.
  if (task.content_includes || task.id === '03-python-function') {
    const s = (await vcall('start_session', { purpose: `harness: verify ${task.id}` })).match(/session_id: (\S+)/)?.[1];
    for (const [p, needle] of Object.entries(task.content_includes ?? {})) checks[`${p} has ${needle}`] = (await vcall('read', { session_id: s, path: p })).includes(needle);
    if (task.id === '03-python-function') {
      const t = await vcall('run', { session_id: s, command: 'cd household/projects/unitconv && python3 -m pytest -q -p no:cacheprovider 2>&1 | tail -2' });
      checks['tests pass in a fresh session'] = / passed/.test(t) && !/failed|error/i.test(t);
      // grep -c prints a count per file; any non-zero count means a test mentions kilograms or pounds.
      checks['a kg test exists'] = /:[1-9]/.test(await vcall('run', { session_id: s, command: 'grep -rc -i "def test.*\\(kg\\|pound\\)" household/projects/unitconv/tests || true' }));
    }
    await vcall('finish', { session_id: s, summary: 'harness verification, no changes' });
  }

  const r = {
    task: task.id, exit: code, ms,
    completed: Object.values(checks).every(Boolean),
    started_session: driveTools.includes('start_session'),
    first_drive_tool: driveTools[0] ?? null,
    get_skill: driveTools.includes('get_skill'),
    session_args: sessionArgs,
    sessions_started: calls.filter((c) => c.tool === 'start_session').length,
    transports: new Set(calls.map((c) => c.transport_session_id)).size,
    merged: merged.map((c) => c.tool),
    drive_tools: driveTools,
    local_tools: localTools,
    tool_errors: calls.filter((c) => !c.ok).map((c) => `${c.tool}:${c.error_reason}`),
    checks, tokens,
    reply: reply.length > 800 ? `${reply.slice(0, 800)}…` : reply,
  };
  results.push(r);
  console.log(JSON.stringify({ task: r.task, completed: r.completed, started: r.started_session, first: r.first_drive_tool, get_skill: r.get_skill, args: r.session_args, merged: r.merged, local: r.local_tools, errors: r.tool_errors, tokens: r.tokens, ms }));
}
await verifier.client.close();
writeFileSync(join(outDir, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));
