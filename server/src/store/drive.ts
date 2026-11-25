// The drive's state: items in a plain tree, their versions, labels, and the
// change packages that move the drive from one state to the next.
//
// Every change to items goes through applyPackage, in one transaction, with
// preconditions on each operation; a failed precondition rolls back
// everything. The same operation semantics (applyOp) are used to replay
// packages, so any state reconstructs from the package log.
import { all, get, run, tx, getMeta, setMeta, type DB } from './db.js';
import { Blobs } from './blobs.js';
import { newId, now, sha256 } from '../util/ids.js';

export type ItemState = 'live' | 'archived' | 'trashed' | 'redacted';
export type PackageKind = 'upload' | 'checkpoint' | 'finish' | 'idle' | 'undo' | 'person';

export interface ItemTriple { path: string; state: ItemState; version: number }

export interface Op {
  op: 'create' | 'update' | 'move' | 'archive' | 'restore' | 'trash';
  item_id: string;
  path?: string; // create: the path; move: the new path; archive/restore/trash: the path
  from_path?: string; // move
  from_version?: number; // update
  to_version?: number; // create, update
  from_state?: ItemState; // archive, restore, trash
  to_state?: ItemState; // archive, restore, trash
}

export interface NewVersion {
  item_id: string;
  version: number;
  blob_hash: string;
  mime: string;
  size: number;
  ring_check: 'pending' | 'done';
  rings: string[];
  extracted?: { text: string; method: string; confidence: number };
}

export interface PackageInput {
  kind: PackageKind;
  ops: Op[];
  versions: NewVersion[];
  session_id_hash?: string | null;
  summary_claimed?: string | null;
  summary_observed?: string | null;
  /** Labels to attach to created items: [item_id, label path, assigned_by]. */
  labels?: [string, string, 'drive' | 'person' | 'session'][];
}

export interface PackageRow {
  pkg_id: string;
  parent_state: string | null;
  result_state: string;
  kind: PackageKind;
  session_id_hash: string | null;
  summary_claimed: string | null;
  summary_observed: string | null;
  operations: string;
  created_at: string;
}

export class PreconditionError extends Error {
  constructor(readonly conflicts: { item_id: string; path: string; reason: string }[]) {
    super(`precondition failed: ${conflicts.map((c) => `${c.path} (${c.reason})`).join(', ')}`);
  }
}

export const ROOT_STATE = 'st_root';
const TMP_PREFIX = '\u0000moving/';

/** Pure operation semantics, shared by apply and replay. Returns the item's triple after `op`, or throws. */
export function applyOp(before: ItemTriple | null, op: Op): ItemTriple {
  const fail = (reason: string): never => {
    throw new PreconditionError([{ item_id: op.item_id, path: op.path ?? op.from_path ?? before?.path ?? '', reason }]);
  };
  switch (op.op) {
    case 'create':
      if (before) fail('item exists');
      return { path: op.path!, state: 'live', version: op.to_version! };
    case 'update':
      if (!before) return fail('missing');
      if (before.state !== 'live') fail('not live');
      if (before.version !== op.from_version) fail('changed since');
      return { ...before, version: op.to_version! };
    case 'move':
      if (!before) return fail('missing');
      if (before.state !== 'live') fail('not live');
      if (before.path !== op.from_path) fail('moved since');
      return { ...before, path: op.path! };
    case 'archive':
    case 'trash':
    case 'restore': {
      if (!before) return fail('missing');
      if (before.state !== op.from_state) fail(`state is ${before.state}`);
      if (op.path !== undefined && before.path !== op.path) fail('moved since');
      return { ...before, state: op.to_state! };
    }
  }
}

/** Replay ops over an in-memory snapshot, checking live-path uniqueness at the end. */
export function replayOps(snapshot: Map<string, ItemTriple>, ops: Op[]): void {
  for (const op of ops) {
    const after = applyOp(snapshot.get(op.item_id) ?? null, op);
    snapshot.set(op.item_id, after);
  }
}

export function livePathCollisions(snapshot: Map<string, ItemTriple>): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const t of snapshot.values()) {
    if (t.state !== 'live') continue;
    if (seen.has(t.path)) dup.push(t.path);
    seen.add(t.path);
  }
  return dup;
}

export interface ViewEntry { path: string; item_id: string; version: number; blob_hash: string; mime: string; size: number }

export class Drive {
  constructor(readonly db: DB, readonly blobs: Blobs) {
    if (!getMeta(db, 'current_state')) {
      tx(db, () => {
        run(db, 'INSERT OR IGNORE INTO states (state_id, pkg_id, created_at) VALUES (?, NULL, ?)', ROOT_STATE, now());
        setMeta(db, 'current_state', ROOT_STATE);
      });
    }
  }

