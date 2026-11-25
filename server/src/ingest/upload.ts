// An upload is one package: new items, or new versions of items already at
// those paths. Every new version starts unchecked; the job loop checks it.
import path from 'node:path';
import type { Drive, NewVersion, Op } from '../store/drive.js';
import { cleanDrivePath } from '../util/fsafe.js';
import { newId } from '../util/ids.js';
import { enqueueCheck, mimeFor } from './check.js';
import { tx } from '../store/db.js';

export interface UploadFile { path: string; hash: string; size: number; mime?: string }

export interface UploadResult { pkg_id: string | null; created: number; updated: number; unchanged: number }

const LABEL_RE = /^[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9._-]*)+$/;

export function validLabel(l: string): boolean {
  return LABEL_RE.test(l) && !l.startsWith('derived:');
}

export function ingestUpload(drive: Drive, files: UploadFile[], labels: string[], source: string): UploadResult {
  for (const l of labels) if (!validLabel(l)) throw new Error(`invalid label: ${l}`);
  const seen = new Set<string>();
  const ops: Op[] = [];
  const versions: NewVersion[] = [];
  const pkgLabels: [string, string, 'drive' | 'person'][] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const f of files) {
    const p = cleanDrivePath(f.path);
    if (p.split('/').some((s) => s.startsWith('.ad-tmp-'))) throw new Error(`invalid path: ${p}`);
    if (seen.has(p)) throw new Error(`duplicate path in upload: ${p}`);
    seen.add(p);
    if (!/^[0-9a-f]{64}$/.test(f.hash) || !drive.blobs.has(f.hash)) throw new Error(`missing blob for ${p}`);
    const mime = f.mime ?? mimeFor(path.basename(p));
    const existing = drive.liveItemAt(p);
    if (existing) {
      const cur = drive.version(existing.item_id, existing.current_version);
      if (cur?.blob_hash === f.hash) {
        unchanged++;
        continue;
      }
      const v = drive.maxVersion(existing.item_id) + 1;
      versions.push({ item_id: existing.item_id, version: v, blob_hash: f.hash, mime, size: f.size, ring_check: 'pending', rings: [] });
      ops.push({ op: 'update', item_id: existing.item_id, from_version: existing.current_version, to_version: v });
      for (const l of labels) pkgLabels.push([existing.item_id, l, 'person']);
      updated++;
    } else {
      const id = newId('it');
      versions.push({ item_id: id, version: 1, blob_hash: f.hash, mime, size: f.size, ring_check: 'pending', rings: [] });
      ops.push({ op: 'create', item_id: id, to_version: 1, path: p });
      for (const l of [...labels, 'source:upload']) pkgLabels.push([id, l, l.startsWith('source:') ? 'drive' : 'person']);
      created++;
    }
  }
  if (!ops.length) return { pkg_id: null, created, updated, unchanged };
  return tx(drive.db, () => {
    const { pkg_id } = drive.applyPackage({ kind: 'upload', ops, versions, labels: pkgLabels, summary_observed: `upload from ${source}: ${created} new, ${updated} updated` });
    for (const v of versions) enqueueCheck(drive, v.item_id, v.version);
    drive.activity({ actor: 'person', op: 'upload', detail: { pkg_id, source, created, updated } });
    return { pkg_id, created, updated, unchanged };
  });
}
