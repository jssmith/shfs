// The HTTP server: OAuth (via the MCP SDK's router), MCP at /mcp, the upload
// API for devices, the owner's app and its API, and /healthz.
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from './context.js';
import { DriveOAuthProvider, SCOPES } from './auth/oauth.js';
import { COOKIE, createWebSession, endWebSession, ownerHasPassword, parseCookies, verifyDevice, verifyOwnerPassword, verifyWebSession } from './auth/owner.js';
import { buildMcpServer, VERSION } from './mcp/tools.js';
import { ingestUpload, type UploadFile } from './ingest/upload.js';
import { appRouter } from './app/routes.js';
import { esc } from './util/html.js';

interface TransportEntry { transport: StreamableHTTPServerTransport; grant_id: string; lastSeen: number }

export interface HttpServer {
  server: Server;
  provider: DriveOAuthProvider;
  close(): Promise<void>;
}

export function buildApp(ctx: Context): { app: express.Express; provider: DriveOAuthProvider; transports: Map<string, TransportEntry> } {
  const { config, drive } = ctx;
  const db = drive.db;
  const base = new URL(`${config.publicUrl}/`);
  const mcpUrl = new URL('/mcp', base);
  const provider = new DriveOAuthProvider(db, mcpUrl);
  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: VERSION, state: drive.currentState() });
  });

  // OAuth 2.1: AS metadata, PRM (path-specific), /authorize, /token, /register, /revoke.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: base,
      baseUrl: base,
      resourceServerUrl: mcpUrl,
      scopesSupported: SCOPES,
      resourceName: 'Agent Drive',
    }),
  );
  // The contract also names the root protected-resource metadata URL.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*').json({ resource: mcpUrl.href, authorization_servers: [base.href], scopes_supported: SCOPES, resource_name: 'Agent Drive' });
  });

  app.post('/oauth/consent', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
    const { req_id, password, action } = req.body as Record<string, string | undefined>;
    const signedIn = verifyWebSession(db, parseCookies(req.headers.cookie)[COOKIE]);
    try {
      if (action !== 'deny' && !signedIn) {
        if (!password || !ownerHasPassword(db) || !verifyOwnerPassword(db, password)) {
          res.status(401).type('html').send(`<!doctype html><meta charset="utf-8"><p>Wrong password. Go back and try again.</p>`);
          return;
        }
        const ws = createWebSession(db);
        res.cookie(COOKIE, ws.token, { httpOnly: true, sameSite: 'lax', secure: base.protocol === 'https:', maxAge: ws.maxAge * 1000, path: '/' });
      }
      const to = provider.approve(String(req_id ?? ''), action !== 'deny');
      drive.activity({ actor: 'person', op: action === 'deny' ? 'connection_denied' : 'connection_allowed' });
      res.redirect(302, to);
    } catch (e) {
      res.status(400).type('html').send(`<!doctype html><meta charset="utf-8"><p>${esc((e as Error).message)}</p>`);
    }
  });

  // ---------- MCP ----------
  const transports = new Map<string, TransportEntry>();
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl), expectedResource: mcpUrl });
  const mcpHandler = async (req: Request, res: Response) => {
    const grant_id = String((req.auth?.extra as { grant_id?: string } | undefined)?.grant_id ?? '');
    const sid = req.header('mcp-session-id');
    try {
      if (sid) {
        const entry = transports.get(sid);
        if (!entry || entry.grant_id !== grant_id) {
          res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
          return;
        }
        entry.lastSeen = Date.now();
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }
      if (req.method === 'POST' && isInitializeRequest(req.body)) {
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Plain JSON responses: Cloudflare quick tunnels do not carry SSE.
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            transports.set(id, { transport, grant_id, lastSeen: Date.now() });
          },
          onsessionclosed: (id) => {
            transports.delete(id);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        const server = buildMcpServer(ctx);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      // Some clients probe (e.g. server/discover) before initialize: answer as JSON-RPC so they fall back.
      const body = req.body as { id?: unknown; method?: unknown } | undefined;
      if (req.method === 'POST' && body && typeof body.method === 'string' && body.id !== undefined) {
        res.status(200).json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Method not found: ${body.method} (send initialize first)` } });
        return;
      }
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid MCP session; send initialize first' }, id: null });
    } catch (e) {
      console.error('mcp error', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
  app.post('/mcp', bearer, express.json({ limit: '8mb' }), mcpHandler);
  app.get('/mcp', bearer, mcpHandler);
  app.delete('/mcp', bearer, mcpHandler);
  // Clients rarely close transports and never reuse them across runs: drop
  // ones idle for 30 minutes. Drive sessions are unaffected (the id is in the arguments).
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, e] of transports) {
      if (e.lastSeen < cutoff) {
        transports.delete(id);
        void e.transport.close();
      }
    }
  }, 5 * 60 * 1000).unref();

  // ---------- upload (device keys) ----------
  const device = (req: Request, res: Response, next: NextFunction) => {
    const h = req.header('authorization') ?? '';
    const d = verifyDevice(db, h.startsWith('Bearer ') ? h.slice(7) : undefined);
    if (!d) {
      res.status(401).json({ error: 'invalid_token', message: 'upload needs a device key from `agent-drive device add`' });
      return;
    }
    res.locals.device = d;
    next();
  };
  app.head('/api/upload/blob/:hash', device, (req, res) => {
    const h = String(req.params.hash);
    res.status(/^[0-9a-f]{64}$/.test(h) && drive.blobs.has(h) ? 200 : 404).end();
  });
  app.put('/api/upload/blob', device, express.raw({ type: () => true, limit: '512mb' }), async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body)) {
      res.status(400).json({ error: 'expected a raw body' });
      return;
    }
    const hash = await drive.blobs.put(body);
    res.json({ hash, size: body.length });
  });
  app.post('/api/upload', device, express.json({ limit: '32mb' }), (req, res) => {
    const { files, labels } = req.body as { files?: UploadFile[]; labels?: string[] };
    if (!Array.isArray(files) || !files.length) {
      res.status(400).json({ error: 'files must be a non-empty list' });
      return;
    }
    try {
      const r = ingestUpload(drive, files, Array.isArray(labels) ? labels : [], `device ${res.locals.device.name}`);
      ctx.jobs.kick();
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: 'bad_upload', message: (e as Error).message });
    }
  });

  app.use(appRouter(ctx));
  return { app, provider, transports };
}

export async function startHttp(ctx: Context): Promise<HttpServer> {
  const { app, provider, transports } = buildApp(ctx);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(ctx.config.port, '127.0.0.1', resolve));
  return {
    server,
    provider,
    async close() {
      for (const e of transports.values()) await e.transport.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export { endWebSession };