  currentState(): string {
    return getMeta(this.db, 'current_state') ?? ROOT_STATE;
  }

  item(item_id: string): { item_id: string; path: string; state: ItemState; current_version: number } | undefined {
    return get(this.db, 'SELECT item_id, path, state, current_version FROM items WHERE item_id = ?', item_id);
  }

  triple(item_id: string): ItemTriple | null {
    const r = this.item(item_id);
    return r ? { path: r.path, state: r.state, version: r.current_version } : null;
  }

  liveItemAt(path: string): { item_id: string; current_version: number } | undefined {
    return get(this.db, "SELECT item_id, current_version FROM items WHERE path = ? AND state = 'live'", path);
  }

  version(item_id: string, version: number): { blob_hash: string; mime: string; size: number; ring_check: string; rings: string } | undefined {
    return get(this.db, 'SELECT blob_hash, mime, size, ring_check, rings FROM item_versions WHERE item_id = ? AND version = ?', item_id, version);
  }

  maxVersion(item_id: string): number {
    return get<{ v: number | null }>(this.db, 'SELECT MAX(version) AS v FROM item_versions WHERE item_id = ?', item_id)?.v ?? 0;
  }

  snapshot(): Map<string, ItemTriple> {
    const m = new Map<string, ItemTriple>();
    for (const r of all<{ item_id: string; path: string; state: ItemState; current_version: number }>(this.db, 'SELECT item_id, path, state, current_version FROM items')) {
      m.set(r.item_id, { path: r.path, state: r.state, version: r.current_version });
    }
    return m;
  }

  ensureLabel(labelPath: string): string {
    const found = get<{ label_id: string }>(this.db, 'SELECT label_id FROM labels WHERE path = ?', labelPath);
    if (found) return found.label_id;
    const id = `lb_${sha256(labelPath).slice(0, 20)}`;
    run(this.db, 'INSERT OR IGNORE INTO labels (label_id, path) VALUES (?, ?)', id, labelPath);
    return id;
  }

  itemLabels(item_id: string): string[] {
    return all<{ path: string }>(this.db, 'SELECT l.path FROM item_labels il JOIN labels l ON l.label_id = il.label_id WHERE il.item_id = ? ORDER BY l.path', item_id).map((r) => r.path);
  }

  /**
   * Apply a package atomically. Every op's precondition is checked against the
   * current items; any failure, or a live-path collision, rolls back the whole
   * package and throws PreconditionError.
   */
  applyPackage(input: PackageInput): { pkg_id: string; state_id: string } {
    const db = this.db;
    return tx(db, () => {
      const parent = this.currentState();
      const pkg_id = newId('pk');
      const state_id = newId('st');
      const ts = now();

      // Check every op in order against the current rows.
      const touched = new Map<string, ItemTriple | null>();
      for (const op of input.ops) if (!touched.has(op.item_id)) touched.set(op.item_id, this.triple(op.item_id));
      const after = new Map<string, ItemTriple>();
      const conflicts: { item_id: string; path: string; reason: string }[] = [];
      for (const op of input.ops) {
        const before = after.get(op.item_id) ?? touched.get(op.item_id) ?? null;
        try {
          after.set(op.item_id, applyOp(before, op));
        } catch (e) {
          if (e instanceof PreconditionError) conflicts.push(...e.conflicts);
          else throw e;
        }
      }
      if (conflicts.length) throw new PreconditionError(conflicts);

      // Versions referenced by ops must exist (new ones are inserted below).
      const newVersions = new Map(input.versions.map((v) => [`${v.item_id}:${v.version}`, v]));

      // Phase A: move every touched existing item out of the way.
      for (const [id, before] of touched) {
        if (before) run(db, 'UPDATE items SET path = ? WHERE item_id = ?', TMP_PREFIX + id, id);
      }
      // Phase B: write final triples; the partial unique index catches collisions.
      const collisions: { item_id: string; path: string; reason: string }[] = [];
      for (const [id, t] of after) {
        try {
          if (touched.get(id)) run(db, 'UPDATE items SET path = ?, state = ?, current_version = ? WHERE item_id = ?', t.path, t.state, t.version, id);
          else run(db, 'INSERT INTO items (item_id, path, state, current_version, created_at) VALUES (?, ?, ?, ?, ?)', id, t.path, t.state, t.version, ts);
        } catch (e) {
          if (String(e).includes('UNIQUE')) collisions.push({ item_id: id, path: t.path, reason: 'path taken' });
          else throw e;
        }
      }
      if (collisions.length) throw new PreconditionError(collisions);

      for (const v of input.versions) {
        if (this.version(v.item_id, v.version)) throw new Error(`version exists: ${v.item_id}:${v.version}`);
        run(
          db,
          'INSERT INTO item_versions (item_id, version, blob_hash, mime, size, ring_check, rings, pkg_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          v.item_id, v.version, v.blob_hash, v.mime, v.size, v.ring_check, JSON.stringify(v.rings), pkg_id, ts,
        );
        if (v.extracted) {
          run(db, 'INSERT OR REPLACE INTO extracted_text (item_id, version, method, confidence, text) VALUES (?, ?, ?, ?, ?)', v.item_id, v.version, v.extracted.method, v.extracted.confidence, v.extracted.text);
        }
      }
      for (const op of input.ops) {
        if (op.to_version !== undefined && !newVersions.has(`${op.item_id}:${op.to_version}`) && !this.version(op.item_id, op.to_version)) {
          throw new Error(`op refers to a missing version ${op.item_id}:${op.to_version}`);
        }
      }
      for (const [item_id, labelPath, by] of input.labels ?? []) {
        const lid = this.ensureLabel(labelPath);
        run(db, 'INSERT OR IGNORE INTO item_labels (item_id, label_id, assigned_by, confidence, assigned_at) VALUES (?, ?, ?, NULL, ?)', item_id, lid, by, ts);
      }

      run(
        db,
        'INSERT INTO packages (pkg_id, parent_state, result_state, kind, session_id_hash, summary_claimed, summary_observed, operations, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        pkg_id, parent, state_id, input.kind, input.session_id_hash ?? null, input.summary_claimed ?? null, input.summary_observed ?? null, JSON.stringify(input.ops), ts,
      );
      run(db, 'INSERT INTO states (state_id, pkg_id, created_at) VALUES (?, ?, ?)', state_id, pkg_id, ts);
      setMeta(db, 'current_state', state_id);
      for (const id of after.keys()) this.reindex(id);
      return { pkg_id, state_id };
    });
  }

