// Held items: versions the ring check could not place (marker HELD, see
// check.ts) wait for the person. The person releases them (reachable to
// sessions), puts them in a ring, or trashes them. Each action is one
// package of kind 'person', so undo works as for any other change: release
// and ring write a new version with the same content and the person's rings;
// undo writes the held rings back.
import path from 'node:path';
import { all, get, tx } from '../store/db.js';
import type { Drive, NewVersion, Op } from '../store/drive.js';
import { RINGS } from '../reading/rules.js';
import { DEFAULTS } from '../reading/ring-check.js';
import { HELD } from './check.js';

export type HeldReason = 'no_text' | 'low_ocr' | 'ocr_no_ring' | 'uncertain';

export const REASON_TITLES: Record<HeldReason, string> = {
  no_text: 'No readable text',
  low_ocr: 'Low OCR confidence',
  ocr_no_ring: 'Read by OCR, placed in no ring',
  uncertain: 'Unsure which ring',
};

export interface HeldItem {
  item_id: string;
  path: string;
  folder: string;
  name: string;
  version: number;
  size: number;
  mime: string;
  created_at: string;
  reason: HeldReason;
  reason_text: string;
  /** Rings the check did place as well (the item is hidden by them too). */
  rings_found: string[];
  method: string;
  confidence: number | null;
  preview: 'image' | 'text' | 'none';
}

export const PERSON_RINGS: string[] = RINGS.map((r) => r);

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'application/pdf']);

export function previewKind(mime: string, method: string): HeldItem['preview'] {
  if (IMAGE_MIMES.has(mime)) return 'image';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || method === 'plain' || method === 'text-layer') return 'text';
  return 'none';
}

/** Why a version is held, from how it was read and what the check said (its ring_check activity). */
export function heldReason(ex: { method: string; confidence: number } | undefined, reasons: { ring: string; source: string; detail?: string }[]): { reason: HeldReason; text: string } {
  const details = reasons.map((r) => r.detail ?? '').filter(Boolean);
  const unsure = reasons.filter((r) => r.ring.startsWith('ring:'));
  if (!ex || ex.method === 'none' || details.includes('no readable text')) return { reason: 'no_text', text: 'The drive could not read this file, so it cannot tell what is in it.' };
  const lowOcr = details.find((d) => d.startsWith('low OCR confidence'));
  if (lowOcr || (ex.method === 'ocr' && ex.confidence < DEFAULTS.minOcrConfidence && !unsure.length)) {
    return { reason: 'low_ocr', text: `OCR confidence ${ex.confidence.toFixed(2)}: the text read from this image may be wrong.` };
  }
  if (unsure.length) {
    const list = unsure.map((r) => `${r.ring}${r.detail ? ` (${r.source}: ${r.detail})` : ` (${r.source})`}`).join('; ');
    return { reason: 'uncertain', text: `The check was unsure whether this belongs in a ring: ${list}.` };
  }
  if (ex.method === 'ocr') return { reason: 'ocr_no_ring', text: 'OCR misses some sensitive images, so an image no rule placed waits for you (decision 0002).' };
  return { reason: 'uncertain', text: 'The check could not decide.' };
}

/** The newest checked version of a live item, if it is held. */
function heldVersion(drive: Drive, item_id: string): { version: number; blob_hash: string; mime: string; size: number; rings: string[]; created_at: string } | null {
  const it = drive.item(item_id);
  if (!it || it.state !== 'live') return null;
  const v = get<{ version: number; blob_hash: string; mime: string; size: number; rings: string; created_at: string }>(
    drive.db,
    "SELECT version, blob_hash, mime, size, rings, created_at FROM item_versions WHERE item_id = ? AND ring_check = 'done' ORDER BY version DESC LIMIT 1",
    item_id,
  );
  if (!v) return null;
  const rings = JSON.parse(v.rings) as string[];
  if (!rings.includes(HELD)) return null;
  return { ...v, rings };
}

