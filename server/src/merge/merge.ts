// Checkpoint and finish: diff the working space against the session's base,
// build a change package, ring-check new versions, and merge all or nothing.
import path from 'node:path';
import { checkContent } from '../ingest/check.js';
import { mimeFor } from '../ingest/check.js';
import { run, tx } from '../store/db.js';
import { PreconditionError, type NewVersion, type Op } from '../store/drive.js';
import type { Sessions } from '../sessions/manager.js';
import { safeRead, safeRemove, safeWrite, walkFiles } from '../util/fsafe.js';
import { newId } from '../util/ids.js';
import { isToolCache } from './ignore.js';

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
  return (await diffWithIgnored(s, dir_id)).changes;
}

/** The diff, plus the tool-cache paths in the working copy that it leaves out (merge/ignore.ts). */
export async function diffWithIgnored(s: Sessions, dir_id: string): Promise<{ changes: Change[]; ignored: string[] }> {
  const d = s.dirs(dir_id);
  const base = new Map([...s.base(dir_id)].filter(([p]) => !isToolCache(p)));
  const visible = s.viewPaths(dir_id);
  const ignored: string[] = [];
  const files = new Map(
    (await walkFiles(d.upper))
      .filter((f) => {
        if (!isToolCache(f.path)) return true;
        ignored.push(f.path);
        return false;
      })
      .map((f) => [f.path, f]),
  );
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
  return { changes, ignored };
}

interface ConflictRef { item_id: string; agentPath: string | null; basePath: string | null }

/**
 * After a failed merge, make each conflicting item mergeable on the next try:
 * the session's version moves to /work/conflicts/<path>, and /drive gets the
 * drive's current version of that item (or loses it, if the session can no
 * longer see it), with the session's base updated to match. The shared drive
 * is not touched. The agent redoes its change on top and merges again.
 */
async function refreshConflicted(s: Sessions, dir_id: string, refs: ConflictRef[], conflicts: { path: string; reason: string; yours?: string }[]): Promise<void> {
  const d = s.dirs(dir_id);
  const db = s.drive.db;
  for (const [i, r] of refs.entries()) {
    if (r.agentPath) {
      const mine = await safeRead(d.upper, r.agentPath);
      if (mine) {
        await safeWrite(d.work, `conflicts/${r.agentPath}`, mine.data);
        await safeRemove(d.upper, r.agentPath);
        conflicts[i]!.yours = `/work/conflicts/${r.agentPath}`;
      }
    }
    const now = s.drive.reachable(r.item_id);
    tx(db, () => {
      run(db, 'DELETE FROM session_base WHERE dir_id = ? AND item_id = ?', dir_id, r.item_id);
      run(db, 'DELETE FROM session_view WHERE dir_id = ? AND item_id = ?', dir_id, r.item_id);
      if (now) {
        run(db, 'INSERT OR REPLACE INTO session_base (dir_id, path, item_id, version, blob_hash) VALUES (?, ?, ?, ?, ?)', dir_id, now.path, r.item_id, now.version, now.blob_hash);
        run(db, "INSERT OR REPLACE INTO session_view (dir_id, path, kind, item_id, version, target, writable) VALUES (?, ?, 'file', ?, ?, NULL, 1)", dir_id, now.path, r.item_id, now.version);
      }
      s.bumpEpoch(dir_id);
    });
    if (now) {
      // Never overwrite other work of the session's that sits at that path.
      const there = await safeRead(d.upper, now.path);
      if (there && now.path !== r.agentPath) {
        await safeWrite(d.work, `conflicts/${now.path}`, there.data);
        conflicts.push({ path: now.path, reason: 'the drive\'s version of a conflicting item now sits at this path', yours: `/work/conflicts/${now.path}` });
      }
      await safeWrite(d.upper, now.path, await s.drive.blobs.get(now.blob_hash));
    }
  }
}

/** `dir/name (2).ext`, the first such path no live item and no reserved path uses. */
function freeSibling(drive: Sessions['drive'], p: string, reserved: Set<string>): string {
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash + 1) : '';
  const name = p.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const cand = `${dir}${stem} (${n})${ext}`;
    if (!reserved.has(cand) && !drive.liveItemAt(cand)) return cand;
  }
}

export interface MergeResult {
  ok: boolean;
  pkg_id?: string;
  state_id?: string;
  changes: { kind: string; path: string; from_path?: string }[];
  /** `yours`: where the session's own version of a conflicting file was saved. */
  conflicts: { path: string; reason: string; yours?: string }[];
  /** Paths the session wrote whose new content the ring check placed behind a ring or held. */
  withheld: { path: string; rings: string[] }[];
  /** Tool caches in the working copy that were not merged (merge/ignore.ts). */
  ignored: string[];
}

/**
 * Merge the session's work. All or nothing: if any item changed in the shared
 * drive since the session's base, or a created path is taken, nothing applies.
 * On success the session is rebased onto the new state. Caller holds the lock.
 */
