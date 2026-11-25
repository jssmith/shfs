// The `drive` command's host side (v2, v3): what `drive search`, `drive
// status`, `drive save` and `drive help` do for the session whose socket the
// request came in on (sessions/socket.ts). Arguments are untrusted input.
import { readdirSync } from 'node:fs';
import type { Sessions, DriveCommandHandler } from './manager.js';
import { approx, hiddenSummary, ringName } from './search.js';
import { diffWithIgnored } from '../merge/merge.js';
import { outcomeText, type AutoMerge } from '../merge/auto.js';
import { safeWrite } from '../util/fsafe.js';
import { PARTIAL_VIEW, SHELL_SKILL } from '../mcp/skill.js';

export const SEARCH_SHOWN = 20;

export const DRIVE_USAGE = `usage: drive <command>
  drive search <words> [--all]   search the files this session can see (--all writes the full list to /work)
  drive status                   what this session is for, unsaved changes, the last save, conflicts
  drive save "message"           save your changes under /drive to the drive now, with a message
  drive help                     how to work in the drive
`;

type Out = { stdout: string; stderr?: string; exit: number };

/** "Finance (1 item), Credentials (2 items)". */
export function hiddenCountsText(hidden: Record<string, number>): string {
  const parts = Object.entries(hidden).map(([r, n]) => `${ringName(r)} (${n} item${n === 1 ? '' : 's'})`);
  return parts.length ? parts.join(', ') : 'none';
}

function nextSearchFile(work: string): number {
  let n = 0;
  try {
    for (const f of readdirSync(work)) {
      const m = /^search-(\d+)\.txt$/.exec(f);
      if (m) n = Math.max(n, Number(m[1]));
    }
  } catch {
    // no /work yet
  }
  return n + 1;
}

export function driveCommands(sessions: Sessions, auto: AutoMerge): DriveCommandHandler {
  async function search(dir_id: string, args: string[]): Promise<Out> {
    const all = args.includes('--all');
    const query = args.filter((a) => a !== '--all').join(' ').trim().slice(0, 500);
    if (!query) return { stdout: '', stderr: 'usage: drive search <words> [--all]\n', exit: 2 };
    const r = sessions.search(dir_id, query);
    const n = r.results.length;
    const fmt = (x: { path: string; snippet: string; note?: string }) => `${x.path}${x.note ? ` (${x.note})` : ''}\n  ${x.snippet.replace(/\s+/g, ' ')}`;
    const lines: string[] = [];
    if (!n) lines.push('No matches you can see.');
    else if (n <= SEARCH_SHOWN) lines.push(`${n} match${n === 1 ? '' : 'es'} you can see:`, ...r.results.map(fmt));
    else lines.push(`${approx(n)} matches you can see; the first ${SEARCH_SHOWN}:`, ...r.results.slice(0, SEARCH_SHOWN).map(fmt));
    if (all && n) {
      const k = nextSearchFile(sessions.dirs(dir_id).work);
      const rel = `search-${k}.txt`;
      await safeWrite(sessions.dirs(dir_id).work, rel, `# drive search ${query}\n# ${n} matches you can see\n${r.results.map(fmt).join('\n')}\n`);
      lines.push(`Full list (${n} match${n === 1 ? '' : 'es'}) written to /work/${rel}.`);
    } else if (n > SEARCH_SHOWN) lines.push(`For the full list: drive search --all ${query}`);
    lines.push(`Hidden from this session: ${hiddenSummary(r.hidden)}.${r.hidden.length ? ' Hidden items match only by label, kind or month, never by their text; you cannot open them.' : ''}`);
    return { stdout: `${lines.join('\n')}\n`, exit: 0 };
  }

  async function status(dir_id: string): Promise<Out> {
    const row = sessions.byDir(dir_id)!;
    const { changes } = await sessions.underLock(dir_id, () => diffWithIgnored(sessions, dir_id));
    const last = auto.last(dir_id);
    const s = sessions.summary(dir_id);
    const lines = [
      `Purpose: ${row.purpose}`,
      `Started: ${row.created_at}`,
      `/drive: ${s.files} file${s.files === 1 ? '' : 's'} from the drive.`,
      changes.length
        ? `Unsaved changes: ${changes.map((c) => (c.from_path ? `${c.kind} ${c.from_path} → ${c.path}` : `${c.kind} ${c.path}`)).join(', ')}. They save automatically about ${Math.round(auto.windowMs / 1000)} s after your last change, or now with: drive save "message"`
        : 'Unsaved changes: none.',
      last
        ? last.result.ok
          ? `Last save: ${last.at}${last.result.pkg_id ? `, package ${last.result.pkg_id}` : ''} (${last.trigger === 'auto' ? 'automatic' : 'drive save'}): ${last.result.changes.length ? last.result.changes.map((c) => `${c.kind} ${c.path}`).join(', ') : 'nothing to save'}.`
          : `Last save: ${last.at} FAILED.`
        : 'Last save: none in this session yet.',
      last && !last.result.ok ? `Conflicts: ${outcomeText(last)}` : 'Conflicts: none.',
      `Partial view: ${PARTIAL_VIEW}`,
      `Hidden from sessions: ${hiddenCountsText(s.hidden)}.`,
    ];
    return { stdout: `${lines.join('\n')}\n`, exit: 0 };
  }

  async function save(dir_id: string, args: string[]): Promise<Out> {
    const message = args.join(' ').trim();
    if (!message) return { stdout: '', stderr: 'usage: drive save "what you changed and why"\n', exit: 2 };
    const o = await auto.saveNow(dir_id, message.slice(0, 5000));
    const t = outcomeText(o);
    return o.result.ok ? { stdout: `${t}\n`, exit: 0 } : { stdout: '', stderr: `${t}\n`, exit: 1 };
  }

  return async (dir_id, argv) => {
    const [cmd, ...args] = argv;
    sessions.drive.activity({ dir_id, actor: 'agent', op: 'drive_command', detail: { argv: argv.map((a) => a.slice(0, 200)).slice(0, 10) } });
    switch (cmd) {
      case 'search':
        return search(dir_id, args);
      case 'status':
        return status(dir_id);
      case 'save':
        return save(dir_id, args);
      case 'help':
      case '--help':
      case '-h':
        return { stdout: SHELL_SKILL, exit: 0 };
      case undefined:
        return { stdout: DRIVE_USAGE, exit: 0 };
      default:
        return { stdout: '', stderr: `drive: unknown command "${cmd.slice(0, 50)}"\n${DRIVE_USAGE}`, exit: 2 };
    }
  };
}
