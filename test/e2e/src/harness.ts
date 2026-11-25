// End-to-end harness: a drive on a test port with a temporary data
// directory, a device key, an owner password, and an MCP client that signs
// in through the drive's OAuth flow programmatically (no browser).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createContext, type Context } from '../../../server/src/context.js';
import { startHttp, type HttpServer } from '../../../server/src/http.js';
import { addDevice, setOwnerPassword } from '../../../server/src/auth/owner.js';

export const PASSWORD = 'synthetic-owner-password';

export interface Drive {
  url: string;
  ctx: Context;
  http: HttpServer;
  dataDir: string;
  deviceToken: string;
  close(): Promise<void>;
}

export const RUNSC = process.env.AGENT_DRIVE_RUNSC;
export const ROOTFS = process.env.AGENT_DRIVE_ROOTFS;

export async function startDrive(port: number): Promise<Drive> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'a4-e2e-'));
  const url = `http://127.0.0.1:${port}`;
  const ctx = createContext({
    dataDir,
    port,
    publicUrl: url,
    runsc: RUNSC ?? null,
    runscRoot: path.join('/run', `a4-e2e-${port}`),
    rootfs: ROOTFS ?? '',
    sandboxPrefix: `a4-e2e${port}-`,
  });
  setOwnerPassword(ctx.drive.db, PASSWORD);
  const deviceToken = addDevice(ctx.drive.db, 'test laptop').token;
  ctx.jobs.start(200);
  const http = await startHttp(ctx);
  return {
    url,
    ctx,
    http,
    dataDir,
    deviceToken,
    async close() {
      await http.close();
      await ctx.close();
      rmSync(dataDir, { recursive: true, force: true });
      // runsc keeps a bind-mounted empty network namespace in its state root; release it.
      const netns = path.join(ctx.config.runscRoot, 'null-netns');
      if (existsSync(netns)) spawnSync('umount', [netns]);
      rmSync(ctx.config.runscRoot, { recursive: true, force: true });
    },
  };
}

class TestAuthProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  toks?: OAuthTokens;
  verifier = '';
  authUrl?: URL;
  readonly redirectUrl = 'http://127.0.0.1:1/callback';
  constructor(readonly name: string) {}
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: this.name, redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.toks;
  }
  saveTokens(t: OAuthTokens) {
    this.toks = t;
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** What a browser would do: open the authorize URL, sign in as the owner, allow, follow the redirect. */
export async function ownerApproves(authUrl: URL, password = PASSWORD): Promise<string> {
  const page = await fetch(authUrl, { redirect: 'manual' });
  const html = await page.text();
  const reqId = /name="req_id" value="([^"]+)"/.exec(html)?.[1];
  if (!reqId) throw new Error(`no consent form: ${page.status} ${html.slice(0, 300)}`);
  const consent = await fetch(new URL('/oauth/consent', authUrl), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ req_id: reqId, password, action: 'allow' }),
  });
  const loc = consent.headers.get('location');
  if (consent.status !== 302 || !loc) throw new Error(`consent failed: ${consent.status} ${await consent.text()}`);
  const code = new URL(loc).searchParams.get('code');
  if (!code) throw new Error(`no code in redirect: ${loc}`);
  return code;
}

export interface Agent {
  client: Client;
  auth: TestAuthProvider;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; structured: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function connectAgent(baseUrl: string, name = 'e2e-agent', auth = new TestAuthProvider(name)): Promise<Agent> {
  const mcpUrl = new URL('/mcp', baseUrl);
  let client = new Client({ name, version: '1.2.3' });
  let transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: auth });
  try {
    await client.connect(transport);
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !auth.authUrl) throw e;
    const code = await ownerApproves(auth.authUrl);
    await transport.finishAuth(code);
    client = new Client({ name, version: '1.2.3' });
    transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: auth });
    await client.connect(transport);
  }
  return {
    client,
    auth,
    async call(tool, args) {
      const r = (await client.callTool({ name: tool, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
      return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: !!r.isError, structured: r.structuredContent ?? {} };
    },
    async close() {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    },
  };
}
