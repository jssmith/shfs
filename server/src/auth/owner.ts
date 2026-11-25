// The one owner: a password (scrypt hash), app sign-in cookies, and
// upload-only device keys.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { get, run, type DB } from '../store/db.js';
import { newId, newSecret, now, secretHash } from '../util/ids.js';

export const COOKIE = 'ad_owner';
const WEB_SESSION_TTL_S = 30 * 24 * 3600;

export function setOwnerPassword(db: DB, password: string): void {
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const stored = `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
  run(db, 'INSERT INTO owner_auth (id, password_hash, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at', stored, now());
  run(db, 'DELETE FROM web_sessions');
}

export function ownerHasPassword(db: DB): boolean {
  return !!get(db, 'SELECT 1 FROM owner_auth WHERE id = 1');
}

export function verifyOwnerPassword(db: DB, password: string): boolean {
  const row = get<{ password_hash: string }>(db, 'SELECT password_hash FROM owner_auth WHERE id = 1');
  if (!row) return false;
  const [, n, r, p, salt, hash] = row.password_hash.split('$');
  const want = Buffer.from(hash!, 'base64');
  const got = scryptSync(password, Buffer.from(salt!, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(want, got);
}

export function createWebSession(db: DB): { token: string; maxAge: number } {
  const token = newSecret('aw');
  run(db, 'INSERT INTO web_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)', secretHash(token), now(), Math.floor(Date.now() / 1000) + WEB_SESSION_TTL_S);
  return { token, maxAge: WEB_SESSION_TTL_S };
}

export function verifyWebSession(db: DB, token: string | undefined): boolean {
  if (!token) return false;
  const row = get<{ expires_at: number }>(db, 'SELECT expires_at FROM web_sessions WHERE token_hash = ?', secretHash(token));
  return !!row && row.expires_at > Date.now() / 1000;
}

export function endWebSession(db: DB, token: string | undefined): void {
  if (token) run(db, 'DELETE FROM web_sessions WHERE token_hash = ?', secretHash(token));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- devices ----------

export function addDevice(db: DB, name: string): { device_id: string; token: string } {
  const device_id = newId('dv');
  const token = newSecret('adk');
  run(db, "INSERT INTO devices (device_id, name, token_hash, scope, created_at) VALUES (?, ?, ?, 'upload', ?)", device_id, name, secretHash(token), now());
  return { device_id, token };
}

export function verifyDevice(db: DB, token: string | undefined): { device_id: string; name: string } | null {
  if (!token) return null;
  return get<{ device_id: string; name: string }>(db, 'SELECT device_id, name FROM devices WHERE token_hash = ? AND revoked_at IS NULL', secretHash(token)) ?? null;
}