/** Every live item whose newest checked version is held, by path. */
export function listHeld(drive: Drive): HeldItem[] {
  const rows = all<{ item_id: string }>(
    drive.db,
    `SELECT i.item_id FROM items i JOIN item_versions v ON v.item_id = i.item_id
      WHERE i.state = 'live' AND v.ring_check = 'done' AND v.rings LIKE ?
        AND v.version = (SELECT MAX(version) FROM item_versions WHERE item_id = i.item_id AND ring_check = 'done')
      ORDER BY i.path`,
    `%"${HELD}"%`,
  );
  const out: HeldItem[] = [];
  for (const { item_id } of rows) {
    const it = drive.item(item_id)!;
    const v = heldVersion(drive, item_id);
    if (!v) continue;
    const ex = get<{ method: string; confidence: number }>(drive.db, 'SELECT method, confidence FROM extracted_text WHERE item_id = ? AND version = ?', item_id, v.version);
    const reasons = checkReasons(drive, item_id, v.version);
    const why = heldReason(ex, reasons);
    const slash = it.path.lastIndexOf('/');
    out.push({
      item_id,
      path: it.path,
      folder: slash >= 0 ? it.path.slice(0, slash) : '',
      name: path.posix.basename(it.path),
      version: v.version,
      size: v.size,
      mime: v.mime,
      created_at: v.created_at,
      reason: why.reason,
      reason_text: why.text,
      rings_found: v.rings.filter((r) => r !== HELD),
      method: ex?.method ?? 'none',
      confidence: ex?.confidence ?? null,
      preview: previewKind(v.mime, ex?.method ?? 'none'),
    });
  }
  return out;
}

/** The reasons the ring check recorded for this version (activity op ring_check). */
function checkReasons(drive: Drive, item_id: string, version: number): { ring: string; source: string; detail?: string }[] {
  for (const a of all<{ detail: string | null }>(drive.db, "SELECT detail FROM activity WHERE op = 'ring_check' AND item_id = ? ORDER BY id DESC LIMIT 20", item_id)) {
    const d = a.detail ? (JSON.parse(a.detail) as { version?: number; reasons?: { ring: string; source: string; detail?: string }[] }) : {};
    if (d.version === version) return d.reasons ?? [];
  }
  return [];
}

export class HeldError extends Error {
  constructor(readonly problems: { item_id: string; reason: string }[]) {
    super(`not held: ${problems.map((p) => `${p.item_id} (${p.reason})`).join(', ')}`);
  }
}

export type HeldAction = { kind: 'release' } | { kind: 'ring'; ring: string } | { kind: 'trash' };

export interface HeldActionResult {
  pkg_id: string;
  items: { item_id: string; path: string }[];
}

/**
 * Apply the person's decision to held items, as one package. Every item must
 * be live and held at its current version; otherwise nothing changes.
 */
export function actOnHeld(drive: Drive, item_ids: string[], action: HeldAction): HeldActionResult {
  const ids = [...new Set(item_ids)];
  if (!ids.length) throw new HeldError([]);
  if (action.kind === 'ring' && !PERSON_RINGS.includes(action.ring)) throw new Error(`unknown ring: ${action.ring}`);
  return tx(drive.db, () => {
    const problems: { item_id: string; reason: string }[] = [];
    const ops: Op[] = [];
    const versions: NewVersion[] = [];
    const items: { item_id: string; path: string }[] = [];
    for (const id of ids) {
      const it = drive.item(id);
      const v = heldVersion(drive, id);
      if (!it || !v) {
        problems.push({ item_id: id, reason: 'not a held item' });
        continue;
      }
      if (it.current_version !== v.version) {
        problems.push({ item_id: id, reason: 'a newer version is still being checked' });
        continue;
      }
      items.push({ item_id: id, path: it.path });
      if (action.kind === 'trash') {
        ops.push({ op: 'trash', item_id: id, path: it.path, from_state: 'live', to_state: 'trashed' });
        continue;
      }
      const to = drive.maxVersion(id) + 1;
      const text = get<{ method: string; confidence: number; text: string }>(drive.db, 'SELECT method, confidence, text FROM extracted_text WHERE item_id = ? AND version = ?', id, v.version);
      versions.push({ item_id: id, version: to, blob_hash: v.blob_hash, mime: v.mime, size: v.size, ring_check: 'done', rings: action.kind === 'ring' ? [action.ring] : [], extracted: text });
      ops.push({ op: 'update', item_id: id, from_version: v.version, to_version: to });
    }
    if (problems.length) throw new HeldError(problems);
    const what = action.kind === 'release' ? 'release' : action.kind === 'ring' ? `put in ${action.ring}` : 'trash';
    const observed = `${what}: ${items.length} held item${items.length === 1 ? '' : 's'}${items.length <= 3 ? ` (${items.map((i) => i.path).join(', ')})` : ''}`;
    const r = drive.applyPackage({ kind: 'person', ops, versions, summary_observed: observed });
    drive.activity({ actor: 'person', op: `held_${action.kind}`, detail: { pkg_id: r.pkg_id, ...(action.kind === 'ring' ? { ring: action.ring } : {}), items: items.map((i) => i.item_id) } });
    return { pkg_id: r.pkg_id, items };
  });
}
