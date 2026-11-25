// One run of run-matrix.ts as an ATIF trajectory (Agent Trajectory Interchange
// Format, Harbor RFC 0001, pinned at ATIF-v1.8: the version the RFC defines at
// harbor-framework/harbor 90f2ee3, 2026-11-24).
//
//   node test/harness/sessions/atif.ts RUN_DIR [OUT.json]     # convert one run
//   validateAtif(dir) from run-matrix.ts                      # validate a directory
//
// Sources: the client's own record for model steps, tool calls and observations
// (OpenCode's --format json events plus reasoning from its opencode.db; Open
// WebUI's stored chat), the drive's /api/debug/calls (calls.json) for the server
// side of each drive tool call, and run.json for turn boundaries, checks and
// the drive's packages and sessions. Drive-specific facts go in `extra`.
//
// Secrets: drive session ids (ds_…) are replaced by `ds_<hash:…>`, the first 12
// hex digits of the server's own session_id_hash (sha256 of "agent-drive:" + id),
// so a trajectory links to the sessions table without carrying the secret. A
// trajectory that still contains a bearer token or any secret the server issues
// (prefix + 26 base32 characters) is refused.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { Call } from './drive.ts';

export const ATIF_VERSION = 'ATIF-v1.8';
export const HARBOR_COMMIT = '90f2ee3c18d394eb0da0070415c6297eb13b87f8';

const hashId = (id: string) => createHash('sha256').update(`agent-drive:${id}`).digest('hex');
const redact = (s: string) => s.replace(/\bds_[a-z2-7]{26}\b/g, (m) => `ds_<hash:${hashId(m).slice(0, 12)}>`);
const redactDeep = <T>(v: T): T => JSON.parse(redact(JSON.stringify(v))) as T;

type Json = Record<string, unknown>;
interface ToolCall { tool_call_id: string; function_name: string; arguments: Json; extra?: Json }
interface ObsResult { source_call_id?: string; content?: string; extra?: Json }
interface Step {
  step_id: number; timestamp?: string; source: 'system' | 'user' | 'agent'; model_name?: string; message: string;
  reasoning_content?: string; tool_calls?: ToolCall[]; observation?: { results: ObsResult[] };
  metrics?: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; extra?: Json };
  llm_call_count?: number; extra?: Json;
}

interface RunTurn {
  turn: number; kind: string; prompt: string; started?: string; ended?: string; call_ids?: [number, number]; ms: number;
  done_ok: boolean; merged_ok: boolean; done: Json; merged: Json; errors: string[]; client_errors: string[];
  tokens: { input: number; cached: number; output: number }; compactions: number; dirs: string[];
}
interface Run {
  id: string; client: string; variant: string; conversation: string; rep: number; slot: number; ms: number; fatal?: string;
  model: string; settle_ms: number; oc_context: string | null; client_conversation: string | null; client_version: string | null;
  turns: RunTurn[]; packages: { pkg_id: string; kind: string; summary_claimed: string | null; operations: string; created_at: string }[];
  sessions: { dir_id: string; session_id_hash?: string; purpose: string; status: string; created_at: string; last_call_at: string }[];
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : undefined);

/** A drive tool call's server-side record, for tool_call.extra.drive. */
function driveExtra(c: Call | undefined): Json | undefined {
  if (!c) return undefined;
  return { call_id: c.id, tool: c.tool, dir_id: c.dir_id, session_arg: c.session_arg, ok: !!c.ok, error_reason: c.error_reason, duration_ms: c.duration_ms, transport_changed: !!c.transport_changed, ts: c.ts };
}

/** Matches client tool calls named drive_<tool> to the drive's calls in the turn's id window, in order. */
function matcher(calls: Call[], window: [number, number] | undefined) {
  const pool = calls.filter((c) => window && c.id >= window[0] && c.id <= window[1]);
  const used = new Set<number>();
  return (name: string): Call | undefined => {
    if (!name.startsWith('drive_')) return undefined;
    const tool = name.slice('drive_'.length);
    const c = pool.find((x) => !used.has(x.id) && x.tool === tool);
    if (c) used.add(c.id);
    return c;
  };
}

// --- OpenCode ------------------------------------------------------------------------
type OcEv = {
  type: string; timestamp?: number; sessionID?: string;
  part?: { id?: string; messageID?: string; callID?: string; tool?: string; text?: string; reason?: string; time?: { start?: number; end?: number };
    state?: { status?: string; input?: Json; output?: string; error?: string; time?: { start?: number; end?: number } };
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }; cost?: number };
  error?: unknown;
};

