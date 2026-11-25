// The owner's one-page app and its API, behind a cookie sign-in.
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { Context } from '../context.js';
import { all, get } from '../store/db.js';
import type { Op } from '../store/drive.js';
import { COOKIE, createWebSession, endWebSession, ownerHasPassword, parseCookies, verifyOwnerPassword, verifyWebSession } from '../auth/owner.js';
import { trashItem, undoPackage } from '../merge/undo.js';
import { APP_HTML, loginPage } from './page.js';

export function appRouter(ctx: Context): Router {
  const r = express.Router();
  const { drive, sessions } = ctx;
  const db = drive.db;
  const secure = ctx.config.publicUrl.startsWith('https:');

  const isOwner = (req: Request) => verifyWebSession(db, parseCookies(req.headers.cookie)[COOKIE]);
  const owner = (req: Request, res: Response, next: NextFunction) => {
    if (!isOwner(req)) {
      res.status(401).json({ error: 'sign_in_required' });
      return;
    }
    // State-changing calls must come from the app's own script (with SameSite=Lax this blocks cross-site forms).
    if (req.method !== 'GET' && req.header('x-drive-app') !== '1') {
      res.status(403).json({ error: 'missing X-Drive-App header' });
      return;
    }
    next();
  };

  r.get('/login', (_req, res) => {
    res.type('html').send(loginPage(ownerHasPassword(db) ? '' : 'No owner password is set. Run: agent-drive owner set-password'));
  });
  r.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const pw = String((req.body as Record<string, unknown>).password ?? '');
    if (!ownerHasPassword(db) || !verifyOwnerPassword(db, pw)) {
      res.status(401).type('html').send(loginPage('Wrong password.'));
      return;
    }
    const ws = createWebSession(db);
    res.cookie(COOKIE, ws.token, { httpOnly: true, sameSite: 'lax', secure, maxAge: ws.maxAge * 1000, path: '/' });
    res.redirect(303, '/');
  });
  r.post('/logout', (req, res) => {
    endWebSession(db, parseCookies(req.headers.cookie)[COOKIE]);
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(303, '/login');
  });

  r.get('/', (req, res) => {
    if (!isOwner(req)) {
      res.redirect(303, '/login');
      return;
    }
    res.type('html').set('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'").send(APP_HTML);
  });

  function pathOf(item_id: string): string {
    return drive.item(item_id)?.path ?? item_id;
  }

  function describePackage(p: { pkg_id: string; kind: string; summary_claimed: string | null; summary_observed: string | null; operations: string; created_at: string }) {
    const ops = JSON.parse(p.operations) as Op[];
    const undoneBy = get<{ pkg_id: string }>(db, "SELECT pkg_id FROM packages WHERE kind = 'undo' AND summary_observed = ?", `undo of ${p.pkg_id}`)?.pkg_id ?? null;
    return {
      pkg_id: p.pkg_id,
      kind: p.kind,
      created_at: p.created_at,
      summary_claimed: p.summary_claimed,
      summary_observed: p.summary_observed,
      undone_by: undoneBy,
      operations: ops.map((o) => ({ op: o.op, item_id: o.item_id, path: o.path ?? pathOf(o.item_id), ...(o.from_path ? { from_path: o.from_path } : {}) })),
    };
  }

  r.get('/api/app/sessions', owner, (_req, res) => {
    const rows = all<{ dir_id: string; session_id_hash: string; purpose: string; status: string; created_at: string; last_call_at: string; client_name: string | null; client_version: string | null; registered_name: string | null; summary_last: string | null }>(
      db,
      `SELECT s.dir_id, s.session_id_hash, s.purpose, s.status, s.created_at, s.last_call_at, m.client_name, m.client_version, m.registered_name, m.summary_last
         FROM sessions s LEFT JOIN session_meta m ON m.dir_id = s.dir_id ORDER BY s.created_at DESC, s.rowid DESC LIMIT 100`,
    );
    res.json({
      sessions: rows.map((s) => ({
        dir_id: s.dir_id,
        purpose: s.purpose,
        status: s.status,
        created_at: s.created_at,
        last_call_at: s.last_call_at,
        agent: { declared_name: s.client_name, declared_version: s.client_version, registered_name: s.registered_name },
        summary_claimed: s.summary_last,
        activity: all<{ ts: string; op: string; item_id: string | null; bytes_returned: number | null; detail: string | null }>(
          db, "SELECT ts, op, item_id, bytes_returned, detail FROM activity WHERE dir_id = ? AND op IN ('read','write','run','search','resume_session','transport_changed') ORDER BY id DESC LIMIT 100", s.dir_id,
        ).map((a) => ({ ...a, detail: a.detail ? JSON.parse(a.detail) : null })),
        merges: all<{ pkg_id: string; kind: string; summary_claimed: string | null; summary_observed: string | null; operations: string; created_at: string }>(
          db, 'SELECT * FROM packages WHERE session_id_hash = ? ORDER BY rowid DESC', s.session_id_hash,
        ).map(describePackage),
      })),
    });
  });

  r.get('/api/app/items', owner, (_req, res) => {
    const reach = new Set(drive.reachableView().map((v) => v.item_id));
    const items = all<{ item_id: string; path: string; state: string; current_version: number }>(db, "SELECT item_id, path, state, current_version FROM items WHERE state IN ('live','trashed') ORDER BY path LIMIT 2000").map((i) => ({
      ...i,
      reachable: reach.has(i.item_id),
      hidden_by: i.state === 'live' && !reach.has(i.item_id) ? drive.hidingRings(i.item_id) : [],
    }));
    const uploads = all<{ pkg_id: string; kind: string; summary_claimed: string | null; summary_observed: string | null; operations: string; created_at: string }>(
      db, "SELECT * FROM packages WHERE kind IN ('upload','person','undo') ORDER BY rowid DESC LIMIT 30",
    ).map(describePackage);
    res.json({ items, packages: uploads });
  });

  r.post('/api/app/undo', owner, express.json(), async (req, res) => {
    const { pkg_id, force } = req.body as { pkg_id?: string; force?: string[] };
    if (!pkg_id || !drive.pkg(pkg_id)) {
      res.status(404).json({ error: 'no such package' });
      return;
    }
    const touched = new Set((JSON.parse(drive.pkg(pkg_id)!.operations) as Op[]).map((o) => o.item_id));
    const u = undoPackage(drive, pkg_id, { force: Array.isArray(force) ? force : [] });
    for (const id of touched) await sessions.applyVisibility(id);
    ctx.jobs.kick();
    res.json(u);
  });

  r.post('/api/app/trash', owner, express.json(), async (req, res) => {
    const { item_id } = req.body as { item_id?: string };
    try {
      const t = trashItem(drive, String(item_id));
      await sessions.applyVisibility(String(item_id));
      res.json(t);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.get('/api/debug/calls', owner, (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 5000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (req.query.grant) {
      where.push('grant_id = ?');
      params.push(String(req.query.grant));
    }
    if (req.query.tool) {
      where.push('tool = ?');
      params.push(String(req.query.tool));
    }
    const calls = all(db, `SELECT * FROM calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params, limit);
    const byClient = all(
      db,
      `SELECT registered_name, client_name, client_version, COUNT(*) AS calls, COUNT(DISTINCT transport_session_id) AS transports, SUM(session_arg = 'matched') AS matched,
              SUM(session_arg IN ('none','unknown','malformed','other_connection')) AS not_matched, SUM(transport_changed) AS transport_changes,
              MAX(gap_session_ms) AS max_gap_session_ms FROM calls GROUP BY registered_name, client_name, client_version`,
    );
    res.json({ summary: byClient, calls });
  });

  return r;
}
