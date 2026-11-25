// A scripted MCP client on the official TypeScript SDK: connects over
// Streamable HTTP, signs in with OAuth (discovery, dynamic client registration,
// PKCE) without a person, lists the tools and calls them.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { login, type LoginMode, type Credentials } from './login.ts';

interface Stored { client?: OAuthClientInformationMixed; tokens?: OAuthTokens }

/** OAuth client state, in memory and optionally in a JSON file (test tokens only). */
export class HarnessAuthProvider implements OAuthClientProvider {
  private stored: Stored = {};
  private verifier = '';
  private expectedState = '';
  readonly events: string[] = [];
  private readonly redirectUri: string;
  private readonly mode: LoginMode;
  private readonly creds: Credentials;
  private readonly file: string | undefined;
  private readonly screenshot: string | undefined;
  pendingCode: string | undefined;

  constructor(o: { redirectUri: string; mode: LoginMode; creds: Credentials; file?: string; screenshot?: string }) {
    this.redirectUri = o.redirectUri; this.mode = o.mode; this.creds = o.creds; this.file = o.file; this.screenshot = o.screenshot;
    if (this.file) { try { this.stored = JSON.parse(readFileSync(this.file, 'utf8')); } catch { /* none yet */ } }
  }
  private persist() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.stored, null, 2), { mode: 0o600 });
  }
  get redirectUrl() { return this.redirectUri; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'agent-drive test harness',
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() { this.expectedState = randomBytes(16).toString('base64url'); return this.expectedState; }
  clientInformation() { return this.stored.client; }
  saveClientInformation(c: OAuthClientInformationMixed) { this.stored.client = c; this.events.push('registered'); this.persist(); }
  tokens() { return this.stored.tokens; }
  saveTokens(t: OAuthTokens) { this.stored.tokens = t; this.events.push('tokens'); this.persist(); }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier') {
    this.events.push(`invalidate:${scope}`);
    if (scope === 'all' || scope === 'client') delete this.stored.client;
    if (scope === 'all' || scope === 'tokens') delete this.stored.tokens;
    this.persist();
  }
  async redirectToAuthorization(authorizationUrl: URL) {
    this.events.push('authorize');
    if (authorizationUrl.searchParams.get('code_challenge_method') !== 'S256') throw new Error('client did not send PKCE S256');
    const cb = await login(this.mode, authorizationUrl.href, { ...this.creds, redirectUri: this.redirectUri, ...(this.screenshot ? { screenshot: this.screenshot } : {}) });
    const err = cb.searchParams.get('error');
    if (err) throw new Error(`authorization failed: ${err} ${cb.searchParams.get('error_description') ?? ''}`);
    if (cb.searchParams.get('state') !== this.expectedState) throw new Error('state mismatch on callback');
    this.pendingCode = cb.searchParams.get('code') ?? undefined;
    if (!this.pendingCode) throw new Error('no code on callback');
  }
}

export interface HarnessOptions {
  url: string;
  login?: LoginMode;
  creds?: Credentials;
  /** Never actually listened on: the login step stops at the redirect. */
  redirectUri?: string;
  tokenFile?: string;
  screenshot?: string;
  calls?: { name: string; args: Record<string, unknown> }[];
}

export interface HarnessReport {
  url: string;
  oauth: string[];
  transportSession: string | undefined;
  server: { name?: string; version?: string } | undefined;
  tools: { name: string; description?: string }[];
  calls: { name: string; ok: boolean; ms: number; result?: unknown; error?: string }[];
  timings: { connectMs: number };
}

export async function connect(o: HarnessOptions): Promise<{ client: Client; transport: StreamableHTTPClientTransport; provider: HarnessAuthProvider; connectMs: number }> {
  const provider = new HarnessAuthProvider({
    redirectUri: o.redirectUri ?? 'http://127.0.0.1:9399/callback',
    mode: o.login ?? 'form',
    creds: o.creds ?? { user: process.env.AGENT_DRIVE_TEST_USER ?? 'test', password: process.env.AGENT_DRIVE_TEST_PASSWORD ?? 'test-password' },
    ...(o.tokenFile ? { file: o.tokenFile } : {}),
    ...(o.screenshot ? { screenshot: o.screenshot } : {}),
  });
  const t0 = Date.now();
  const make = () => new StreamableHTTPClientTransport(new URL(o.url), { authProvider: provider });
  let client = new Client({ name: 'agent-drive-harness', version: '0.0.1' });
  let transport = make();
  try {
    await client.connect(transport);
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !provider.pendingCode) throw e;
    await transport.finishAuth(provider.pendingCode);
    provider.pendingCode = undefined;
    client = new Client({ name: 'agent-drive-harness', version: '0.0.1' });
    transport = make();
    await client.connect(transport);
  }
  return { client, transport, provider, connectMs: Date.now() - t0 };
}

export async function runHarness(o: HarnessOptions): Promise<HarnessReport> {
  const { client, transport, provider, connectMs } = await connect(o);
  try {
    const { tools } = await client.listTools();
    const calls: HarnessReport['calls'] = [];
    for (const c of o.calls ?? []) {
      const t = Date.now();
      try {
        const result = await client.callTool({ name: c.name, arguments: c.args });
        calls.push({ name: c.name, ok: !result.isError, ms: Date.now() - t, result: result.content });
      } catch (e) {
        calls.push({ name: c.name, ok: false, ms: Date.now() - t, error: String(e) });
      }
    }
    const info = client.getServerVersion();
    return {
      url: o.url,
      oauth: provider.events,
      transportSession: transport.sessionId,
      server: info ? { name: info.name, version: info.version } : undefined,
      tools: tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })),
      calls,
      timings: { connectMs },
    };
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close();
  }
}
