// Search for a session. Visible items (in the session's view, or reachable
// and new since its base) match on their text, labels and path. Items the
// session cannot read match on metadata only: their labels, their kind (from
// the MIME type) and the month they were added. Their text and names never
// take part, so guessing content gives no signal (decision: content-guessing
// oracle, docs/decisions/0005 bug 2). Counts of hidden matches are grouped by
// ring and reported approximately.
import { all, get } from '../store/db.js';
import type { Drive } from '../store/drive.js';

export interface SearchHit { path: string; snippet: string; note?: string }
export type Facet = 'label' | 'kind' | 'month';
export interface HiddenMatch { ring: string; count: number; by: Facet[] }
export interface SearchResult {
  /** Every visible match, best first. */
  results: SearchHit[];
  /** Hidden items matching on metadata only, per ring. */
  hidden: HiddenMatch[];
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Words a query is split into for metadata matching: lower case, letters and digits, 3+ characters (or a 2-digit/4-digit number). */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9-]+/).flatMap((w) => [w, ...w.split('-')]).filter((w) => w.length >= 3 || /^\d{2}$/.test(w)))];
}

function norm(w: string): string {
  return w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
}

export function kindWords(mime: string): string[] {
  const m = mime.toLowerCase();
  if (m === 'application/pdf') return ['pdf', 'document'];
  if (m.startsWith('image/')) return ['image', 'photo', 'picture', m.slice(6)];
  if (m === 'text/csv' || m.includes('spreadsheet') || m.includes('excel')) return ['spreadsheet', 'csv', 'table'];
  if (m.includes('wordprocessing') || m === 'application/msword') return ['document', 'doc'];
  if (m.startsWith('text/')) return ['text', 'note', m.slice(5)];
  if (m.startsWith('audio/')) return ['audio'];
  if (m.startsWith('video/')) return ['video'];
  return ['file'];
}

export function monthWords(iso: string): string[] {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return [];
  const y = String(d.getUTCFullYear());
  const mi = d.getUTCMonth();
  const mm = String(mi + 1).padStart(2, '0');
  return [y, `${y}-${mm}`, MONTHS[mi]!, MONTHS[mi]!.slice(0, 3)];
}

export function labelWords(labels: string[]): string[] {
  return labels.flatMap((l) => l.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 2);
}

/** Approximate count: exact up to 10, then about two significant figures ("about 1,200"). */
export function approx(n: number): string {
  if (n <= 10) return String(n);
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return `about ${(Math.round(n / mag) * mag).toLocaleString('en-US')}`;
}

/** "ring:finance" → "Finance"; held and unchecked items get plain names. */
export function ringName(ring: string): string {
  if (ring === 'held:uncertain') return 'Held for the person to check';
  if (ring === 'unchecked') return 'Not yet checked';
  const last = ring.split(':').pop() ?? ring;
  return last.charAt(0).toUpperCase() + last.slice(1).replace(/-/g, ' ');
}

export function hiddenSummary(hidden: HiddenMatch[]): string {
  if (!hidden.length) return 'none';
  return hidden.map((h) => `${ringName(h.ring)}: ${approx(h.count)} item${h.count === 1 ? '' : 's'} match${h.count === 1 ? 'es' : ''} by ${h.by.join(' or ')}`).join('; ');
}

/** Old (v0, v1) shape: counts per ring. */
export function hiddenCountsOf(hidden: HiddenMatch[]): Record<string, number> {
  return Object.fromEntries(hidden.map((h) => [h.ring, h.count]));
}

export function searchSession(drive: Drive, dir_id: string, query: string): SearchResult {
  const db = drive.db;
  const view = new Map(all<{ item_id: string; path: string }>(db, 'SELECT item_id, path FROM session_view WHERE dir_id = ?', dir_id).map((r) => [r.item_id, r.path]));
  const results: SearchHit[] = [];
  for (const hit of drive.searchRaw(query, 100_000)) {
    const vp = view.get(hit.item_id);
    if (vp) {
      results.push({ path: `/drive/${vp}`, snippet: hit.snippet });
      continue;
    }
    const reach = drive.reachable(hit.item_id);
    if (reach) results.push({ path: `/drive/${reach.path}`, snippet: hit.snippet, note: 'new since this session began; it appears in /drive after your next merge' });
    // Anything else is an item this session cannot read: its text match is dropped here, unseen.
  }

  const terms = queryTerms(query).map(norm);
  const hidden = new Map<string, { count: number; by: Set<Facet> }>();
  if (terms.length) {
    const reachable = new Set(drive.reachableView().map((v) => v.item_id));
    const live = all<{ item_id: string; created_at: string; current_version: number }>(db, "SELECT item_id, created_at, current_version FROM items WHERE state = 'live'");
    for (const it of live) {
      if (view.has(it.item_id) || reachable.has(it.item_id)) continue;
      const rings = drive.hidingRings(it.item_id);
      if (!rings.length) continue;
      const mime = get<{ mime: string }>(db, 'SELECT mime FROM item_versions WHERE item_id = ? AND version = ?', it.item_id, it.current_version)?.mime ?? '';
      const facets: [Facet, string[]][] = [
        ['label', labelWords([...drive.itemLabels(it.item_id), ...rings])],
        ['kind', kindWords(mime)],
        ['month', monthWords(it.created_at)],
      ];
      const by = new Set<Facet>();
      for (const [f, words] of facets) {
        const ws = new Set(words.map(norm));
        if (terms.some((t) => ws.has(t))) by.add(f);
      }
      if (!by.size) continue;
      for (const ring of rings) {
        const h = hidden.get(ring) ?? { count: 0, by: new Set<Facet>() };
        h.count++;
        for (const f of by) h.by.add(f);
        hidden.set(ring, h);
      }
    }
  }
  const order: Facet[] = ['label', 'kind', 'month'];
  return {
    results,
    hidden: [...hidden].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ring, h]) => ({ ring, count: h.count, by: order.filter((f) => h.by.has(f)) })),
  };
}
