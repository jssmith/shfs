// Tables across variants and clients from run-matrix.ts output directories.
//   node test/harness/sessions/report.ts /tmp/a6-runs/v0 [/tmp/a6-runs/v1 …] [--runs] [--turns] [--json]
// One row per (client, variant, conversation), aggregated over repeats; --runs
// adds one row per run, --turns one row per turn.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: 'boolean' }, turns: { type: 'boolean' }, json: { type: 'boolean' } } });

type Turn = {
  turn: number; kind: string; ms: number; done_ok: boolean; merged_ok: boolean; drive_calls: number; client_tools: string[]; drive_tools: string[];
  sessions_started: number; dirs: string[]; reused_earlier_session: boolean; merges: string[]; errors: string[]; client_errors: string[];
  tokens: { input: number; cached: number; output: number }; compactions: number; run_ms: number[]; leak: { card_number: boolean; expiry_or_name: boolean };
};
type Run = { id: string; client: string; variant: string; conversation: string; rep: number; ms: number; fatal?: string; turns: Turn[]; packages: { kind: string }[]; sessions: { dir_id: string; status: string }[] };

const runs: Run[] = [];
for (const dir of positionals) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name, 'run.json');
    if (e.isDirectory() && existsSync(f)) runs.push(JSON.parse(readFileSync(f, 'utf8')) as Run);
  }
}

function perRun(r: Run) {
  const t = r.turns;
  const dirs = new Set(t.flatMap((x) => x.dirs));
  const later = t.slice(1);
  return {
    run: r.id, client: r.client, variant: r.variant, conv: r.conversation,
    turns: `${t.length}`,
    sessions: dirs.size,
    later_turns_reusing: `${later.filter((x) => x.reused_earlier_session).length}/${later.length}`,
    turns_starting_session: t.filter((x) => x.sessions_started > 0).length,
    done: `${t.filter((x) => x.done_ok).length}/${t.length}`,
    merged: `${t.filter((x) => x.merged_ok).length}/${t.length}`,
    merges: r.packages.filter((p) => p.kind !== 'upload').length,
    open_at_end: r.sessions.filter((s) => s.status !== 'finished').length,
    drive_calls: t.reduce((a, x) => a + x.drive_calls, 0),
    errors: t.reduce((a, x) => a + x.errors.length + x.client_errors.length, 0),
    tok_in_k: Math.round(t.reduce((a, x) => a + x.tokens.input, 0) / 1000),
    tok_out_k: +(t.reduce((a, x) => a + x.tokens.output, 0) / 1000).toFixed(1),
    compactions: Math.max(0, ...t.map((x) => x.compactions)),
    leaks: t.filter((x) => x.leak.card_number || x.leak.expiry_or_name).length,
    min: +(r.ms / 60000).toFixed(1),
    fatal: r.fatal ? r.fatal.split('\n')[0]!.slice(0, 60) : '',
  };
}

function table(rows: Record<string, unknown>[]) {
  if (!rows.length) return '(none)';
  const cols = Object.keys(rows[0]!);
  const s = (v: unknown) => String(v ?? '');
  return [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${cols.map((c) => s(r[c])).join(' | ')} |`)].join('\n');
}

const pr = runs.map(perRun).sort((a, b) => `${a.variant}${a.conv}${a.client}${a.run}`.localeCompare(`${b.variant}${b.conv}${b.client}${b.run}`));
const groups = new Map<string, ReturnType<typeof perRun>[]>();
for (const r of pr) { const k = `${r.variant}|${r.conv}|${r.client}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
const frac = (xs: string[]) => { const [a, b] = xs.reduce(([a, b], x) => { const [p, q] = x.split('/').map(Number); return [a + p!, b + q!]; }, [0, 0]); return `${a}/${b}`; };
const agg = [...groups].map(([k, rs]) => {
  const [variant, conv, client] = k.split('|');
  return {
    variant, conv, client, runs: rs.length,
    'sessions per conversation': rs.map((r) => r.sessions).join(', '),
    'later turns reusing the session': frac(rs.map((r) => r.later_turns_reusing)),
    'turns done': frac(rs.map((r) => r.done)),
    'turns merged': frac(rs.map((r) => r.merged)),
    'merge packages': rs.map((r) => r.merges).join(', '),
    'left open': rs.map((r) => r.open_at_end).join(', '),
    'drive calls': rs.map((r) => r.drive_calls).join(', '),
    errors: rs.map((r) => r.errors).join(', '),
    'tokens in / out (k)': rs.map((r) => `${r.tok_in_k} / ${r.tok_out_k}`).join(', '),
    leaks: rs.reduce((a, r) => a + r.leaks, 0),
  };
});

if (values.json) { console.log(JSON.stringify({ agg, runs: pr }, null, 2)); process.exit(0); }
console.log(table(agg));
if (values.runs) { console.log(); console.log(table(pr)); }
if (values.turns) {
  console.log();
  console.log(table(runs.flatMap((r) => r.turns.map((t) => ({
    run: r.id, turn: t.turn, kind: t.kind, done: t.done_ok ? 'y' : 'n', merged: t.merged_ok ? 'y' : 'n',
    'new session': t.sessions_started, reused: t.reused_earlier_session ? 'y' : 'n', merges: t.merges.join(' '),
    calls: t.drive_calls, errors: [...t.errors, ...t.client_errors].join('; ').slice(0, 60),
    'tok in/out (k)': `${Math.round(t.tokens.input / 1000)}/${(t.tokens.output / 1000).toFixed(1)}`, s: Math.round(t.ms / 1000),
  })))));
}
const tin = runs.reduce((a, r) => a + r.turns.reduce((b, t) => b + t.tokens.input, 0), 0);
const tcache = runs.reduce((a, r) => a + r.turns.reduce((b, t) => b + t.tokens.cached, 0), 0);
const tout = runs.reduce((a, r) => a + r.turns.reduce((b, t) => b + t.tokens.output, 0), 0);
console.log(`\n${runs.length} runs; tokens in ${(tin / 1e6).toFixed(2)} M (cached at least ${(tcache / 1e6).toFixed(2)} M), out ${(tout / 1e3).toFixed(1)} k`);
