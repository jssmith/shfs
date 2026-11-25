// A minimal MCP server with its own OAuth 2.1 authorization server, standing in
// for the drive until the real one exists. Same surface as contracts §4:
//   /mcp                                      Streamable HTTP, Bearer token required
//   /.well-known/oauth-protected-resource     RFC 9728 (also /…/mcp)
//   /.well-known/oauth-authorization-server   RFC 8414
//   /register  /authorize  /token             RFC 7591 dynamic registration, PKCE (S256 only)
//   /healthz
// One test user. Tools: echo, whoami. Everything is in memory.
// Every request is logged as one JSON line (method, path, MCP session id, auth),
// the shape of the instrumentation the real server keeps (wave 1).
//
//   node test/harness/stub/server.ts            (Node 22.18+ runs .ts directly)
// Env: STUB_PORT (9301), STUB_HOST (127.0.0.1), STUB_PUBLIC_URL (http://localhost:PORT),
//      STUB_USER (test), STUB_PASSWORD (test-password: a synthetic test credential).

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface StubOptions {
  port?: number;
  host?: string;
  publicUrl?: string;
  user?: string;
  password?: string;
  accessTokenTtlSeconds?: number;
  log?: (entry: Record<string, unknown>) => void;
}

interface Client {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  client_name?: string;
}
interface Code { clientId: string; redirectUri: string; challenge: string; expires: number; scope?: string; resource?: string }
interface Token { clientId: string; user: string; expires: number; scope?: string }

const b64url = (buf: Buffer) => buf.toString('base64url');
const rand = (n = 32) => b64url(randomBytes(n));
const sha256 = (s: string) => b64url(createHash('sha256').update(s).digest());

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'content-type': isText ? 'text/html; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function loginPage(params: URLSearchParams, error?: string): string {
  const hidden = [...params]
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in to Agent Drive (stub)</title></head>
<body><h1>Sign in</h1>${error ? `<p id="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/authorize">
${hidden}
<label>User <input name="username" autocomplete="username"></label>
<label>Password <input name="password" type="password" autocomplete="current-password"></label>
<button type="submit" id="approve">Sign in and allow</button>
</form></body></html>`;
}

