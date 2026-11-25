// Held items: the person releases them (sessions see them at once), puts them
// in a ring (still hidden, counted) or trashes them; each is one undoable
// package. Over MCP (v0, no sandbox) and the owner API.
import { afterEach, expect, test } from 'vitest';
import { upload, settle } from '../testing.js';
import { mcpEnv, type McpEnv } from '../mcp/test-env.js';
import { get, run } from '../store/db.js';
import { setOwnerPassword } from '../auth/owner.js';
import { HELD } from '../ingest/check.js';
import { heldReason, listHeld } from '../ingest/held.js';
import { sniffImage } from './held.js';

let port = 9490; // shifted by AGENT_DRIVE_TEST_PORT_OFFSET (mcp/test-env.ts)
const open: McpEnv[] = [];
afterEach(async () => {
  for (const e of open.splice(0)) await e.close();
});
async function env(): Promise<McpEnv> {
  const e = await mcpEnv('v0', port++);
  open.push(e);
  return e;
}
async function owner(e: McpEnv) {
  setOwnerPassword(e.ctx.drive.db, 'synthetic-pw');
  const login = await fetch(`${e.ctx.config.publicUrl}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=synthetic-pw' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const url = (p: string) => `${e.ctx.config.publicUrl}${p}`;
  return {
    raw: (p: string) => fetch(url(p), { headers: { cookie } }),
    get: async (p: string) => (await fetch(url(p), { headers: { cookie } })).json(),
    post: async (p: string, body: unknown) => {
      const r = await fetch(url(p), { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-drive-app': '1' }, body: JSON.stringify(body) });
      return { status: r.status, ...(await r.json()) };
    },
  };
}
/** A file the reader cannot read (a NUL byte in it): the check holds it. */
const BINARY = 'synthetic scan\u0000\u0001\u0002 not text';

async function heldDrive() {
  const e = await env();
  await upload(e.ctx, { 'scans/receipt-1.bin': BINARY, 'scans/receipt-2.bin': `${BINARY} 2`, 'notes/plan.md': 'a plain plan for the garden\n' });
  await settle(e.ctx);
  const r = await e.call('start_session', { purpose: 'tidy the scans' });
  const sid = String(r.structured.session_id);
  const dir = get<{ dir_id: string }>(e.ctx.drive.db, 'SELECT dir_id FROM sessions')!.dir_id;
  const id = (p: string) => e.ctx.drive.liveItemAt(p)!.item_id;
  const epoch = () => get<{ epoch: number }>(e.ctx.drive.db, 'SELECT epoch FROM session_view_epoch WHERE dir_id = ?', dir)!.epoch;
  const inView = (p: string) => !!get(e.ctx.drive.db, 'SELECT 1 FROM session_view WHERE dir_id = ? AND path = ?', dir, p);
  return { e, sid, dir, id, epoch, inView, app: await owner(e) };
}

test('held items are listed with their reason; release makes one visible to an open session at once', async () => {
  const { e, sid, id, epoch, inView, app } = await heldDrive();
  const held = await app.get('/api/app/held');
  expect(held.items.map((i: { path: string }) => i.path)).toEqual(['scans/receipt-1.bin', 'scans/receipt-2.bin']);
  expect(held.items[0]).toMatchObject({ folder: 'scans', name: 'receipt-1.bin', reason: 'no_text', size: Buffer.byteLength(BINARY), preview: 'none' });
  expect(held.counts).toEqual({ no_text: 2 });
  expect(held.rings).toContain('ring:finance');
  expect((await e.call('read', { session_id: sid, path: 'scans/receipt-1.bin' })).isError).toBe(true);
  expect(inView('scans/receipt-1.bin')).toBe(false);

  const before = epoch();
  const rel = await app.post('/api/app/held/release', { item_ids: [id('scans/receipt-1.bin')] });
  expect(rel).toMatchObject({ ok: true, items: [{ path: 'scans/receipt-1.bin' }] });
  expect(epoch()).toBeGreaterThan(before);
  expect(inView('scans/receipt-1.bin')).toBe(true);
  const read = await e.call('read', { session_id: sid, path: 'scans/receipt-1.bin' });
  expect(read.isError).toBe(false);
  expect(e.ctx.drive.reachable(id('scans/receipt-1.bin'))).not.toBeNull();
  expect((await app.get('/api/app/held')).items.map((i: { path: string }) => i.path)).toEqual(['scans/receipt-2.bin']);
  // Recorded as a person package and in activity.
  const pkg = e.ctx.drive.pkg(rel.pkg_id)!;
  expect(pkg.kind).toBe('person');
  expect(pkg.summary_observed).toBe('release: 1 held item (scans/receipt-1.bin)');
  expect(get(e.ctx.drive.db, "SELECT op FROM activity WHERE op = 'held_release'")).toEqual({ op: 'held_release' });
  // A merge afterwards does not mistake the released file for the session's own change.
  const cp = await e.call('checkpoint', { session_id: sid, summary: 'nothing' });
  expect(cp.isError, cp.text).toBe(false);
  expect(cp.text).not.toMatch(/conflict/i);
  expect(e.ctx.drive.packages().filter((p) => p.kind === 'checkpoint')).toHaveLength(0);
});

test('put in a ring: still hidden from sessions, counted under that ring', async () => {
  const { e, sid, id, inView, app } = await heldDrive();
  const r = await app.post('/api/app/held/ring', { item_ids: [id('scans/receipt-1.bin'), id('scans/receipt-2.bin')], ring: 'finance' });
  expect(r.ok).toBe(true);
  expect(e.ctx.drive.packages().filter((p) => p.kind === 'person')).toHaveLength(1); // a selection is one package
  expect(e.ctx.drive.hiddenCounts()).toEqual({ 'ring:finance': 2 });
  expect(inView('scans/receipt-1.bin')).toBe(false);
  expect((await e.call('read', { session_id: sid, path: 'scans/receipt-1.bin' })).isError).toBe(true);
  expect((await app.get('/api/app/held')).items).toEqual([]);
  expect((await app.post('/api/app/held/ring', { item_ids: [id('notes/plan.md')], ring: 'nope' })).status).toBe(400);
});

test('undo of a release hides the item again; undo of a ring or trash holds it again', async () => {
  const { e, sid, id, inView, app } = await heldDrive();
  const one = id('scans/receipt-1.bin');
  const rel = await app.post('/api/app/held/release', { item_ids: [one] });
  expect(inView('scans/receipt-1.bin')).toBe(true);
  const u = await app.post('/api/app/undo', { pkg_id: rel.pkg_id });
  expect(u.ok).toBe(true);
  expect(e.ctx.drive.reachable(one)).toBeNull();
  expect(inView('scans/receipt-1.bin')).toBe(false);
  expect((await e.call('read', { session_id: sid, path: 'scans/receipt-1.bin' })).isError).toBe(true);
  expect(listHeld(e.ctx.drive).map((i) => i.item_id)).toContain(one);

  const tr = await app.post('/api/app/held/trash', { item_ids: [one] });
  expect(e.ctx.drive.item(one)!.state).toBe('trashed');
  await app.post('/api/app/undo', { pkg_id: tr.pkg_id });
  expect(e.ctx.drive.item(one)!.state).toBe('live');
  expect(e.ctx.drive.reachable(one)).toBeNull();
  expect(listHeld(e.ctx.drive).map((i) => i.item_id)).toContain(one);
});

test('only held items can be acted on; a mixed selection changes nothing', async () => {
  const { e, id, app } = await heldDrive();
  const r = await app.post('/api/app/held/release', { item_ids: [id('scans/receipt-1.bin'), id('notes/plan.md')] });
  expect(r.status).toBe(409);
  expect(r.problems).toEqual([{ item_id: id('notes/plan.md'), reason: 'not a held item' }]);
  expect(e.ctx.drive.packages().filter((p) => p.kind === 'person')).toHaveLength(0);
  expect((await app.post('/api/app/held/release', { item_ids: [] })).status).toBe(409);
});

test('previews: images only when the bytes are an image, text as JSON, never HTML', async () => {
  const { e, id, app } = await heldDrive();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  const html = '<!doctype html><script>alert(1)</script><b>synthetic</b>';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  await upload(e.ctx, { 'pics/dot.png': png.toString('latin1'), 'pics/page.html': html, 'pics/fake.png': svg });
  // upload() writes strings as UTF-8; store the PNG's real bytes.
  const hash = await e.ctx.drive.blobs.put(png);
  run(e.ctx.drive.db, 'UPDATE item_versions SET blob_hash = ? WHERE item_id = ?', hash, id('pics/dot.png'));

  const img = await app.raw(`/api/app/items/${id('pics/dot.png')}/preview`);
  expect(img.status).toBe(200);
  expect(img.headers.get('content-type')).toBe('image/png');
  expect(img.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  expect(img.headers.get('x-content-type-options')).toBe('nosniff');
  expect(Buffer.from(await img.arrayBuffer()).equals(png)).toBe(true);
  // An SVG named .png is not served as an image; nor is HTML.
  expect((await app.raw(`/api/app/items/${id('pics/fake.png')}/preview`)).status).toBe(415);
  expect((await app.raw(`/api/app/items/${id('pics/page.html')}/preview`)).status).toBe(415);
  const t = await app.raw(`/api/app/items/${id('pics/page.html')}/text`);
  expect(t.headers.get('content-type')).toMatch(/^application\/json/);
  expect((await t.json()).text).toBe(html);
  expect(sniffImage(Buffer.from(svg))).toBeNull();
  // Signed out: nothing.
  expect((await fetch(`${e.ctx.config.publicUrl}/api/app/items/${id('pics/dot.png')}/preview`)).status).toBe(401);
});

test('a PDF previews as a PNG rendered on the server', async () => {
  const { e, id, app } = await heldDrive();
  const pdf = [
    '%PDF-1.4', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj', '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    '4 0 obj<</Length 44>>stream', 'BT /F1 18 Tf 20 40 Td (Synthetic) Tj ET', 'endstream endobj', '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'trailer<</Root 1 0 R>>', '%%EOF',
  ].join('\n');
  await upload(e.ctx, { 'docs/page.pdf': pdf });
  await settle(e.ctx);
  const r = await app.raw(`/api/app/items/${id('docs/page.pdf')}/preview`);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toBe('image/png');
  expect(sniffImage(Buffer.from(await r.arrayBuffer()))).toBe('image/png');
});

test('the held page and the session page are served to the owner only, with a CSP', async () => {
  const { e, dir, app } = await heldDrive();
  for (const p of ['/held', `/session/${dir}`]) {
    const r = await app.raw(p);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain("img-src 'self'");
    expect((await fetch(`${e.ctx.config.publicUrl}${p}`, { redirect: 'manual' })).status).toBe(303);
  }
  expect((await app.get(`/api/app/sessions/${dir}`)).session.dir_id).toBe(dir);
  expect((await app.raw('/api/app/sessions/sd_nope')).status).toBe(404);
});

test('the reason for a hold', () => {
  expect(heldReason({ method: 'none', confidence: 0 }, []).reason).toBe('no_text');
  expect(heldReason({ method: 'ocr', confidence: 0.3 }, [{ ring: 'unknown', source: 'rule', detail: 'low OCR confidence 0.30' }])).toMatchObject({ reason: 'low_ocr' });
  expect(heldReason({ method: 'ocr', confidence: 0.9 }, [{ ring: 'unknown', source: 'rule', detail: 'read by OCR and placed in no ring: held' }]).reason).toBe('ocr_no_ring');
  const u = heldReason({ method: 'plain', confidence: 1 }, [{ ring: 'ring:health', source: 'rule', detail: 'health-keywords (0.55): clinic' }]);
  expect(u.reason).toBe('uncertain');
  expect(u.text).toContain('ring:health (rule: health-keywords (0.55): clinic)');
  expect(HELD).toBe('held:uncertain');
});
