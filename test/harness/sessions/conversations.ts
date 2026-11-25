// The conversations, written the way a person talks: no sessions, ids,
// checkpoints, finishing, merging, /drive or tools. Each turn has a check that
// runs against a view of the files after the turn (the shared drive, for
// "merged"; the agent's own working copy, for "done") and the reply.
// Numbers come from test/harness/corpus/make-sessions-corpus.sh.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

/** path → text, for the household tree only (paths start with "household/"). */
export type Tree = Map<string, string>;

export interface CheckContext {
  baseline: Tree; // right after upload
  prev: Tree; // the same view after the previous turn
  now: Tree;
  reply: string;
  /** Shared between the turns of one run (e.g. the summary file's name). */
  state: Record<string, string>;
}

export interface Turn {
  prompt: string;
  /** What the turn is for, for the report. */
  kind: 'read' | 'edit' | 'code' | 'recall' | 'close';
  check(c: CheckContext): Record<string, boolean>;
}

export interface Conversation { id: string; turns: Turn[] }

const added = (c: CheckContext) => [...c.now.keys()].filter((p) => !c.baseline.has(p));
const unchanged = (a: Tree, b: Tree) => a.size === b.size && [...a].every(([p, t]) => b.get(p) === t);

/** Run the unitconv tests on a copy of the tree, without network. */
export function pytest(tree: Tree): { passed: number; failed: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'a6-pytest-'));
  try {
    for (const [p, t] of tree) {
      if (!p.startsWith('household/projects/unitconv/')) continue;
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
    let out = '';
    try {
      out = execFileSync('timeout', ['60', 'unshare', '-n', 'python3', '-m', 'pytest', '-q', '-p', 'no:cacheprovider'], {
        cwd: join(dir, 'household/projects/unitconv'), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { out = String((e as { stdout?: string }).stdout ?? e); }
    const passed = Number(/(\d+) passed/.exec(out)?.[1] ?? 0);
    const failed = Number(/(\d+) failed/.exec(out)?.[1] ?? 0) + Number(/(\d+) error/.exec(out)?.[1] ?? 0);
    return { passed, failed, out: out.slice(-400) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Call a function of unitconv.py from the tree. */
function pyEval(tree: Tree, expr: string): string {
  const src = tree.get('household/projects/unitconv/unitconv.py');
  if (!src) return '';
  const dir = mkdtempSync(join(tmpdir(), 'a6-py-'));
  try {
    writeFileSync(join(dir, 'unitconv.py'), src);
    return execFileSync('timeout', ['20', 'unshare', '-n', 'python3', '-c', `import unitconv as u; print(${expr})`], { cwd: dir, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { return 'error'; } finally { rmSync(dir, { recursive: true, force: true }); }
}

const GARDEN = 'household/notes/garden-plan.md';
const UC = 'household/projects/unitconv/unitconv.py';
const UC_README = 'household/projects/unitconv/README.md';
const kgFunction = (t: Tree) => /def\s+(\w*(kg|kilo)\w*(pound|lb)\w*)\s*\(/i.exec(t.get(UC) ?? '')?.[1];

// --- C3 ----------------------------------------------------------------------
const summaryWith = (c: CheckContext, ...res: RegExp[]) =>
  added(c).filter((p) => res.every((re) => re.test(c.now.get(p) ?? '')));

export const C3: Conversation = {
  id: 'C3',
  turns: [
    {
      kind: 'edit',
      prompt: 'Can you total up my expenses by category from the CSV files in my finance folder, and save a short summary there?',
      check(c) {
        const hits = summaryWith(c, /147\.10?\b/, /554\.50?\b/).filter((p) => p.startsWith('household/finance/'));
        if (hits[0]) c.state.summary = hits[0];
        return { 'summary in finance/ with category totals (groceries 147.10, total 554.50)': hits.length > 0 };
      },
    },
    {
      kind: 'edit',
      prompt: 'Thanks. Could you also break it down by month in that summary?',
      check(c) {
        const hits = summaryWith(c, /229\.45\b/, /325\.05\b/);
        const same = hits.includes(c.state.summary ?? '');
        const path = same ? c.state.summary! : hits[0];
        if (path) c.state.summary = path;
        return { 'a summary has the monthly totals (Sep 229.45, Oct 325.05)': hits.length > 0 };
      },
    },
    {
      kind: 'edit',
      prompt: 'Please rename the summary file to something clearer.',
      check(c) {
        const old = c.state.summary;
        const hits = summaryWith(c, /229\.45\b/, /325\.05\b/);
        const renamed = hits.filter((p) => p !== old);
        if (renamed[0]) c.state.renamed = renamed[0];
        return {
          'the summary is at a new name': renamed.length > 0,
          'the old name is gone': !!old && !c.now.has(old),
          'one summary file, not a copy': hits.length === 1,
        };
      },
    },
  ],
};

// --- C10 ---------------------------------------------------------------------
export const C10: Conversation = {
  id: 'C10',
  turns: [
    {
      kind: 'read',
      prompt: "Can you give me a quick overview of what's in my household folder?",
      check: (c) => ({ 'reply mentions unitconv and the receipts': /unitconv/i.test(c.reply) && /receipt/i.test(c.reply), 'nothing changed': unchanged(c.now, c.baseline) }),
    },
    {
      kind: 'read',
      prompt: 'How much did I spend at Oak Street Grocer in October?',
      check: (c) => ({ 'reply has 82.40': /82[.,]40?\b/.test(c.reply), 'nothing changed': unchanged(c.now, c.prev) }),
    },
    {
      kind: 'edit',
      prompt: 'Add a line to my garden plan: order more compost by 1 December.',
      check: (c) => ({ 'garden plan has the compost line': /order[^\n]*compost[^\n]*(1\s*dec|dec\w*\s*1\b)/i.test(c.now.get(GARDEN) ?? '') }),
    },
    {
      kind: 'code',
      prompt: 'My unitconv project needs a kilograms to pounds conversion. Please add it with a test, and make sure all the tests pass.',
      check(c) {
        const fn = kgFunction(c.now);
        if (fn) c.state.kgFn = fn;
        const t = pytest(c.now);
        const tests = [...c.now].filter(([p]) => p.startsWith('household/projects/unitconv/tests/')).map(([, s]) => s).join('\n');
        return {
          'a kg to pounds function': !!fn && /^2\.20(46|5)/.test(pyEval(c.now, `round(u.${fn}(1), 4)`)),
          'a test calls it': !!fn && tests.includes(fn),
          'tests pass (3 or more)': t.failed === 0 && t.passed >= 3,
        };
      },
    },
    {
      kind: 'read',
      prompt: 'On which day did I buy the wood screws?',
      check: (c) => ({ 'reply has 11 October': /(10-11|oct\w*\.?\s+11\b|\b11(th)?\s+oct)/i.test(c.reply), 'nothing changed': unchanged(c.now, c.prev) }),
    },
    {
      kind: 'edit',
      prompt: 'Put the things I bought at Bluebird Hardware on a to-do list at the end of my garden plan note.',
      check(c) {
        const g = c.now.get(GARDEN) ?? '';
        return {
          'to-do has the three items': /wood screws/i.test(g) && /sanding/i.test(g) && /wall plugs/i.test(g),
          'earlier lines kept (tulips, compost line)': /tulip/i.test(g) && /order[^\n]*compost/i.test(g),
        };
      },
    },
    {
      kind: 'code',
      prompt: 'In unitconv, make km_to_miles round its result to 3 decimal places, and keep the tests passing.',
      check(c) {
        const t = pytest(c.now);
        return { 'km_to_miles rounds to 3 places': pyEval(c.now, 'u.km_to_miles(1), u.km_to_miles(10)') === '(0.621, 6.214)', 'tests pass': t.failed === 0 && t.passed >= 3 };
      },
    },
    {
      kind: 'recall',
      prompt: 'Remind me, how much was the Oak Street Grocer total again, and what did you call the new conversion function?',
      check: (c) => ({ 'reply has 82.40': /82[.,]40?\b/.test(c.reply), 'reply names the function': !!c.state.kgFn && c.reply.includes(c.state.kgFn), 'nothing changed': unchanged(c.now, c.prev) }),
    },
    {
      kind: 'edit',
      prompt: "Add a short changelog section to the unitconv README describing today's changes.",
      check(c) {
        const r = c.now.get(UC_README) ?? '';
        return { 'README has a changelog with both changes': /change\s*log/i.test(r) && /(kg|kilogram|pound)/i.test(r) && /round/i.test(r) };
      },
    },
    {
      kind: 'close',
      prompt: "That's all for now, thanks!",
      check(c) {
        const g = c.now.get(GARDEN) ?? '';
        const t = pytest(c.now);
        return {
          'all edits are in the drive': /order[^\n]*compost/i.test(g) && /wood screws/i.test(g) && !!kgFunction(c.now) && /change\s*log/i.test(c.now.get(UC_README) ?? ''),
          'tests pass': t.failed === 0 && t.passed >= 3,
        };
      },
    },
  ],
};

export const CONVERSATIONS: Record<string, Conversation> = { C3, C10 };
