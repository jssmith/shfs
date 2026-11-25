// Checkpoint and finish: diff the working space against the session's base,
// build a change package, ring-check new versions, and merge all or nothing.
import path from 'node:path';
import { checkContent } from '../ingest/check.js';
import { mimeFor } from '../ingest/check.js';
import { tx } from '../store/db.js';
import { PreconditionError, type NewVersion, type Op } from '../store/drive.js';
import type { Sessions } from '../sessions/manager.js';
import { safeRead, walkFiles } from '../util/fsafe.js';
import { newId } from '../util/ids.js';

export interface Change {
  kind: 'create' | 'update' | 'move' | 'archive';
  path: string;
  from_path?: string;
  item_id?: string;
  base_version?: number;
  hash?: string;
  size?: number;
}

/** What the session changed relative to its base. Symlinks and special files are ignored. */
export async function diffSession(s: Sessions, dir_id: string): Promise<Change[]> {
  const d = s.dirs(dir_id);
  const base = s.base(dir_id);
  const visible = s.viewPaths(dir_id);
  const files = new Map((await walkFiles(d.upper)).map((f) => [f.path, f]));
  const changes: Change[] = [];
  const deleted: { path: string; item_id: string; version: number; hash: string }[] = [];
  for (const [p, b] of base) {
    const f = files.get(p);
    if (f) {
      if (f.hash !== b.blob_hash) changes.push({ kind: 'update', path: p, item_id: b.item_id, base_version: b.version, hash: f.hash, size: f.size });
    } else if (visible.has(p)) {
      deleted.push({ path: p, item_id: b.item_id, version: b.version, hash: b.blob_hash });
    }
    // Missing and no longer visible: hidden live (trash, ring), not the session's doing.
  }
  const created = [...files.values()].filter((f) => !base.has(f.path));
  // A deleted path whose exact content reappears elsewhere is a move.
  for (const del of deleted) {
    const i = created.findIndex((c) => c.hash === del.hash);
    if (i >= 0) {
      const c = created.splice(i, 1)[0]!;
      changes.push({ kind: 'move', path: c.path, from_path: del.path, item_id: del.item_id, base_version: del.version });
    } else {
      changes.push({ kind: 'archive', path: del.path, item_id: del.item_id, base_version: del.version });
    }
  }
  for (const c of created) changes.push({ kind: 'create', path: c.path, hash: c.hash, size: c.size });
  return changes;
}

export interface MergeResult {
  ok: boolean;
  pkg_id?: string;
  state_id?: string;
  changes: { kind: string; path: string; from_path?: string }[];
  conflicts: { path: string; reason: string }[];
  /** Paths the session wrote whose new content the ring check placed behind a ring or held. */
  withheld: { path: string; rings: string[] }[];
}

/**
 * Merge the session's work. All or nothing: if any item changed in the shared
 * drive since the session's base, or a created path is taken, nothing applies.
 * On success the session is rebased onto the new state. Caller holds the lock.
 */
export async function mergeSession(s: Sessions, dir_id: string, kind: 'checkpoint' | 'finish', summary: string): Promise<MergeResult> {
  const drive = s.drive;
  const row = s.byDir(dir_id)!;
  const changes = await diffSession(s, dir_id);
  const report = changes.map((c) => ({ kind: c.kind, path: c.path, ...(c.from_path ? { from_path: c.from_path } : {}) }));
  if (!changes.length) {
    await s.materialise(dir_id);
    return { ok: true, changes: [], conflicts: [], withheld: [] };
  }

  // Conflicts: an item changed since the base, or a create onto a taken path.
  const conflicts: { path: string; reason: string }[] = [];
  const freed = new Set<string>();
  for (const c of changes) {
    if (!c.item_id) continue;
    const t = drive.triple(c.item_id);
    const basePath = c.kind === 'move' ? c.from_path! : c.path;
    if (!t || t.state !== 'live' || t.version !== c.base_version || t.path !== basePath) {
      conflicts.push({ path: basePath, reason: 'changed in the drive since this session last checkpointed' });
    } else if (c.kind === 'move' || c.kind === 'archive') freed.add(basePath);
  }
  for (const c of changes) {
    if (c.kind !== 'create' && c.kind !== 'move') continue;
    const at = drive.liveItemAt(c.path);
    if (at && !freed.has(c.path)) conflicts.push({ path: c.path, reason: 'path_taken: another item is at this path in the drive' });
  }
  if (conflicts.length) return { ok: false, changes: report, conflicts, withheld: [] };

  // New versions: store blobs and run the ring check before the transaction.
  const d = s.dirs(dir_id);
  const ops: Op[] = [];
  const versions: NewVersion[] = [];
  const labels: [string, string, 'session'][] = [];
  const withheld: { path: string; rings: string[] }[] = [];
  for (const c of changes) {
    if (c.kind === 'create' || c.kind === 'update') {
      const got = await safeRead(d.upper, c.path);
      if (!got) return { ok: false, changes: report, conflicts: [{ path: c.path, reason: 'file changed during checkpoint; try again' }], withheld: [] };
      const blob_hash = await drive.blobs.put(got.data);
      const mime = mimeFor(path.basename(c.path));
      const chk = await checkContent(drive, { blob_hash, mime, name: path.basename(c.path), source: 'session', batchLabels: [] });
      if (chk.rings.length) withheld.push({ path: c.path, rings: chk.rings });
      const item_id = c.item_id ?? newId('it');
      const version = c.item_id ? drive.maxVersion(c.item_id) + 1 : 1;
      versions.push({ item_id, version, blob_hash, mime, size: got.data.length, ring_check: 'done', rings: chk.rings, extracted: chk.extracted });
      if (c.kind === 'create') {
        ops.push({ op: 'create', item_id, to_version: 1, path: c.path });
        labels.push([item_id, 'source:session', 'session']);
      } else ops.push({ op: 'update', item_id, from_version: c.base_version!, to_version: version });
    } else if (c.kind === 'move') {
      ops.push({ op: 'move', item_id: c.item_id!, from_path: c.from_path!, path: c.path });
    } else {
      ops.push({ op: 'archive', item_id: c.item_id!, path: c.path, from_state: 'live', to_state: 'archived' });
    }
  }
  const counts = changes.reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {});
  const observed = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ');
  let applied: { pkg_id: string; state_id: string };
  try {
    applied = tx(drive.db, () => {
      const r = drive.applyPackage({ kind, ops, versions, labels, session_id_hash: row.session_id_hash, summary_claimed: summary, summary_observed: observed });
      drive.activity({ dir_id, actor: 'agent', op: kind, detail: { pkg_id: r.pkg_id, observed } });
      return r;
    });
  } catch (e) {
    if (e instanceof PreconditionError) return { ok: false, changes: report, conflicts: e.conflicts.map((c) => ({ path: c.path, reason: c.reason })), withheld: [] };
    throw e;
  }
  await s.materialise(dir_id);
  return { ok: true, pkg_id: applied.pkg_id, state_id: applied.state_id, changes: report, conflicts: [], withheld };
}