function opencodeSteps(runDir: string, run: Run, calls: Call[], next: () => number): { steps: Step[]; perTurn: Step[][] } {
  const home = join(runDir, 'opencode');
  const reasoning = new Map<string, string>();
  const dbFile = join(home, 'data', 'opencode', 'opencode.db');
  if (existsSync(dbFile)) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      for (const r of db.prepare("SELECT message_id, data FROM part WHERE json_extract(data, '$.type') = 'reasoning' ORDER BY id").all() as { message_id: string; data: string }[]) {
        const t = (JSON.parse(r.data) as { text?: string }).text ?? '';
        if (t) reasoning.set(r.message_id, [reasoning.get(r.message_id), t].filter(Boolean).join('\n'));
      }
    } finally { db.close(); }
  }
  const steps: Step[] = [];
  const perTurn: Step[][] = [];
  for (const t of run.turns) {
    const file = join(home, `turn-${String(t.turn).padStart(2, '0')}.jsonl`);
    const evs: OcEv[] = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as OcEv]; } catch { return []; } }) : [];
    const match = matcher(calls, t.call_ids);
    const mine: Step[] = [];
    let cur: { texts: string[]; tools: ToolCall[]; results: ObsResult[]; start?: number; msg?: string } | undefined;
    for (const e of evs) {
      if (e.type === 'step_start') cur = { texts: [], tools: [], results: [], start: e.timestamp, msg: e.part?.messageID };
      else if (e.type === 'text' && cur) cur.texts.push(e.part?.text ?? '');
      else if (e.type === 'tool_use' && cur) {
        const id = e.part?.callID ?? `call_${cur.tools.length}`;
        const name = e.part?.tool ?? '';
        const dc = match(name);
        cur.tools.push({ tool_call_id: id, function_name: name, arguments: e.part?.state?.input ?? {}, extra: { status: e.part?.state?.status, ...(dc ? { drive: driveExtra(dc) } : {}) } });
        cur.results.push({ source_call_id: id, content: String(e.part?.state?.output ?? e.part?.state?.error ?? ''), extra: { status: e.part?.state?.status } });
      } else if (e.type === 'step_finish' && cur) {
        const tok = e.part?.tokens;
        const msg = e.part?.messageID ?? cur.msg;
        const s: Step = {
          step_id: next(), timestamp: iso(e.timestamp ?? cur.start), source: 'agent', model_name: run.model, message: cur.texts.join('\n'),
          ...(msg && reasoning.get(msg) ? { reasoning_content: reasoning.get(msg)! } : {}),
          ...(cur.tools.length ? { tool_calls: cur.tools, observation: { results: cur.results } } : {}),
          ...(tok ? { metrics: { prompt_tokens: tok.input + tok.cache.read, cached_tokens: tok.cache.read, completion_tokens: tok.output + tok.reasoning, extra: { reasoning_tokens: tok.reasoning, cache_write_tokens: tok.cache.write } } } : {}),
          llm_call_count: 1,
          extra: { turn: t.turn, finish_reason: e.part?.reason, opencode_message_id: msg },
        };
        mine.push(s);
        cur = undefined;
      }
    }
    if (cur) mine.push({ step_id: next(), source: 'agent', message: cur.texts.join('\n'), ...(cur.tools.length ? { tool_calls: cur.tools, observation: { results: cur.results } } : {}), extra: { turn: t.turn, incomplete: true } });
    perTurn.push(mine);
    steps.push(...mine);
  }
  return { steps, perTurn };
}

// --- Open WebUI -------------------------------------------------------------------------
type OwOut = { type: string; call_id?: string; name?: string; arguments?: string; status?: string; output?: unknown; content?: unknown; summary?: unknown };

function flattenText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x as { text?: string })?.text ?? '')).join('');
  return v == null ? '' : JSON.stringify(v);
}