export function createStub(opts: StubOptions = {}) {
  const port = opts.port ?? Number(process.env.STUB_PORT ?? 9301);
  const host = opts.host ?? process.env.STUB_HOST ?? '127.0.0.1';
  let publicUrl = (opts.publicUrl ?? process.env.STUB_PUBLIC_URL ?? '').replace(/\/$/, '');
  const user = opts.user ?? process.env.STUB_USER ?? 'test';
  const password = opts.password ?? process.env.STUB_PASSWORD ?? 'test-password';
  const ttl = opts.accessTokenTtlSeconds ?? 3600;
  const log = opts.log ?? ((e) => process.stdout.write(JSON.stringify(e) + '\n'));

  const clients = new Map<string, Client>();
  const codes = new Map<string, Code>();
  const tokens = new Map<string, Token>();
  const refreshTokens = new Map<string, Token>();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const stats = { registrations: 0, authorizations: 0, tokenGrants: 0, refreshes: 0, mcpRequests: 0, unauthorized: 0 };

  const base = () => publicUrl;
  const resourceUrl = () => `${base()}/mcp`;

  const asMetadata = () => ({
    issuer: base(),
    authorization_endpoint: `${base()}/authorize`,
    token_endpoint: `${base()}/token`,
    registration_endpoint: `${base()}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['drive'],
  });
  const prMetadata = () => ({
    resource: resourceUrl(),
    authorization_servers: [base()],
    bearer_methods_supported: ['header'],
    scopes_supported: ['drive'],
    resource_name: 'Agent Drive (stub)',
  });

  function newMcpServer(transportSession: () => string | undefined): McpServer {
    const server = new McpServer({ name: 'agent-drive-stub', version: '0.0.1' });
    server.registerTool(
      'echo',
      { description: 'Return the given text unchanged.', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    server.registerTool(
      'whoami',
      { description: 'Who the token belongs to, and the MCP transport session.', inputSchema: {} },
      async (_args, extra) => ({
        content: [{
          type: 'text',
          text: JSON.stringify({ user: extra.authInfo?.extra?.user ?? null, client_id: extra.authInfo?.clientId ?? null, transport_session: transportSession() ?? null }),
        }],
      }),
    );
    return server;
  }

  function clientAuth(req: IncomingMessage, form: URLSearchParams): Client | undefined {
    let id = form.get('client_id') ?? undefined;
    let secret = form.get('client_secret') ?? undefined;
    const h = req.headers.authorization;
    if (h?.startsWith('Basic ')) {
      const [i, s] = Buffer.from(h.slice(6), 'base64').toString().split(':');
      id = decodeURIComponent(i ?? ''); secret = decodeURIComponent(s ?? '');
    }
    const c = id ? clients.get(id) : undefined;
    if (!c) return undefined;
    if (c.token_endpoint_auth_method === 'none') return c;
    return secret && c.client_secret && safeEqual(secret, c.client_secret) ? c : undefined;
  }

  function issue(clientId: string, scope?: string) {
    const access = rand(), refresh = rand();
    const t: Token = { clientId, user, expires: Date.now() + ttl * 1000, scope };
    tokens.set(access, t);
    refreshTokens.set(refresh, { ...t, expires: Date.now() + 30 * 86400_000 });
    return { access_token: access, token_type: 'Bearer', expires_in: ttl, refresh_token: refresh, ...(scope ? { scope } : {}) };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://stub');
    const path = url.pathname;
    const entry: Record<string, unknown> = {
      t: new Date().toISOString(), method: req.method, path,
      mcp_session: req.headers['mcp-session-id'] ?? null, ua: req.headers['user-agent'] ?? null,
    };
    res.on('finish', () => { entry.status = res.statusCode; log(entry); });

    if (path === '/healthz') return send(res, 200, { ok: true });
    if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration')
      return send(res, 200, asMetadata());
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')
      return send(res, 200, prMetadata());

    if (path === '/register' && req.method === 'POST') {
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid_client_metadata' }); }
      const redirect_uris = meta.redirect_uris;
      if (!Array.isArray(redirect_uris) || redirect_uris.length === 0 || !redirect_uris.every((u) => typeof u === 'string'))
        return send(res, 400, { error: 'invalid_redirect_uri' });
      const method = typeof meta.token_endpoint_auth_method === 'string' ? meta.token_endpoint_auth_method : 'client_secret_basic';
      if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method))
        return send(res, 400, { error: 'invalid_client_metadata', error_description: 'unsupported token_endpoint_auth_method' });
      const c: Client = {
        client_id: randomUUID(), redirect_uris: redirect_uris as string[], token_endpoint_auth_method: method,
        ...(method !== 'none' ? { client_secret: rand() } : {}),
        ...(typeof meta.client_name === 'string' ? { client_name: meta.client_name } : {}),
      };
      clients.set(c.client_id, c);
      stats.registrations++;
      entry.client = c.client_name ?? c.client_id;
      return send(res, 201, {
        ...meta, ...c, client_id_issued_at: Math.floor(Date.now() / 1000),
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        ...(c.client_secret ? { client_secret_expires_at: 0 } : {}),
      });
    }

    if (path === '/authorize') {
      const params = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : url.searchParams;
      const c = clients.get(params.get('client_id') ?? '');
      const redirectUri = params.get('redirect_uri') ?? '';
      if (!c) return send(res, 400, loginPage(new URLSearchParams(), 'unknown client_id'));
      if (!c.redirect_uris.includes(redirectUri)) return send(res, 400, loginPage(new URLSearchParams(), 'redirect_uri not registered'));
      const back = (q: Record<string, string>) => {
        const u = new URL(redirectUri);
        for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
        const state = params.get('state'); if (state) u.searchParams.set('state', state);
        u.searchParams.set('iss', base());
        res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' }); res.end();
      };
      if (params.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' });
      if (params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge'))
        return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
      if (req.method !== 'POST') {
        const keep = new URLSearchParams();
        for (const k of ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'])
          { const v = params.get(k); if (v !== null) keep.set(k, v); }
        return send(res, 200, loginPage(keep));
      }
      const u = params.get('username') ?? '', p = params.get('password') ?? '';
      if (!(safeEqual(u, user) && safeEqual(p, password))) {
        params.delete('username'); params.delete('password');
        return send(res, 401, loginPage(params, 'wrong user or password'));
      }
      const code = rand();
      codes.set(code, {
        clientId: c.client_id, redirectUri, challenge: params.get('code_challenge')!, expires: Date.now() + 60_000,
        ...(params.get('scope') ? { scope: params.get('scope')! } : {}),
        ...(params.get('resource') ? { resource: params.get('resource')! } : {}),
      });
      stats.authorizations++;
      entry.client = c.client_name ?? c.client_id;
      return back({ code });
    }

    if (path === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const c = clientAuth(req, form);
      if (!c) return send(res, 401, { error: 'invalid_client' });
      const grant = form.get('grant_type');
      entry.grant = grant;
      if (grant === 'authorization_code') {
        const code = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!code || code.expires < Date.now() || code.clientId !== c.client_id) return send(res, 400, { error: 'invalid_grant' });
        if (form.get('redirect_uri') && form.get('redirect_uri') !== code.redirectUri) return send(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        const verifier = form.get('code_verifier') ?? '';
        if (!verifier || sha256(verifier) !== code.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        stats.tokenGrants++;
        return send(res, 200, issue(c.client_id, code.scope));
      }
      if (grant === 'refresh_token') {
        const rt = form.get('refresh_token') ?? '';
        const t = refreshTokens.get(rt);
        if (!t || t.clientId !== c.client_id || t.expires < Date.now()) return send(res, 400, { error: 'invalid_grant' });
        refreshTokens.delete(rt); // rotate
        stats.refreshes++;
        return send(res, 200, issue(c.client_id, t.scope));
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    if (path === '/mcp') {
      stats.mcpRequests++;
      const h = req.headers.authorization ?? '';
      const t = h.startsWith('Bearer ') ? tokens.get(h.slice(7)) : undefined;
      if (!t || t.expires < Date.now()) {
        stats.unauthorized++;
        entry.auth = h ? 'invalid' : 'missing';
        return send(res, 401, { error: 'invalid_token' }, {
          'www-authenticate': `Bearer error="invalid_token", resource_metadata="${base()}/.well-known/oauth-protected-resource"`,
        });
      }
      entry.auth = 'ok';
      (req as IncomingMessage & { auth?: unknown }).auth = {
        token: h.slice(7), clientId: t.clientId, scopes: t.scope ? t.scope.split(' ') : [], expiresAt: Math.floor(t.expires / 1000), extra: { user: t.user },
      };
      const sid = req.headers['mcp-session-id'];
      let body: unknown;
      if (req.method === 'POST') {
        try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'parse error' }); }
        entry.rpc = Array.isArray(body) ? body.map((m) => m?.method) : (body as { method?: string })?.method;
        const params = (body as { params?: { name?: string } })?.params;
        if (params?.name) entry.tool = params.name;
      }
      let transport = typeof sid === 'string' ? transports.get(sid) : undefined;
      if (!transport) {
        if (typeof sid === 'string') return send(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        if (req.method !== 'POST' || !isInitializeRequest(body)) return send(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'No session' }, id: null });
        const tr: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports.set(id, tr); },
        });
        tr.onclose = () => { if (tr.sessionId) transports.delete(tr.sessionId); };
        await newMcpServer(() => tr.sessionId).connect(tr);
        transport = tr;
      }
      return transport.handleRequest(req, res, body);
    }

    return send(res, 404, { error: 'not found' });
  }

  const http: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { error: 'server_error', error_description: String(err) });
      else res.end();
    });
  });

  return {
    stats,
    get url() { return base(); },
    async start(): Promise<string> {
      await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, host, resolve); });
      const addr = http.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      if (!publicUrl) publicUrl = `http://localhost:${actual}`;
      return base();
    },
    async stop(): Promise<void> {
      for (const t of transports.values()) await t.close().catch(() => {});
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stub = createStub();
  const url = await stub.start();
  process.stderr.write(`agent-drive stub MCP server at ${url}/mcp\n`);
  const stop = () => { stub.stop().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
