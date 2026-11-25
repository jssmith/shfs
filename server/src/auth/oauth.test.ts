import { afterAll, beforeAll, expect, test } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { startHttp, type HttpServer } from '../http.js';
import { tempContext } from '../testing.js';
import { setOwnerPassword } from './owner.js';

const PORT = 9421;
const BASE = `http://127.0.0.1:${PORT}`;
let ctx: ReturnType<typeof tempContext>;
let http: HttpServer;

beforeAll(async () => {
  ctx = tempContext();
  ctx.config.port = PORT;
  ctx.config.publicUrl = BASE;
  setOwnerPassword(ctx.drive.db, 'synthetic-password');
  http = await startHttp(ctx);
});
afterAll(async () => {
  await http.close();
  await ctx.dispose();
});

const b64url = (b: Buffer) => b.toString('base64url');
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o), redirect: 'manual' as const });

async function register(): Promise<string> {
  const r = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'oauth-test', redirect_uris: ['http://127.0.0.1:1/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

async function authorize(client_id: string, verifier: string, extra: Record<string, string> = {}): Promise<string> {
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const u = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries({ client_id, response_type: 'code', redirect_uri: 'http://127.0.0.1:1/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${BASE}/mcp`, ...extra })) u.searchParams.set(k, v);
  const page = await (await fetch(u)).text();
  const req_id = /name="req_id" value="([^"]+)"/.exec(page)![1]!;
  const c = await fetch(`${BASE}/oauth/consent`, form({ req_id, password: 'synthetic-password', action: 'allow' }));
  expect(c.status).toBe(302);
  const loc = new URL(c.headers.get('location')!);
  expect(loc.searchParams.get('state')).toBe('xyz');
  return loc.searchParams.get('code')!;
}

async function token(o: Record<string, string>) {
  const r = await fetch(`${BASE}/token`, form(o));
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

test('metadata follows RFC 8414 and RFC 9728', async () => {
  const as = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  expect(as.code_challenge_methods_supported).toEqual(['S256']);
  expect(as.registration_endpoint).toBe(`${BASE}/register`);
  const prm = (await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
  expect(prm.resource).toBe(`${BASE}/mcp`);
  expect(prm.authorization_servers).toEqual([`${BASE}/`]);
});

test('authorization code with PKCE; wrong verifier and reuse are refused; refresh rotates', async () => {
  const client_id = await register();
  const verifier = b64url(randomBytes(32));
  const code = await authorize(client_id, verifier);
  const bad = await token({ grant_type: 'authorization_code', client_id, code, code_verifier: b64url(randomBytes(32)), redirect_uri: 'http://127.0.0.1:1/cb' });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toBe('invalid_grant');

  const code2 = await authorize(client_id, verifier);
  const ok = await token({ grant_type: 'authorization_code', client_id, code: code2, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:1/cb', resource: `${BASE}/mcp` });
  expect(ok.status).toBe(200);
  expect(ok.body.token_type).toBe('Bearer');
  const again = await token({ grant_type: 'authorization_code', client_id, code: code2, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:1/cb' });
  expect(again.status).toBe(400);
  // Reusing the code revoked what it issued.
  const mcp = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${ok.body.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  expect(mcp.status).toBe(401);

  const code3 = await authorize(client_id, verifier);
  const t3 = await token({ grant_type: 'authorization_code', client_id, code: code3, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:1/cb' });
  const r1 = await token({ grant_type: 'refresh_token', client_id, refresh_token: t3.body.refresh_token! });
  expect(r1.status).toBe(200);
  expect(r1.body.refresh_token).not.toBe(t3.body.refresh_token);
  const info1 = await http.provider.verifyAccessToken(t3.body.access_token!);
  const info2 = await http.provider.verifyAccessToken(r1.body.access_token!);
  expect(info2.extra?.grant_id).toBe(info1.extra?.grant_id); // sessions survive refresh
});

test('a resource on another origin is refused; deny returns access_denied', async () => {
  const client_id = await register();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const u = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries({ client_id, response_type: 'code', redirect_uri: 'http://127.0.0.1:1/cb', code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://elsewhere.example/mcp' })) u.searchParams.set(k, v);
  const r = await fetch(u, { redirect: 'manual' });
  expect(new URL(r.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');

  u.searchParams.delete('resource');
  const page = await (await fetch(u)).text();
  const req_id = /name="req_id" value="([^"]+)"/.exec(page)![1]!;
  const wrong = await fetch(`${BASE}/oauth/consent`, form({ req_id, password: 'not-it', action: 'allow' }));
  expect(wrong.status).toBe(401);
  const deny = await fetch(`${BASE}/oauth/consent`, form({ req_id, action: 'deny' }));
  expect(new URL(deny.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
});