function openwebuiSteps(runDir: string, run: Run, calls: Call[], next: () => number): { steps: Step[]; perTurn: Step[][] } {
  const file = join(runDir, 'openwebui-record.json');
  const chat = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { chat?: { history?: { messages?: Record<string, { role: string; parentId: string | null; content?: string; output?: OwOut[]; timestamp?: number; usage?: Json; done?: boolean }> } } }) : {};
  const msgs = Object.values(chat.chat?.history?.messages ?? {});
  // Assistant messages in conversation order: follow parent links from the root.
  const byParent = new Map(msgs.map((m) => [m.parentId, m]));
  const assistants: (typeof msgs)[number][] = [];
  for (let m = byParent.get(null); m; m = byParent.get((m as { id?: string }).id ?? '')) if (m.role === 'assistant') assistants.push(m);
  const steps: Step[] = [];
  const perTurn: Step[][] = [];
  for (const [i, t] of run.turns.entries()) {
    const a = assistants[i];
    const match = matcher(calls, t.call_ids);
    const mine: Step[] = [];
    // One step per model call: a call's items are reasoning?, message?, function_call*, then their outputs;
    // a reasoning or message item after outputs starts the next call.
    let cur: { texts: string[]; reasoning: string[]; tools: ToolCall[]; results: ObsResult[]; sawOutput: boolean } | undefined;
    const flush = () => {
      if (!cur) return;
      mine.push({
        step_id: next(), source: 'agent', model_name: run.model, message: cur.texts.join('\n'),
        ...(cur.reasoning.length ? { reasoning_content: cur.reasoning.join('\n') } : {}),
        ...(cur.tools.length ? { tool_calls: cur.tools, observation: { results: cur.results } } : {}),
        llm_call_count: 1, extra: { turn: t.turn },
      });
      cur = undefined;
    };
    for (const o of a?.output ?? []) {
      const starts = o.type === 'reasoning' || o.type === 'message' || o.type === 'function_call';
      if (!cur || (starts && cur.sawOutput)) { flush(); cur = { texts: [], reasoning: [], tools: [], results: [], sawOutput: false }; }
      if (o.type === 'reasoning') cur.reasoning.push(flattenText(o.content ?? o.summary));
      else if (o.type === 'message') cur.texts.push(flattenText(o.content));
      else if (o.type === 'function_call') {
        let args: Json = {};
        try { args = JSON.parse(o.arguments ?? '{}') as Json; } catch { args = { _raw: o.arguments ?? '' }; }
        const dc = match(o.name ?? '');
        cur.tools.push({ tool_call_id: o.call_id ?? `call_${steps.length}_${cur.tools.length}`, function_name: o.name ?? '', arguments: args, extra: { status: o.status, ...(dc ? { drive: driveExtra(dc) } : {}) } });
      } else if (o.type === 'function_call_output') {
        cur.sawOutput = true;
        cur.results.push({ source_call_id: o.call_id, content: flattenText(o.output) });
      }
    }
    flush();
    // Tool outputs whose call is not in the same step would break correlation; keep them, unlinked.
    for (const s of mine) if (s.observation) for (const r of s.observation.results) if (!s.tool_calls?.some((c) => c.tool_call_id === r.source_call_id)) delete r.source_call_id;
    // Open WebUI reports usage per turn only: input_tokens / output_tokens summed over the turn's model calls.
    const last = mine.at(-1);
    if (last) {
      last.timestamp = t.ended;
      last.extra = { ...last.extra, turn_usage: a?.usage ?? null };
    }
    perTurn.push(mine);
    steps.push(...mine);
  }
  return { steps, perTurn };
}

