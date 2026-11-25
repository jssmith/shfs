// OAuth 2.1 authorization server for one owner, behind the MCP SDK's
// router (metadata, dynamic client registration, authorize, token, revoke).
// Authorization code with PKCE (S256, checked by the SDK), opaque access
// tokens (1 hour) and rotating refresh tokens. A grant is a connection: the
// sessions an agent app starts are bound to it and survive token refresh.
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { randomUUID } from 'node:crypto';
import { get, run, tx, type DB } from '../store/db.js';
import { newId, newSecret, now, secretHash } from '../util/ids.js';
import { COOKIE, parseCookies, verifyWebSession } from './owner.js';
import { esc } from '../util/html.js';

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 180 * 24 * 3600;
const CODE_TTL_S = 300;
const REQUEST_TTL_S = 900;
const REFRESH_GRACE_S = 120; // a refresh token just rotated still works briefly (client retries)
export const SCOPES = ['drive'];

const nowS = () => Math.floor(Date.now() / 1000);

class ClientsStore implements OAuthRegisteredClientsStore {
  constructor(private db: DB) {}
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const r = get<{ info: string }>(this.db, 'SELECT info FROM oauth_clients WHERE client_id = ?', clientId);
    return r ? (JSON.parse(r.info) as OAuthClientInformationFull) : undefined;
  }
  registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
    const full = { ...client, client_id: randomUUID(), client_id_issued_at: nowS() } as OAuthClientInformationFull;
    run(this.db, 'INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)', full.client_id, JSON.stringify(full), now());
    return full;
  }
}

