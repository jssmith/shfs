// Automatic merge for the shell surfaces (v2, v3), option A of decision
// 0006: when a call (bash; write or edit in v2) changed files under /drive,
// the session's changes merge before that call's result returns, as one
// package, all or nothing, through the same mergeSession as checkpoint: tool
// caches stay out, conflicts leave the session's version in /work/conflicts/.
// The outcome is in the same result, so the agent never answers the person
// before it knows whether its work was saved. `drive save "message"` merges
// on demand with a message of its own.
import { diffWithIgnored, mergeSession, type MergeResult } from './merge.js';
import type { Sessions } from '../sessions/manager.js';
import { summariseIgnored } from './ignore.js';

export interface MergeOutcome {
  at: string;
  trigger: 'auto' | 'save';
  summary: string;
  result: MergeResult;
}

export class AutoMerge {
  private lastBy = new Map<string, MergeOutcome>();

  constructor(private sessions: Sessions) {}

  last(dir_id: string): MergeOutcome | undefined {
    return this.lastBy.get(dir_id);
  }

  /**
   * A call that changed /drive ended: merge now. `note` (the call's
   * description, or its command) becomes the package's summary. Null if
   * there was nothing to merge after all (e.g. a file written back unchanged).
   */
  async afterChange(dir_id: string, note: string): Promise<MergeOutcome | null> {
    return this.sessions.lock.run(dir_id, async () => {
      const row = this.sessions.byDir(dir_id);
      if (!row || row.status === 'finished' || row.status === 'stopped') return null;
      const { changes } = await diffWithIgnored(this.sessions, dir_id);
      if (!changes.length) return null;
      return this.merge(dir_id, 'auto', note.trim() || 'changes in the shell');
    });
  }

  /** `drive save "message"`, from inside the session's running command: under that command's hold (Sessions.underLock). */
  async saveNow(dir_id: string, message: string): Promise<MergeOutcome> {
    return this.sessions.underLock(dir_id, () => this.merge(dir_id, 'save', message.trim()));
  }

  private async merge(dir_id: string, trigger: 'auto' | 'save', summary: string): Promise<MergeOutcome> {
    const result = await mergeSession(this.sessions, dir_id, 'checkpoint', summary.slice(0, 5000));
    const o: MergeOutcome = { at: new Date().toISOString(), trigger, summary, result };
    this.lastBy.set(dir_id, o);
    return o;
  }
}

function changeList(r: MergeResult): string {
  return r.changes.map((c) => (c.from_path ? `${c.kind} ${c.from_path} → ${c.path}` : `${c.kind} ${c.path}`)).join(', ');
}

export const CONFLICT_NEXT_STEP = 'Redo your change on top of the file in /drive (your version in /work/conflicts/ shows what you had); it is saved when the call that makes it ends.';

/** What the agent is told about a merge, plainly. */
export function outcomeText(o: MergeOutcome): string {
  const r = o.result;
  if (!r.ok) {
    const list = r.conflicts.map((c) => `${c.path}: ${c.reason.replace(/last checkpointed/, 'last saved')}${c.yours ? ` (your version is saved at ${c.yours})` : ''}`).join('; ');
    return (
      `merge_conflict: nothing was saved to the drive. ${list}. ` +
      `/drive now holds the drive's current version of each of these files, and your other changes are still in /drive. ${CONFLICT_NEXT_STEP}`
    );
  }
  const lines: string[] = [];
  if (!r.changes.length) lines.push('Nothing to save: /drive is up to date with the drive.');
  else lines.push(`Saved to the drive: ${changeList(r)}${r.pkg_id ? ` (package ${r.pkg_id})` : ''}.`);
  if (r.ignored.length) lines.push(`Not saved (tool cache): ${summariseIgnored(r.ignored).join(', ')}. They stay in your /drive; nothing to do.`);
  if (r.withheld.length) lines.push(`Placed behind a ring by the drive's check and no longer visible to this session: ${r.withheld.map((w) => `${w.path} (${w.rings.join(', ')})`).join(', ')}.`);
  return lines.join('\n');
}

/** For structured results: the save, as data. */
export function outcomeData(o: MergeOutcome): Record<string, unknown> {
  const r = o.result;
  return r.ok
    ? { ok: true, pkg_id: r.pkg_id ?? null, changes: r.changes, not_saved_tool_cache: r.ignored, withheld: r.withheld }
    : { ok: false, reason: 'merge_conflict', next_step: CONFLICT_NEXT_STEP, conflicts: r.conflicts };
}