  packages(): PackageRow[] {
    return all<PackageRow>(this.db, 'SELECT * FROM packages ORDER BY rowid');
  }

  pkg(pkg_id: string): PackageRow | undefined {
    return get<PackageRow>(this.db, 'SELECT * FROM packages WHERE pkg_id = ?', pkg_id);
  }

  /** Rebuild the item table from the package log alone. */
  reconstruct(): Map<string, ItemTriple> {
    const m = new Map<string, ItemTriple>();
    let state: string | null = ROOT_STATE;
    for (const p of this.packages()) {
      if (p.parent_state !== state) throw new Error(`package ${p.pkg_id} does not follow ${state}`);
      replayOps(m, JSON.parse(p.operations) as Op[]);
      state = p.result_state;
    }
    if (state !== this.currentState()) throw new Error('package chain does not end at the current state');
    return m;
  }

  /** Item snapshots just before and just after a package, by replaying the log. */
  snapshotsAround(pkg_id: string): { before: Map<string, ItemTriple>; after: Map<string, ItemTriple>; ops: Op[] } {
    const m = new Map<string, ItemTriple>();
    for (const p of this.packages()) {
      const ops = JSON.parse(p.operations) as Op[];
      if (p.pkg_id === pkg_id) {
        const before = new Map(m);
        replayOps(m, ops);
        return { before, after: m, ops };
      }
      replayOps(m, ops);
    }
    throw new Error(`no such package: ${pkg_id}`);
  }

  // ---------- reachability ----------

  /** Rings that hide an item: its ring labels plus the rings of its newest checked version. */
  private hiddenBy(labels: string[], rings: string[]): string[] {
    const set = new Set<string>();
    for (const l of labels) if (l.startsWith('ring:') || l.startsWith('derived:ring:')) set.add(l);
    for (const r of rings) set.add(r);
    return [...set].sort();
  }

  /**
   * What an agent may see: live items at their newest checked version, with no
   * rings. Pending (unchecked) versions and ringed items are never included.
   */
  reachableView(): ViewEntry[] {
    const rows = all<{ item_id: string; path: string; version: number | null; blob_hash: string; mime: string; size: number; rings: string }>(
      this.db,
      `SELECT i.item_id, i.path, v.version, v.blob_hash, v.mime, v.size, v.rings
         FROM items i JOIN item_versions v ON v.item_id = i.item_id
        WHERE i.state = 'live'
          AND v.version = (SELECT MAX(version) FROM item_versions WHERE item_id = i.item_id AND ring_check = 'done')
        ORDER BY i.path`,
    );
    const ringLabelled = this.ringLabelledItems();
    const out: ViewEntry[] = [];
    for (const r of rows) {
      if (r.version === null) continue;
      if ((JSON.parse(r.rings) as string[]).length > 0) continue;
      if (ringLabelled.has(r.item_id)) continue;
      out.push({ path: r.path, item_id: r.item_id, version: r.version, blob_hash: r.blob_hash, mime: r.mime, size: r.size });
    }
    return out;
  }

