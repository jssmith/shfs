// One-off cleanup: archive live items that match the merge ignore list,
// merged before the list existed. One package, so the owner can undo it.
import { all, tx } from '../store/db.js';
import type { Drive, Op } from '../store/drive.js';
import { isToolCache } from './ignore.js';

export function archiveToolCaches(drive: Drive): { pkg_id: string | null; paths: string[] } {
  const hits = all<{ item_id: string; path: string }>(drive.db, "SELECT item_id, path FROM items WHERE state = 'live' ORDER BY path").filter((r) => isToolCache(r.path));
  if (!hits.length) return { pkg_id: null, paths: [] };
  const ops: Op[] = hits.map((h) => ({ op: 'archive', item_id: h.item_id, path: h.path, from_state: 'live', to_state: 'archived' }));
  return tx(drive.db, () => {
    const r = drive.applyPackage({ kind: 'person', ops, versions: [], summary_observed: `archive ${hits.length} tool-cache items (merge ignore list)` });
    drive.activity({ actor: 'person', op: 'archive_tool_caches', detail: { pkg_id: r.pkg_id, count: hits.length } });
    return { pkg_id: r.pkg_id, paths: hits.map((h) => h.path) };
  });
}
