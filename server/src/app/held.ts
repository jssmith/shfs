// The owner's API for held items (ingest/held.ts) and safe previews of item
// content. Item content never runs in the app's origin: text goes out as
// JSON (the page inserts it with textContent), images only as PNG, JPEG, GIF
// or WebP whose bytes were checked, or as a PNG the server rendered (PDF
// first page with pdftoppm, HEIC with ImageMagick, its coder named
// explicitly so the input cannot pick another one), each with a sandbox CSP
// and nosniff.
import express, { type RequestHandler, type Response, type Router } from 'express';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '../context.js';
import { get } from '../store/db.js';
import { actOnHeld, HeldError, listHeld, PERSON_RINGS, REASON_TITLES, type HeldAction } from '../ingest/held.js';

const run = promisify(execFile);
const TEXT_PREVIEW = 8 * 1024;
const PREVIEW_PX = 800;

/** The image type the bytes really are, for the types a browser shows as images (never SVG). */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function isPdf(b: Buffer): boolean {
  return b.subarray(0, 5).toString('latin1') === '%PDF-';
}

function isHeic(b: Buffer): boolean {
  return b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1'));
}

/** Render the first page of a PDF, or a HEIC image, to PNG. Null if the tool is missing or fails. */
export async function renderPreview(blobPath: string, kind: 'pdf' | 'heic'): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ad-preview-'));
  try {
    const out = path.join(dir, 'p');
    if (kind === 'pdf') {
      await run('pdftoppm', ['-png', '-f', '1', '-l', '1', '-singlefile', '-scale-to', String(PREVIEW_PX), blobPath, out], { timeout: 20_000 });
    } else {
      await run('convert', [`heic:${blobPath}[0]`, '-auto-orient', '-resize', `${PREVIEW_PX}x${PREVIEW_PX}>`, `png:${out}.png`], { timeout: 20_000 });
    }
    return await readFile(`${out}.png`);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sendImage(res: Response, type: string, data: Buffer): void {
  res
    .set({
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline; filename="preview"',
      'Cache-Control': 'private, no-store',
    })
    .send(data);
}

export function heldRouter(ctx: Context, owner: RequestHandler): Router {
  const r = express.Router();
  const { drive, sessions } = ctx;

  /** The version the owner sees of a live item: its current one. */
  const current = (item_id: string) => {
    const it = drive.item(item_id);
    if (!it || it.state !== 'live') return null;
    const v = drive.version(item_id, it.current_version);
    return v ? { ...v, version: it.current_version, path: it.path } : null;
  };

  r.get('/api/app/held', owner, (_req, res) => {
    const items = listHeld(drive);
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.reason] = (counts[i.reason] ?? 0) + 1;
    res.json({ items, counts, reasons: REASON_TITLES, rings: PERSON_RINGS });
  });

  r.get('/api/app/items/:item_id/preview', owner, async (req, res) => {
    const v = current(String(req.params.item_id));
    if (!v) {
      res.status(404).json({ error: 'no such item' });
      return;
    }
    const p = drive.blobs.pathOf(v.blob_hash);
    const data = await readFile(p);
    const img = sniffImage(data);
    if (img) {
      sendImage(res, img, data);
      return;
    }
    const kind = isPdf(data) ? 'pdf' : isHeic(data) ? 'heic' : null;
    const png = kind ? await renderPreview(p, kind) : null;
    if (!png) {
      res.status(415).json({ error: 'no preview for this kind of file' });
      return;
    }
    sendImage(res, 'image/png', png);
  });

  r.get('/api/app/items/:item_id/text', owner, async (req, res) => {
    const id = String(req.params.item_id);
    const v = current(id);
    if (!v) {
      res.status(404).json({ error: 'no such item' });
      return;
    }
    const ex = get<{ method: string; text: string }>(drive.db, 'SELECT method, text FROM extracted_text WHERE item_id = ? AND version = ?', id, v.version);
    let text = ex && ex.method !== 'none' ? ex.text : '';
    if (!text) {
      const data = await readFile(drive.blobs.pathOf(v.blob_hash));
      if (!data.subarray(0, 8192).includes(0)) text = data.subarray(0, TEXT_PREVIEW * 4).toString('utf8');
    }
    res.json({ text: text.slice(0, TEXT_PREVIEW), truncated: text.length > TEXT_PREVIEW, method: ex?.method ?? null });
  });

  const act = (action: (body: Record<string, unknown>) => HeldAction): RequestHandler => async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.item_ids) ? body.item_ids.map(String) : typeof body.item_id === 'string' ? [body.item_id] : [];
    try {
      const out = actOnHeld(drive, ids, action(body));
      for (const i of out.items) await sessions.syncVisibility(i.item_id);
      res.json({ ok: true, ...out });
    } catch (e) {
      if (e instanceof HeldError) res.status(409).json({ error: 'not_held', problems: e.problems });
      else res.status(400).json({ error: (e as Error).message });
    }
  };
  r.post('/api/app/held/release', owner, express.json(), act(() => ({ kind: 'release' })));
  r.post('/api/app/held/ring', owner, express.json(), act((b) => ({ kind: 'ring', ring: String(b.ring ?? '').replace(/^(?!ring:)/, 'ring:') })));
  r.post('/api/app/held/trash', owner, express.json(), act(() => ({ kind: 'trash' })));

  return r;
}
