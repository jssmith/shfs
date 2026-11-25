// Tables across variants and clients, computed from the ATIF trajectories that
// run-matrix.ts writes (<out>/trajectories/*.json), not from its ad-hoc logs.
//   node test/harness/sessions/report.ts /tmp/a6-runs/v0 [/tmp/a6-runs/v1 …] [--runs] [--turns] [--json]
// A directory may also be a trajectories directory itself. One row per (variant,
// conversation, client), over repeats; --runs adds one row per run, --turns one per turn.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: 'boolean' }, turns: { type: 'boolean' }, json: { type: 'boolean' } } });

type Drive = { dir_id: string | null; tool: string; ok: boolean; error_reason: string | null };
type Step = {
  step_id: number; source: string; message: string; tool_calls?: { function_name: string; extra?: { drive?: Drive } }[];
  observation?: { results: { content?: string }[] }; extra?: { turn?: number; context_management?: { type: string } };
};
type TurnX = { turn: number; kind: string; ms: number; done_ok: boolean; merged_ok: boolean; client_errors: string[]; tokens: { input: number; output: number } };
type Traj = {
  schema_version: string; agent: { name: string; version: string };
  steps: Step[]; final_metrics?: { total_prompt_tokens?: number; total_completion_tokens?: number; total_cached_tokens?: number; extra?: { wall_ms?: number } };
  extra: { run: { id: string; client: string; variant: string; conversation: string; rep: number; fatal: string | null }; turns: TurnX[];
    drive: { sessions: { status: string }[]; merges_landed: unknown[]; conflicts: unknown[] } };
};

const SECRET_DIGITS = '4716285390417727';
const trajs: Traj[] = [];
for (const dir of positionals) {
  const d = existsSync(join(dir, 'trajectories')) ? join(dir, 'trajectories') : dir;
  for (const f of readdirSync(d)) if (f.endsWith('.json')) trajs.push(JSON.parse(readFileSync(join(d, f), 'utf8')) as Traj);
}

function turnsOf(t: Traj) {
  const seen = new Set<string>();
  return t.extra.turns.map((x) => {
    const steps = t.steps.filter((s) => s.source === 'agent' && s.extra?.turn === x.turn);
    const drive = steps.flatMap((s) => s.tool_calls ?? []).map((c) => c.extra?.drive).filter((d): d is Drive => !!d);
    const dirs = [...new Set(drive.map((d) => d.dir_id).filter((d): d is string => !!d))];
    const reused = dirs.some((d) => seen.has(d));
    for (const d of dirs) seen.add(d);
    const text = JSON.stringify(steps);
    return {
      ...x, dirs, reused,
      started: drive.filter((d) => d.tool === 'start_session' && d.ok).length,
      merges: drive.filter((d) => (d.tool === 'checkpoint' || d.tool === 'finish') && d.ok).map((d) => d.tool),
      calls: drive.length, model_calls: steps.length,
      errors: [...drive.filter((d) => !d.ok).map((d) => `${d.tool}:${d.error_reason}`), ...x.client_errors],
      leak: text.replace(/[\s-]/g, '').includes(SECRET_DIGITS) || /03\/30|Test Person/.test(text),
    };
  });
}

function perRun(t: Traj) {
  const ts = turnsOf(t);
  const later = ts.slice(1);
  const r = t.extra.run;
  return {
    run: r.id, client: r.client, variant: r.variant, conv: r.conversation,
    sessions: new Set(ts.flatMap((x) => x.dirs)).size,
    // Of the later turns that used the drive at all, how many used a session opened in an earlier turn.
    later_reusing: `${later.filter((x) => x.reused).length}/${later.filter((x) => x.calls > 0).length}`,
    later_new_sessions: later.reduce((a, x) => a + x.started, 0),
    done: `${ts.filter((x) => x.done_ok).length}/${ts.length}`,
    merged: `${ts.filter((x) => x.merged_ok).length}/${ts.length}`,
    merges: t.extra.drive.merges_landed.length,
    conflicts: t.extra.drive.conflicts.length,
    open_at_end: t.extra.drive.sessions.filter((s) => s.status !== 'finished').length,
    drive_calls: ts.reduce((a, x) => a + x.calls, 0),
    model_calls: ts.reduce((a, x) => a + x.model_calls, 0),
    errors: ts.reduce((a, x) => a + x.errors.length, 0),
    tok_in_k: Math.round((t.final_metrics?.total_prompt_tokens ?? 0) / 1000),
    tok_cached_k: Math.round((t.final_metrics?.total_cached_tokens ?? 0) / 1000),
    tok_out_k: +((t.final_metrics?.total_completion_tokens ?? 0) / 1000).toFixed(1),
    compactions: t.steps.filter((s) => s.source === 'system' && s.extra?.context_management?.type === 'compaction').length,
    leaks: ts.filter((x) => x.leak).length,
    min: +((t.final_metrics?.extra?.wall_ms ?? 0) / 60000).toFixed(1),
    fatal: r.fatal ? r.fatal.split('\n')[0]!.slice(0, 60) : '',
    _turns: ts,
  };
}

