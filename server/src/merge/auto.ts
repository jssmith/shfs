// Automatic merge for the shell surfaces (v2, v3). After a call that changed
// files under /drive (bash, write, edit), the session's changes merge as one
// package, all or nothing, through the same mergeSession as checkpoint: tool
// caches stay out, conflicts leave the session's version in /work/conflicts/.
//
// Coalescing: the merge runs COALESCE_MS after the last changing call ends,
// and never while one is running, so a burst of calls (an agent writing
// several files, or a quick edit-run-edit loop) becomes one package. The cost
// is that a merge's outcome arrives after the call that caused it: it is
// reported at the top of the session's next tool result, and `drive status`
// shows it. `drive save` merges at once and reports in its own output.
import { diffWithIgnored, mergeSession, type MergeResult } from './merge.js';
import type { Sessions } from '../sessions/manager.js';
import { summariseIgnored } from './ignore.js';

export const COALESCE_MS = 2000;

export interface MergeOutcome {
  at: string;
  trigger: 'auto' | 'save';
  summary: string;
  result: MergeResult;
}

interface SessionState {
  timer?: NodeJS.Timeout;
  gen: number;
  busy: number;
  notes: string[];
  unreported: MergeOutcome[];
  last?: MergeOutcome;
}

export class AutoMerge {
  private s = new Map<string, SessionState>();
  private stopped = false;

  constructor(
    private sessions: Sessions,
    public windowMs = COALESCE_MS,
  ) {}

  private st(dir_id: string): SessionState {
    let x = this.s.get(dir_id);
    if (!x) this.s.set(dir_id, (x = { gen: 0, busy: 0, notes: [], unreported: [] }));
    return x;
  }

  /** A call that may change /drive starts: no merge runs until it ends. */
  begin(dir_id: string): void {
    const x = this.st(dir_id);
    x.busy++;
    x.gen++;
    if (x.timer) clearTimeout(x.timer);
    x.timer = undefined;
  }

  /** It ended; `note` says what it changed (none: it changed nothing). */
  end(dir_id: string, note?: string): void {
    const x = this.st(dir_id);
    x.busy = Math.max(0, x.busy - 1);
    if (note) x.notes.push(note);
    if (x.notes.length && x.busy === 0) this.arm(dir_id);
  }

  /** True while changes wait for their merge. */
  pending(dir_id: string): boolean {
    return (this.s.get(dir_id)?.notes.length ?? 0) > 0;
  }

  last(dir_id: string): MergeOutcome | undefined {
    return this.s.get(dir_id)?.last;
  }

  /** Outcomes of automatic merges the agent has not been shown yet; shown once. */
  takeReports(dir_id: string): MergeOutcome[] {
    const x = this.s.get(dir_id);
    if (!x) return [];
    return x.unreported.splice(0);
  }

  private arm(dir_id: string): void {
    const x = this.st(dir_id);
    if (x.timer) clearTimeout(x.timer);
    if (this.stopped) return;
    const gen = x.gen;
    x.timer = setTimeout(() => {
      x.timer = undefined;
      void this.fire(dir_id, gen);
    }, this.windowMs);
    x.timer.unref?.();
  }

  private async fire(dir_id: string, gen: number): Promise<void> {
    const x = this.st(dir_id);
    try {
      // Waits for any command still holding the session; a newer change re-arms instead.
      const o = await this.sessions.lock.run(dir_id, async () => {
        if (this.stopped || x.gen !== gen || x.busy > 0) return null;
        return this.mergeLocked(dir_id, 'auto');
      });
      if (o) x.unreported.push(o);
    } catch (e) {
      console.error('automatic merge failed:', e);
    }
  }

  /**
   * Merge now with a message (`drive save`), from inside the session's running
   * command: under that command's hold (Sessions.underLock). Cancels a pending
   * automatic merge; its changes go into this one.
   */
  async saveNow(dir_id: string, message: string): Promise<MergeOutcome> {
    const x = this.st(dir_id);
    if (x.timer) clearTimeout(x.timer);
    x.timer = undefined;
    x.gen++;
    return this.sessions.underLock(dir_id, () => this.mergeLocked(dir_id, 'save', message));
  }

  /** Merge everything pending at once and stop (server shutdown). */
  async flushAll(): Promise<void> {
    this.stopped = true;
    for (const [dir_id, x] of this.s) {
      if (!x.notes.length) continue;
      if (x.timer) clearTimeout(x.timer);
      x.timer = undefined;
      await this.sessions.lock.run(dir_id, () => this.mergeLocked(dir_id, 'auto')).catch((e) => console.error('automatic merge at shutdown failed:', e));
    }
  }

  /** Caller holds the session. Null for an automatic merge with nothing to merge. */
  private async mergeLocked(dir_id: string, trigger: 'auto', message?: string): Promise<MergeOutcome | null>;
  private async mergeLocked(dir_id: string, trigger: 'save', message: string): Promise<MergeOutcome>;
  private async mergeLocked(dir_id: string, trigger: 'auto' | 'save', message?: string): Promise<MergeOutcome | null> {
    const x = this.st(dir_id);
    const notes = x.notes.splice(0);
    const row = this.sessions.byDir(dir_id);
    if (!row || row.status === 'finished' || row.status === 'stopped') return null;
    if (trigger === 'auto') {
      const { changes } = await diffWithIgnored(this.sessions, dir_id);
      if (!changes.length) return null;
    }
    const summary = (message?.trim() || `Saved automatically after: ${notes.join('; ') || 'changes in the shell'}`).slice(0, 5000);
    const result = await mergeSession(this.sessions, dir_id, 'checkpoint', summary);
    const o: MergeOutcome = { at: new Date().toISOString(), trigger, summary, result };
    x.last = o;
    return o;
  }
}

function changeList(r: MergeResult): string {
  return r.changes.map((c) => (c.from_path ? `${c.kind} ${c.from_path} → ${c.path}` : `${c.kind} ${c.path}`)).join(', ');
}

/** What the agent is told about a merge, plainly. */
export function outcomeText(o: MergeOutcome): string {
  const r = o.result;
  if (!r.ok) {
    const list = r.conflicts.map((c) => `${c.path}: ${c.reason.replace(/last checkpointed/, 'last saved')}${c.yours ? ` (your version is saved at ${c.yours})` : ''}`).join('; ');
    return (
      `merge_conflict: nothing was saved to the drive${o.trigger === 'auto' ? ' by the automatic save' : ''}. ${list}. ` +
      `/drive now holds the drive's current version of each of these files, and your other changes are still in /drive. ` +
      `Redo your change on top of the file in /drive (your version in /work/conflicts/ shows what you had); it then saves automatically.`
    );
  }
  const lines: string[] = [];
  if (!r.changes.length) lines.push('Nothing to save: /drive is up to date with the drive.');
  else lines.push(`Saved to the drive: ${changeList(r)}${r.pkg_id ? ` (package ${r.pkg_id})` : ''}.`);
  if (r.ignored.length) lines.push(`Not saved (tool cache): ${summariseIgnored(r.ignored).join(', ')}. They stay in your /drive; nothing to do.`);
  if (r.withheld.length) lines.push(`Placed behind a ring by the drive's check and no longer visible to this session: ${r.withheld.map((w) => `${w.path} (${w.rings.join(', ')})`).join(', ')}.`);
  return lines.join('\n');
}
