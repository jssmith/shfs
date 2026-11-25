// Turns: the packages one session merges in quick succession belong to one
// turn of the conversation, so the person can undo a turn as a whole.
// A new turn starts when a session call comes TURN_GAP_MS or more after the
// session's previous call ended (or started, while it is still running).
// Turns are server-private (server-schema.sql: session_meta.current_turn,
// package_turns).
import { all, get, run, type DB } from '../store/db.js';
import type { Drive } from '../store/drive.js';
import { undoPackage, type UndoResult } from '../merge/undo.js';
import { newId } from '../util/ids.js';

export const TURN_GAP_MS = 20_000;

/** A session call starts: returns its turn, starting a new one after a gap. */
export function callStarts(db: DB, dir_id: string, nowMs = Date.now()): string {
  const m = get<{ current_turn: string | null; last_call_end: number | null }>(db, 'SELECT current_turn, last_call_end FROM session_meta WHERE dir_id = ?', dir_id);
  let turn = m?.current_turn ?? null;
  if (!turn || m?.last_call_end == null || nowMs - m.last_call_end >= TURN_GAP_MS) turn = newId('tn');
  run(db, 'UPDATE session_meta SET current_turn = ?, last_call_end = ? WHERE dir_id = ?', turn, nowMs, dir_id);
  return turn;
}

/** A session call ends: the gap to the next call counts from here. */
export function callEnds(db: DB, dir_id: string, nowMs = Date.now()): void {
  run(db, 'UPDATE session_meta SET last_call_end = MAX(COALESCE(last_call_end, 0), ?) WHERE dir_id = ?', nowMs, dir_id);
}

/** Record a merge package under the session's current turn (inside the merge's transaction). */
export function recordPackageTurn(db: DB, dir_id: string, pkg_id: string): string {
  let turn = get<{ current_turn: string | null }>(db, 'SELECT current_turn FROM session_meta WHERE dir_id = ?', dir_id)?.current_turn ?? null;
  if (!turn) {
    turn = newId('tn');
    run(db, 'UPDATE session_meta SET current_turn = ? WHERE dir_id = ?', turn, dir_id);
  }
  run(db, 'INSERT OR REPLACE INTO package_turns (pkg_id, dir_id, turn_id) VALUES (?, ?, ?)', pkg_id, dir_id, turn);
  return turn;
}

export function turnOf(db: DB, pkg_id: string): string | null {
  return get<{ turn_id: string }>(db, 'SELECT turn_id FROM package_turns WHERE pkg_id = ?', pkg_id)?.turn_id ?? null;
}

/** The turn's packages, newest first. */
export function turnPackages(db: DB, turn_id: string): string[] {
  return all<{ pkg_id: string }>(db, 'SELECT t.pkg_id FROM package_turns t JOIN packages p ON p.pkg_id = t.pkg_id WHERE t.turn_id = ? ORDER BY p.rowid DESC', turn_id).map((r) => r.pkg_id);
}

export function undoneBy(db: DB, pkg_id: string): string | null {
  return get<{ pkg_id: string }>(db, "SELECT pkg_id FROM packages WHERE kind = 'undo' AND summary_observed = ?", `undo of ${pkg_id}`)?.pkg_id ?? null;
}

export interface TurnUndoResult {
  ok: boolean;
  turn_id: string;
  /** One entry per package of the turn, newest first; packages already undone are skipped. */
  packages: ({ pkg_id: string; skipped: 'already undone' } | { pkg_id: string; undo_pkg_id: string | null; ok: boolean; reverted: UndoResult['reverted']; conflicts: UndoResult['conflicts'] })[];
  conflicts: UndoResult['conflicts'];
}

/**
 * Undo a whole turn: its packages newest first, each with undoPackage's
 * per-item rules (an item changed since is left as it is and reported).
 */
export function undoTurn(drive: Drive, turn_id: string): TurnUndoResult {
  const pkgs = turnPackages(drive.db, turn_id);
  if (!pkgs.length) throw new Error('no such turn');
  const out: TurnUndoResult = { ok: true, turn_id, packages: [], conflicts: [] };
  for (const pkg_id of pkgs) {
    if (undoneBy(drive.db, pkg_id)) {
      out.packages.push({ pkg_id, skipped: 'already undone' });
      continue;
    }
    const r = undoPackage(drive, pkg_id);
    out.packages.push({ pkg_id, undo_pkg_id: r.pkg_id, ok: r.ok, reverted: r.reverted, conflicts: r.conflicts });
    out.conflicts.push(...r.conflicts);
    if (!r.ok) out.ok = false;
  }
  return out;
}