export class DriveOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: ClientsStore;

  constructor(private db: DB, readonly resourceUrl: URL) {
    this.clientsStore = new ClientsStore(db);
  }

  private checkResource(resource: URL | undefined): void {
    if (!resource) return;
    if (resource.origin !== this.resourceUrl.origin) throw new InvalidTargetError(`unknown resource ${resource.href}`);
  }

  /** Show the owner's sign-in and consent page for this request. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    try {
      this.checkResource(params.resource);
    } catch {
      const u = new URL(params.redirectUri);
      u.searchParams.set('error', 'invalid_target');
      if (params.state) u.searchParams.set('state', params.state);
      res.redirect(302, u.href);
      return;
    }
    const req_id = newSecret('ar');
    run(
      this.db,
      'INSERT INTO oauth_requests (req_id, client_id, params, created_at) VALUES (?, ?, ?, ?)',
      req_id, client.client_id,
      JSON.stringify({ ...params, resource: params.resource?.href }),
      nowS(),
    );
    const signedIn = verifyWebSession(this.db, parseCookies(res.req.headers.cookie)[COOKIE]);
    res.status(200).type('html').set('Cache-Control', 'no-store').set('X-Frame-Options', 'DENY').send(consentPage(req_id, client, signedIn));
  }

  /** Called from POST /oauth/consent once the owner has signed in and allowed it. */
  approve(req_id: string, allow: boolean): string {
    return tx(this.db, () => {
      const r = get<{ client_id: string; params: string; created_at: number }>(this.db, 'SELECT client_id, params, created_at FROM oauth_requests WHERE req_id = ?', req_id);
      if (!r || r.created_at + REQUEST_TTL_S < nowS()) throw new Error('This sign-in request has expired. Start again from your app.');
      run(this.db, 'DELETE FROM oauth_requests WHERE req_id = ?', req_id);
      const p = JSON.parse(r.params) as { state?: string; scopes?: string[]; codeChallenge: string; redirectUri: string; resource?: string };
      const u = new URL(p.redirectUri);
      if (p.state !== undefined) u.searchParams.set('state', p.state);
      if (!allow) {
        u.searchParams.set('error', 'access_denied');
        return u.href;
      }
      const client = this.clientsStore.getClient(r.client_id);
      const grant_id = newId('cn');
      run(this.db, 'INSERT INTO oauth_grants (grant_id, client_id, client_name, created_at) VALUES (?, ?, ?, ?)', grant_id, r.client_id, client?.client_name ?? null, now());
      const code = newSecret('ac');
      run(
        this.db,
        'INSERT INTO oauth_codes (code_hash, client_id, grant_id, code_challenge, redirect_uri, resource, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        secretHash(code), r.client_id, grant_id, p.codeChallenge, p.redirectUri, p.resource ?? null, JSON.stringify(p.scopes?.length ? p.scopes : SCOPES), nowS() + CODE_TTL_S,
      );
      u.searchParams.set('code', code);
      return u.href;
    });
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const r = get<{ client_id: string; code_challenge: string }>(this.db, 'SELECT client_id, code_challenge FROM oauth_codes WHERE code_hash = ?', secretHash(code));
    if (!r || r.client_id !== client.client_id) throw new InvalidGrantError('unknown authorization code');
    return r.code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    // A code used twice: revoke what it issued (OAuth 2.1 §4.1.3). Outside the
    // transaction below, which rolls back when it throws.
    const used = get<{ grant_id: string; used: number }>(this.db, 'SELECT grant_id, used FROM oauth_codes WHERE code_hash = ?', secretHash(code));
    if (used?.used) {
      run(this.db, 'UPDATE oauth_tokens SET revoked = 1 WHERE grant_id = ?', used.grant_id);
      throw new InvalidGrantError('authorization code already used');
    }
    return tx(this.db, () => {
      const r = get<{ client_id: string; grant_id: string; redirect_uri: string; resource: string | null; scopes: string; expires_at: number; used: number }>(
        this.db, 'SELECT * FROM oauth_codes WHERE code_hash = ?', secretHash(code),
      );
      if (!r || r.client_id !== client.client_id) throw new InvalidGrantError('unknown authorization code');
      if (r.used) throw new InvalidGrantError('authorization code already used');
      if (r.expires_at < nowS()) throw new InvalidGrantError('authorization code expired');
      if (redirectUri !== undefined && redirectUri !== r.redirect_uri) throw new InvalidGrantError('redirect_uri does not match');
      this.checkResource(resource);
      run(this.db, 'UPDATE oauth_codes SET used = 1 WHERE code_hash = ?', secretHash(code));
      return this.issue(r.grant_id, client.client_id, JSON.parse(r.scopes) as string[]);
    });
  }

  private issue(grant_id: string, client_id: string, scopes: string[], accessTtl = ACCESS_TTL_S): OAuthTokens {
    const access = newSecret('ada');
    const refresh = newSecret('adr');
    const resource = this.resourceUrl.href;
    run(this.db, "INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, scopes, resource, expires_at) VALUES (?, 'access', ?, ?, ?, ?, ?)", secretHash(access), grant_id, client_id, JSON.stringify(scopes), resource, nowS() + accessTtl);
    run(this.db, "INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, scopes, resource, expires_at) VALUES (?, 'refresh', ?, ?, ?, ?, ?)", secretHash(refresh), grant_id, client_id, JSON.stringify(scopes), resource, nowS() + REFRESH_TTL_S);
    return { access_token: access, token_type: 'Bearer', expires_in: accessTtl, refresh_token: refresh, scope: scopes.join(' ') };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const old = get<{ grant_id: string; kind: string; replaced_at: number | null }>(this.db, 'SELECT grant_id, kind, replaced_at FROM oauth_tokens WHERE token_hash = ?', secretHash(refreshToken));
    if (old?.kind === 'refresh' && old.replaced_at !== null && old.replaced_at + REFRESH_GRACE_S < nowS()) {
      // Reuse of a rotated refresh token: treat the grant as compromised.
      run(this.db, 'UPDATE oauth_tokens SET revoked = 1 WHERE grant_id = ?', old.grant_id);
      throw new InvalidGrantError('refresh token already used');
    }
    return tx(this.db, () => {
      const r = get<{ grant_id: string; client_id: string; scopes: string; expires_at: number; replaced_at: number | null; revoked: number; kind: string }>(
        this.db, 'SELECT * FROM oauth_tokens WHERE token_hash = ?', secretHash(refreshToken),
      );
      if (!r || r.kind !== 'refresh' || r.client_id !== client.client_id || r.revoked) throw new InvalidGrantError('invalid refresh token');
      if (r.expires_at < nowS()) throw new InvalidGrantError('refresh token expired');
      if (r.replaced_at !== null && r.replaced_at + REFRESH_GRACE_S < nowS()) throw new InvalidGrantError('refresh token already used');
      const g = get<{ revoked_at: string | null }>(this.db, 'SELECT revoked_at FROM oauth_grants WHERE grant_id = ?', r.grant_id);
      if (!g || g.revoked_at) throw new InvalidGrantError('connection revoked');
      this.checkResource(resource);
      const granted = JSON.parse(r.scopes) as string[];
      const want = scopes?.length ? scopes.filter((s) => granted.includes(s)) : granted;
      if (r.replaced_at === null) run(this.db, 'UPDATE oauth_tokens SET replaced_at = ? WHERE token_hash = ?', nowS(), secretHash(refreshToken));
      return this.issue(r.grant_id, client.client_id, want);
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const r = get<{ kind: string; grant_id: string; client_id: string; scopes: string; resource: string | null; expires_at: number; revoked: number }>(
      this.db, 'SELECT * FROM oauth_tokens WHERE token_hash = ?', secretHash(token),
    );
    if (!r || r.kind !== 'access' || r.revoked) throw new InvalidTokenError('invalid access token');
    if (r.expires_at < nowS()) throw new InvalidTokenError('access token expired');
    const g = get<{ revoked_at: string | null; client_name: string | null }>(this.db, 'SELECT revoked_at, client_name FROM oauth_grants WHERE grant_id = ?', r.grant_id);
    if (!g || g.revoked_at) throw new InvalidTokenError('connection revoked');
    return {
      token,
      clientId: r.client_id,
      scopes: JSON.parse(r.scopes) as string[],
      expiresAt: r.expires_at,
      resource: new URL(r.resource ?? this.resourceUrl.href),
      extra: { grant_id: r.grant_id, client_name: g.client_name },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    run(this.db, 'UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ?', secretHash(request.token), client.client_id);
  }

  /** For test harnesses: a connection with a token issued directly, no browser. */
  directConnection(name: string, ttlS = 30 * 24 * 3600): { client_id: string; grant_id: string; tokens: OAuthTokens } {
    return tx(this.db, () => {
      const client = this.clientsStore.registerClient({ client_name: name, redirect_uris: [], token_endpoint_auth_method: 'none' } as never);
      const grant_id = newId('cn');
      run(this.db, 'INSERT INTO oauth_grants (grant_id, client_id, client_name, created_at) VALUES (?, ?, ?, ?)', grant_id, client.client_id, name, now());
      return { client_id: client.client_id, grant_id, tokens: this.issue(grant_id, client.client_id, SCOPES, ttlS) };
    });
  }
}

function consentPage(req_id: string, client: OAuthClientInformationFull, signedIn: boolean): string {
  const name = client.client_name ? `“${esc(client.client_name)}”` : 'An unnamed app';
  const uri = client.client_uri ? `<p class="m">Declared site: ${esc(client.client_uri)}</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Agent Drive</title><style>
body{font:16px/1.45 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fafafa}
h1{font-size:1.3rem}.m{color:#666;font-size:.9rem}input[type=password]{width:100%;padding:.5rem;font-size:1rem;box-sizing:border-box}
button{padding:.5rem 1rem;font-size:1rem;margin:.75rem .5rem 0 0}</style></head><body>
<h1>Connect an agent to your drive</h1>
<p>${name} (as it describes itself) asks to work in your drive: start sessions, run commands in a sandbox, read and write files that are not in a ring.</p>${uri}
<form method="post" action="/oauth/consent">
<input type="hidden" name="req_id" value="${esc(req_id)}">
${signedIn ? '<p class="m">You are signed in as the owner.</p>' : '<label>Owner password<br><input type="password" name="password" autocomplete="current-password" autofocus required></label>'}
<div><button name="action" value="allow" type="submit">Allow</button><button name="action" value="deny" type="submit" formnovalidate>Deny</button></div>
</form></body></html>`;
}