export async function mergeSession(s: Sessions, dir_id: string, kind: 'checkpoint' | 'finish', summary: string): Promise<MergeResult> {
  const drive = s.drive;
  const row = s.byDir(dir_id)!;
  const { changes, ignored } = await diffWithIgnored(s, dir_id);
  const report = changes.map((c) => ({ kind: c.kind, path: c.path, ...(c.from_path ? { from_path: c.from_path } : {}) }));
  if (!changes.length) {
    await s.materialise(dir_id);
    return { ok: true, changes: [], conflicts: [], withheld: [], ignored };
  }

  // Conflicts: an item changed since the base, or a create onto a taken path.
  const conflicts: { path: string; reason: string; yours?: string }[] = [];
  const refs: ConflictRef[] = [];
  const freed = new Set<string>();
  for (const c of changes) {
    if (!c.item_id) continue;
    const t = drive.triple(c.item_id);
    const basePath = c.kind === 'move' ? c.from_path! : c.path;
    if (!t || t.state !== 'live' || t.version !== c.base_version || t.path !== basePath) {
      conflicts.push({ path: basePath, reason: 'changed in the drive since this session last checkpointed' });
      refs.push({ item_id: c.item_id, agentPath: c.kind === 'archive' ? null : c.path, basePath });
    } else if (c.kind === 'move' || c.kind === 'archive') freed.add(basePath);
  }
  // A create or move onto a path held by an item the agent can see is a
  // conflict it can understand. Onto a path held by a hidden item (ringed,
  // held or unchecked), any refusal would tell the agent that something it
  // cannot see is there. So the agent's change goes ahead and the hidden item
  // is moved aside to a free sibling path, in the same package: the agent
  // learns nothing, and the person sees the move in the app (and can undo it).
  const aside: Op[] = [];
  const reserved = new Set(changes.filter((c) => c.kind === 'create' || c.kind === 'move').map((c) => c.path));
  for (const c of changes) {
    if (c.kind !== 'create' && c.kind !== 'move') continue;
    const at = drive.liveItemAt(c.path);
    if (!at || freed.has(c.path)) continue;
    if (drive.reachable(at.item_id)) {
      conflicts.push({ path: c.path, reason: 'path_taken: another item is at this path in the drive' });
      refs.push({ item_id: at.item_id, agentPath: c.path, basePath: null });
    }
    else {
      const to = freeSibling(drive, c.path, reserved);
      reserved.add(to);
      aside.push({ op: 'move', item_id: at.item_id, from_path: c.path, path: to });
    }
  }
  if (conflicts.length) {
    await refreshConflicted(s, dir_id, refs, conflicts);
    return { ok: false, changes: report, conflicts, withheld: [], ignored };
  }

  // New versions: store blobs and run the ring check before the transaction.
  const d = s.dirs(dir_id);
  const ops: Op[] = [];
  const versions: NewVersion[] = [];
  const labels: [string, string, 'session'][] = [];
  const withheld: { path: string; rings: string[] }[] = [];
  ops.push(...aside);
  for (const c of changes) {
    if (c.kind === 'create' || c.kind === 'update') {
      const got = await safeRead(d.upper, c.path);
      if (!got) return { ok: false, changes: report, conflicts: [{ path: c.path, reason: 'file changed during checkpoint; try again' }], withheld: [], ignored };
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
  const observed = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ') + (aside.length ? `; moved aside ${aside.length} hidden item(s) at paths the session wrote` : '');
  let applied: { pkg_id: string; state_id: string };
  try {
    applied = tx(drive.db, () => {
      const r = drive.applyPackage({ kind, ops, versions, labels, session_id_hash: row.session_id_hash, summary_claimed: summary, summary_observed: observed });
      drive.activity({ dir_id, actor: 'agent', op: kind, detail: { pkg_id: r.pkg_id, observed } });
      return r;
    });
  } catch (e) {
    // The drive changed between the checks above and the transaction (an
    // upload, another merge). The reason stays generic: the item in the way
    // may be one this session cannot see.
    if (e instanceof PreconditionError) {
      const paths = [...new Set(changes.map((c) => c.path))].filter((p) => e.conflicts.some((x) => x.path === p || x.path === '')).slice(0, 20);
      return { ok: false, changes: report, conflicts: (paths.length ? paths : ['/']).map((p) => ({ path: p, reason: 'the drive changed while merging; call checkpoint again' })), withheld: [], ignored };
    }
    throw e;
  }
  await s.materialise(dir_id);
  // An item this merge placed behind a ring leaves every other session's view at once.
  for (const op of ops) await s.applyVisibility(op.item_id);
  return { ok: true, pkg_id: applied.pkg_id, state_id: applied.state_id, changes: report, conflicts: [], withheld, ignored };
}