// --- the trajectory ---------------------------------------------------------------------
export function toAtif(runDir: string): Json {
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as Run;
  const calls: Call[] = existsSync(join(runDir, 'calls.json')) ? JSON.parse(readFileSync(join(runDir, 'calls.json'), 'utf8')) : [];
  let id = 0;
  const next = () => ++id;
  // Build the client steps first with a scratch counter, then number everything in order.
  const built = run.client === 'opencode' ? opencodeSteps(runDir, run, calls, () => 0) : openwebuiSteps(runDir, run, calls, () => 0);
  const steps: Step[] = [];
  for (const [i, t] of run.turns.entries()) {
    steps.push({ step_id: next(), timestamp: t.started, source: 'user', message: t.prompt, extra: { turn: t.turn, kind: t.kind } });
    for (const s of built.perTurn[i] ?? []) steps.push({ ...s, step_id: next() });
    if (t.compactions > (run.turns[i - 1]?.compactions ?? 0)) {
      steps.push({ step_id: next(), source: 'system', message: 'Context compaction performed by the client', extra: { turn: t.turn, context_management: { type: 'compaction', boundary: 'replace' } } });
    }
  }
  const hashOf = new Map(run.sessions.map((s) => [s.dir_id, s.session_id_hash?.slice(0, 12) ?? null]));
  const ops = (p: Run['packages'][number]) => { try { return (JSON.parse(p.operations) as { op: string; path?: string; from_path?: string }[]).map((o) => ({ op: o.op, path: o.path ?? null, from_path: o.from_path ?? null })); } catch { return []; } };
  const agentSteps = steps.filter((s) => s.source === 'agent');
  const sum = (f: (s: Step) => number | undefined) => agentSteps.reduce((a, s) => a + (f(s) ?? 0), 0);
  const perStepTokens = agentSteps.some((s) => s.metrics);
  const traj: Json = {
    schema_version: ATIF_VERSION,
    session_id: run.client_conversation ?? run.id,
    trajectory_id: run.id,
    agent: {
      name: run.client === 'opencode' ? 'opencode' : 'open-webui',
      version: run.client_version ?? 'unknown',
      model_name: run.model,
      extra: { provider: 'fireworks', mcp_server: 'agent-drive', drive_surface: run.variant, ...(run.oc_context ? { context_limit: Number(run.oc_context) } : {}) },
    },
    notes: `Agent Drive session-continuity experiment (decision 0006). One trajectory per conversation; user steps are the scripted turns. ${run.client === 'openwebui' ? 'Open WebUI reports token usage per turn, not per model call: per-step metrics are absent, turn totals are in the last agent step of each turn (extra.turn_usage) and final_metrics.' : 'Token metrics per step from OpenCode step_finish events; reasoning from its opencode.db.'} Drive session ids are replaced by ds_<hash:…> (prefix of the server's session_id_hash).`,
    steps,
    final_metrics: {
      total_prompt_tokens: perStepTokens ? sum((s) => s.metrics?.prompt_tokens) : run.turns.reduce((a, t) => a + t.tokens.input, 0),
      total_completion_tokens: perStepTokens ? sum((s) => s.metrics?.completion_tokens) : run.turns.reduce((a, t) => a + t.tokens.output, 0),
      ...(perStepTokens ? { total_cached_tokens: sum((s) => s.metrics?.cached_tokens) } : {}),
      total_steps: steps.length,
      extra: { model_calls: agentSteps.length, wall_ms: run.ms },
    },
    extra: {
      harness: 'agent-drive test/harness/sessions', harbor_rfc_commit: HARBOR_COMMIT,
      run: { id: run.id, client: run.client, variant: run.variant, conversation: run.conversation, rep: run.rep, slot: run.slot, settle_ms: run.settle_ms, fatal: run.fatal ?? null },
      turns: run.turns.map((t) => ({
        turn: t.turn, kind: t.kind, started: t.started ?? null, ended: t.ended ?? null, ms: t.ms,
        done_ok: t.done_ok, merged_ok: t.merged_ok, done: t.done, merged: t.merged,
        drive_sessions: t.dirs.map((d) => ({ dir_id: d, session_id_hash: hashOf.get(d) ?? null })),
        drive_errors: t.errors, client_errors: t.client_errors,
        tokens: t.tokens, compactions: t.compactions,
      })),
      drive: {
        sessions: run.sessions.map((s) => ({ dir_id: s.dir_id, session_id_hash: s.session_id_hash?.slice(0, 12) ?? null, purpose: s.purpose, status: s.status, created_at: s.created_at, last_call_at: s.last_call_at })),
        merges_landed: run.packages.filter((p) => p.kind !== 'upload').map((p) => ({ pkg_id: p.pkg_id, kind: p.kind, summary: p.summary_claimed, created_at: p.created_at, operations: ops(p) })),
        conflicts: calls.filter((c) => c.error_reason === 'merge_conflict').map((c) => ({ call_id: c.id, tool: c.tool, dir_id: c.dir_id })),
        calls: calls.length,
      },
    },
  };
  const out = redactDeep(traj);
  const text = JSON.stringify(out);
  // Secrets the server issues are a prefix and 26 base32 characters (server/src/util/ids.ts newSecret).
  const bad = [/Bearer\s+[A-Za-z0-9._~+/-]{10,}/i, /\b(ds|ada|adr|adk|aw|ac|ar)_[a-z2-7]{26}\b/].find((re) => re.test(text));
  if (bad) throw new Error(`refusing to write a trajectory that matches ${bad}`);
  return out;
}

/** Validate every trajectory in `dir` with Harbor's models and the atif package (validate_atif.py). */
export function validateAtif(dir: string, opts: { python?: string; harborSrc?: string } = {}): { ok: boolean; output: string } {
  const py = opts.python ?? process.env.A6_ATIF_PYTHON ?? '/tmp/a6-data/atif-venv/bin/python';
  const src = opts.harborSrc ?? process.env.A6_HARBOR_SRC ?? '/tmp/a6-data/harbor/src';
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f)) : [];
  if (!files.length) return { ok: true, output: 'no trajectories' };
  try {
    const output = execFileSync(py, ['-I', join(import.meta.dirname, 'validate_atif.py'), '--harbor-src', src, ...files], { encoding: 'utf8' });
    return { ok: true, output };
  } catch (e) {
    return { ok: false, output: String((e as { stdout?: string }).stdout ?? e) };
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'atif.ts') {
  const [runDir, outFile] = process.argv.slice(2);
  if (!runDir) { console.error('usage: atif.ts RUN_DIR [OUT.json]'); process.exit(2); }
  const t = JSON.stringify(toAtif(runDir), null, 2);
  if (outFile) writeFileSync(outFile, t); else console.log(t);
}