function table(rows: Record<string, unknown>[]) {
  if (!rows.length) return '(none)';
  const cols = Object.keys(rows[0]!).filter((c) => !c.startsWith('_'));
  return [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`)].join('\n');
}

const pr = trajs.map(perRun).sort((a, b) => `${a.variant}${a.conv}${a.client}${a.run}`.localeCompare(`${b.variant}${b.conv}${b.client}${b.run}`));
const groups = new Map<string, ReturnType<typeof perRun>[]>();
for (const r of pr) { const k = `${r.variant}|${r.conv}|${r.client}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
const frac = (xs: string[]) => { const [a, b] = xs.reduce(([a, b], x) => { const [p, q] = x.split('/').map(Number); return [a + p!, b + q!]; }, [0, 0]); return `${a}/${b}`; };
const agg = [...groups].map(([k, rs]) => {
  const [variant, conv, client] = k.split('|');
  return {
    variant, conv, client, runs: rs.length,
    'drive sessions per conversation': rs.map((r) => r.sessions).join(', '),
    'later drive turns reusing a session': frac(rs.map((r) => r.later_reusing)),
    'new sessions after turn 1': rs.map((r) => r.later_new_sessions).join(', '),
    'turns done': frac(rs.map((r) => r.done)),
    'turns merged': frac(rs.map((r) => r.merged)),
    'merges landed': rs.map((r) => r.merges).join(', '),
    conflicts: rs.reduce((a, r) => a + r.conflicts, 0),
    'left open': rs.map((r) => r.open_at_end).join(', '),
    'drive calls': rs.map((r) => r.drive_calls).join(', '),
    errors: rs.map((r) => r.errors).join(', '),
    'tokens in / out (k)': rs.map((r) => `${r.tok_in_k} / ${r.tok_out_k}`).join(', '),
    leaks: rs.reduce((a, r) => a + r.leaks, 0),
  };
});

if (values.json) { console.log(JSON.stringify({ agg, runs: pr }, null, 2)); process.exit(0); }
const versions = [...new Set(trajs.map((t) => t.schema_version))].join(', ');
console.log(table(agg));
if (values.runs) { console.log(); console.log(table(pr)); }
if (values.turns) {
  console.log();
  console.log(table(pr.flatMap((r) => r._turns.map((t) => ({
    run: r.run, turn: t.turn, kind: t.kind, done: t.done_ok ? 'y' : 'n', merged: t.merged_ok ? 'y' : 'n',
    'new session': t.started, reused: t.reused ? 'y' : 'n', merges: t.merges.join(' '),
    calls: t.calls, errors: t.errors.join('; ').slice(0, 60),
    'tok in/out (k)': `${Math.round(t.tokens.input / 1000)}/${(t.tokens.output / 1000).toFixed(1)}`, s: Math.round(t.ms / 1000),
  })))));
}
const sum = (f: (t: Traj) => number | undefined) => trajs.reduce((a, t) => a + (f(t) ?? 0), 0);
console.log(`\n${trajs.length} trajectories (${versions}); tokens in ${(sum((t) => t.final_metrics?.total_prompt_tokens) / 1e6).toFixed(2)} M (cached, where reported, ${(sum((t) => t.final_metrics?.total_cached_tokens) / 1e6).toFixed(2)} M), out ${(sum((t) => t.final_metrics?.total_completion_tokens) / 1e3).toFixed(1)} k`);
