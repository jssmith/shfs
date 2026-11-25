// The scripted MCP client against the stub: OAuth discovery, dynamic client
// registration, PKCE, token reuse, and tool calls. The browser case runs only
// where Playwright is installed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createStub } from '../stub/server.ts';
import { runHarness } from '../client/mcp-client.ts';
import { loadPlaywright, loginWithForm } from '../client/login.ts';

const PORT = Number(process.env.HARNESS_TEST_PORT ?? 9311);
const stub = createStub({ port: PORT, log: () => {} });
let base = '';
const dir = mkdtempSync(join(tmpdir(), 'a3-harness-'));

beforeAll(async () => { base = await stub.start(); });
afterAll(async () => { await stub.stop(); rmSync(dir, { recursive: true, force: true }); });

describe('stub MCP server with OAuth', () => {
  it('signs in non-interactively and calls echo', async () => {
    const r = await runHarness({ url: `${base}/mcp`, login: 'form', calls: [{ name: 'echo', args: { text: 'hello' } }] });
    expect(r.oauth).toEqual(['registered', 'authorize', 'tokens']);
    expect(r.tools.map((t) => t.name)).toContain('echo');
    expect(r.calls[0]).toMatchObject({ ok: true, result: [{ type: 'text', text: 'hello' }] });
    expect(r.transportSession).toBeTruthy();
  });

  it('answers an unauthenticated request with 401 and resource metadata', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(pr.authorization_servers).toEqual([base]);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.registration_endpoint).toBe(`${base}/register`);
  });

  it('rejects a wrong PKCE verifier', async () => {
    const redirect = 'http://127.0.0.1:9399/cb';
    const reg = await (await fetch(`${base}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
    })).json();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ client_id: reg.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's' }))
      auth.searchParams.set(k, v);
    const cb = await loginWithForm(auth.href, { user: 'test', password: 'test-password', redirectUri: redirect });
    const code = cb.searchParams.get('code')!;
    const token = (v: string) => fetch(`${base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: v, client_id: reg.client_id, redirect_uri: redirect }),
    });
    const bad = await token('not-the-verifier');
    expect(bad.status).toBe(400);
    // The code is single-use: even the right verifier fails after a failed attempt.
    expect((await token(verifier)).status).toBe(400);
  });

  it('refuses a wrong password', async () => {
    await expect(runHarness({ url: `${base}/mcp`, login: 'form', creds: { user: 'test', password: 'wrong' } })).rejects.toThrow(/sign-in failed/);
  });

  it('reuses stored tokens without signing in again', async () => {
    const tokenFile = join(dir, 'tokens.json');
    const first = await runHarness({ url: `${base}/mcp`, login: 'form', tokenFile });
    expect(first.oauth).toContain('authorize');
    const second = await runHarness({ url: `${base}/mcp`, login: 'form', tokenFile, calls: [{ name: 'whoami', args: {} }] });
    expect(second.oauth).toEqual([]);
    expect(second.calls[0]?.ok).toBe(true);
  });

  it.skipIf(!loadPlaywright())('signs in through headless Chromium', async () => {
    const r = await runHarness({ url: `${base}/mcp`, login: 'browser', calls: [{ name: 'echo', args: { text: 'browser' } }] });
    expect(r.oauth).toEqual(['registered', 'authorize', 'tokens']);
    expect(r.calls[0]?.ok).toBe(true);
  }, 60_000);
});
