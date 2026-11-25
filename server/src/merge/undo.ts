// Undo of a whole package, and the person's trash. Undo builds the inverse
// package; an item changed since the package is a conflict and is left as it
// is (never overwritten), unless the person chose "revert" for that item.
import { tx, get } from '../store/db.js';
import { livePathCollisions, replayOps, PreconditionError, type Drive, type ItemState, type ItemTriple, type NewVersion, type Op } from '../store/drive.js';
import { enqueueCheck } from '../ingest/check.js';

export interface UndoResult {
  ok: boolean;
  pkg_id: string | null;
  reverted: { item_id: string; path: string }[];
  conflicts: { item_id: string; path: string; reason: string }[];
}

function same(a: ItemTriple | null | undefined, b: ItemTriple | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.path === b.path && a.state === b.state && a.version === b.version;
}

function stateOp(item_id: string, from: ItemTriple, to: ItemState): Op {
  const name = to === 'live' ? 'restore' : to === 'trashed' ? 'trash' : 'archive';
  return { op: name, item_id, path: from.path, from_state: from.state, to_state: to };
}

export function undoPackage(drive: Drive, pkg_id: string, opts: { force?: string[] } = {}): UndoResult {
  const pkg = drive.pkg(pkg_id);
  if (!pkg) throw new Error('no such package');
  const force = new Set(opts.force ?? []);
  const { before, after, ops: pkgOps } = drive.snapshotsAround(pkg_id);
  const itemIds = [...new Set(pkgOps.map((o) => o.item_id))];
  const conflicts: UndoResult['conflicts'] = [];
  let candidates: string[] = [];
  for (const id of itemIds) {
    const cur = drive.triple(id);
    if (!force.has(id) && !same(cur, after.get(id))) {
      conflicts.push({ item_id: id, path: cur?.path ?? after.get(id)?.path ?? '', reason: 'changed since this package; choose keep current or revert' });
    } else candidates.push(id);
  }

  for (;;) {
    const ops: Op[] = [];
    const versions: NewVersion[] = [];
    const reverted: UndoResult['reverted'] = [];
    for (const id of candidates) {
      const cur = drive.triple(id)!;
      const bef = before.get(id) ?? null;
      const target: ItemTriple = bef ?? { ...cur, state: 'archived' };
      const mine: Op[] = [];
      if (cur.state !== 'live' && target.state === 'live') mine.push(stateOp(id, cur, 'live'));
      const liveNow = cur.state === 'live' || target.state === 'live';
      if (liveNow && bef) {
        if (cur.path !== bef.path) mine.push({ op: 'move', item_id: id, from_path: cur.path, path: bef.path });
        if (cur.version !== bef.version) {
          const src = drive.version(id, bef.version)!;
          const v = drive.maxVersion(id) + 1;
          const text = get<{ method: string; confidence: number; text: string }>(drive.db, 'SELECT method, confidence, text FROM extracted_text WHERE item_id = ? AND version = ?', id, bef.version);
          versions.push({
            item_id: id, version: v, blob_hash: src.blob_hash, mime: src.mime, size: src.size,
            ring_check: src.ring_check as 'pending' | 'done', rings: JSON.parse(src.rings) as string[], extracted: text,
          });
          mine.push({ op: 'update', item_id: id, from_version: cur.version, to_version: v });
        }
      }
      if (target.state !== 'live' && cur.state !== target.state) {
        const at = cur.state === 'live' ? { ...cur, path: bef?.path ?? cur.path } : cur;
        mine.push(stateOp(id, at, target.state));
      }
      if (mine.length) {
        ops.push(...mine);
        reverted.push({ item_id: id, path: bef?.path ?? cur.path });
      }
    }
    // Restores and moves back may land on a path someone else now uses: those items conflict.
    const sim = drive.snapshot();
    replayOps(sim, ops);
    const dup = new Set(livePathCollisions(sim));
    if (dup.size) {
      const clash = candidates.filter((id) => dup.has(sim.get(id)!.path) && sim.get(id)!.state === 'live');
      if (clash.length) {
        for (const id of clash) conflicts.push({ item_id: id, path: sim.get(id)!.path, reason: 'path_taken: another item now uses this path' });
        candidates = candidates.filter((id) => !clash.includes(id));
        continue;
      }
    }
    if (!ops.length) return { ok: conflicts.length === 0, pkg_id: null, reverted: [], conflicts };
    try {
      const r = tx(drive.db, () => {
        const res = drive.applyPackage({ kind: 'undo', ops, versions, summary_observed: `undo of ${pkg_id}` });
        for (const v of versions) if (v.ring_check === 'pending') enqueueCheck(drive, v.item_id, v.version);
        drive.activity({ actor: 'person', op: 'undo', detail: { pkg_id, undo_pkg: res.pkg_id, reverted: reverted.length, conflicts: conflicts.length, forced: [...force] } });
        return res;
      });
      return { ok: conflicts.length === 0, pkg_id: r.pkg_id, reverted, conflicts };
    } catch (e) {
      if (!(e instanceof PreconditionError)) throw e;
      const bad = new Set(e.conflicts.map((c) => c.item_id));
      for (const c of e.conflicts) conflicts.push({ item_id: c.item_id, path: c.path, reason: c.reason });
      candidates = candidates.filter((id) => !bad.has(id));
    }
  }
}

/** The person moves an item to Trash: one package, recoverable by undo. */
export function trashItem(drive: Drive, item_id: string): { pkg_id: string } {
  const t = drive.triple(item_id);
  if (!t || t.state !== 'live') throw new Error('not a live item');
  return tx(drive.db, () => {
    const r = drive.applyPackage({ kind: 'person', ops: [{ op: 'trash', item_id, path: t.path, from_state: 'live', to_state: 'trashed' }], versions: [], summary_observed: `trash ${t.path}` });
    drive.activity({ actor: 'person', op: 'trash', item_id, detail: { pkg_id: r.pkg_id, path: t.path } });
    return r;
  });
}