  private ringLabelledItems(): Set<string> {
    return new Set(
      all<{ item_id: string }>(
        this.db,
        "SELECT DISTINCT il.item_id FROM item_labels il JOIN labels l ON l.label_id = il.label_id WHERE l.path LIKE 'ring:%' OR l.path LIKE 'derived:ring:%'",
      ).map((r) => r.item_id),
    );
  }

  /** Is this item reachable to agents, and at which version? */
  reachable(item_id: string): ViewEntry | null {
    const it = this.item(item_id);
    if (!it || it.state !== 'live') return null;
    const v = get<{ version: number; blob_hash: string; mime: string; size: number; rings: string }>(
      this.db,
      "SELECT version, blob_hash, mime, size, rings FROM item_versions WHERE item_id = ? AND ring_check = 'done' ORDER BY version DESC LIMIT 1",
      item_id,
    );
    if (!v) return null;
    if (this.hiddenBy(this.itemLabels(item_id), JSON.parse(v.rings) as string[]).length) return null;
    return { path: it.path, item_id, version: v.version, blob_hash: v.blob_hash, mime: v.mime, size: v.size };
  }

  /** For a live item that is not reachable: the rings hiding it, or ['unchecked']. */
  hidingRings(item_id: string): string[] {
    const v = get<{ rings: string }>(this.db, "SELECT rings FROM item_versions WHERE item_id = ? AND ring_check = 'done' ORDER BY version DESC LIMIT 1", item_id);
    const r = this.hiddenBy(this.itemLabels(item_id), v ? (JSON.parse(v.rings) as string[]) : []);
    if (r.length) return r;
    return v ? [] : ['unchecked'];
  }

  /** Counts of live items hidden from agents, per ring. Never names. */
  hiddenCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    const reach = new Set(this.reachableView().map((e) => e.item_id));
    for (const r of all<{ item_id: string }>(this.db, "SELECT item_id FROM items WHERE state = 'live'")) {
      if (reach.has(r.item_id)) continue;
      for (const ring of this.hidingRings(r.item_id)) counts[ring] = (counts[ring] ?? 0) + 1;
    }
    return counts;
  }

  // ---------- search index ----------

  /** Keep search_index in step with an item: one row for its newest checked version, if live. */
  reindex(item_id: string): void {
    run(this.db, 'DELETE FROM search_index WHERE item_id = ?', item_id);
    const it = this.item(item_id);
    if (!it || it.state !== 'live') return;
    const v = get<{ version: number; rings: string }>(this.db, "SELECT version, rings FROM item_versions WHERE item_id = ? AND ring_check = 'done' ORDER BY version DESC LIMIT 1", item_id);
    if (!v) return;
    const t = get<{ text: string }>(this.db, 'SELECT text FROM extracted_text WHERE item_id = ? AND version = ?', item_id, v.version);
    const labels = [...this.itemLabels(item_id), ...(JSON.parse(v.rings) as string[])].join(' ');
    run(this.db, 'INSERT INTO search_index (item_id, path, labels, text) VALUES (?, ?, ?, ?)', item_id, it.path, labels, t?.text ?? '');
  }

  /** Full-text matches over every indexed item. Callers filter by reachability. */
  searchRaw(query: string, limit = 200): { item_id: string; path: string; snippet: string }[] {
    const terms = query
      .split(/\s+/)
      .map((t) => t.replace(/"/g, '').trim())
      .filter(Boolean)
      .map((t) => `"${t}"`);
    if (!terms.length) return [];
    try {
      return all(
        this.db,
        "SELECT item_id, path, snippet(search_index, 3, '[', ']', ' … ', 12) AS snippet FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT ?",
        terms.join(' '),
        limit,
      );
    } catch {
      return [];
    }
  }

  // ---------- activity ----------

  activity(a: { dir_id?: string | null; actor: 'agent' | 'person' | 'drive' | 'fs'; op: string; item_id?: string | null; bytes?: number | null; detail?: unknown }): void {
    run(
      this.db,
      'INSERT INTO activity (ts, dir_id, actor, op, item_id, bytes_returned, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      now(), a.dir_id ?? null, a.actor, a.op, a.item_id ?? null, a.bytes ?? null, a.detail === undefined ? null : JSON.stringify(a.detail),
    );
  }
}
