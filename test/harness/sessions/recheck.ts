// Re-run one turn's check against the drive as it was at the end of a run,
// for a check that was wrong when the run happened (C10 turn 7's comparison
// string, fixed in conversations.ts). Valid only for a check whose files no
// later turn changes. Patches run.json (keeping the original result under
// `recheck.original`) and rewrites the run's ATIF trajectory.
//   node test/harness/sessions/recheck.ts --turn 7 RUN_DIR...
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { store } from './drive.ts';
import { CONVERSATIONS, type Tree } from './conversations.ts';
import { toAtif } from './atif.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { turn: { type: 'string' } } });
const n = Number(values.turn);
for (const runDir of positionals) {
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  const t = run.turns[n - 1];
  if (!t) continue;
  const conv = CONVERSATIONS[run.conversation]!;
  const shared: Tree = new Map();
  for (const f of store(join(runDir, 'data')).files().values()) if (f.path.startsWith('household/') && !f.rings.length && f.text !== null) shared.set(f.path, f.text);
  // The agent's copy: the newest session's working tree.
  const sessions = (run.sessions as { dir_id: string }[]).map((s) => join(runDir, 'data', 'sessions', s.dir_id, 'upper')).filter((p) => existsSync(join(p, 'household')));
  const last = sessions.at(-1);
  const sess: Tree = new Map();
  if (last) {
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (statSync(p).size < 512 * 1024) sess.set(relative(last, p), readFileSync(p, 'utf8')); } };
    walk(join(last, 'household'));
  }
  const ctx = (now: Tree) => ({ baseline: now, prev: now, now, reply: t.reply ?? '', state: {} });
  const merged = conv.turns[n - 1]!.check(ctx(shared));
  const done = last ? conv.turns[n - 1]!.check(ctx(sess)) : merged;
  t.recheck = { on: 'the drive at the end of the run', reason: 'check bug at run time (comparison string)', original: { done: t.done, merged: t.merged } };
  t.done = done; t.merged = merged;
  t.done_ok = Object.values(done).every(Boolean); t.merged_ok = Object.values(merged).every(Boolean);
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  const trajDir = join(dirname(runDir), 'trajectories');
  writeFileSync(join(trajDir, `${basename(runDir)}.json`), JSON.stringify(toAtif(runDir), null, 2));
  console.log(`${basename(runDir)} turn ${n}: done ${t.done_ok} merged ${t.merged_ok}`);
}
