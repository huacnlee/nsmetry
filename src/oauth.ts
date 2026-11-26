/**
 * OAuth 2.1 for AI agents, so they can read the analytics over MCP.
 *
 * This Worker is both the authorization server and the protected resource,
 * following the MCP authorization spec (2025-06-18):
 *
 *   /.well-known/oauth-protected-resource[/mcp]  RFC 9728: names /mcp and this server
 *   /.well-known/oauth-authorization-server       RFC 8414: the endpoints below
 *   POST /oauth/register                           RFC 7591: public clients only
 *   GET|POST /oauth/authorize                      email code → consent → code (PKCE S256)
 *   POST /oauth/token                              authorization_code, refresh_token (rotating)
 *   POST /oauth/revoke                             RFC 7009
 *
 * Shaped by the free plan, where rows written per day are the scarce thing:
 *
 *  - Registration writes nothing. A client id *is* its registration — the
 *    name and redirect URIs, signed with an instance key — so the one public,
 *    unauthenticated endpoint cannot be used to fill the database or burn the
 *    write budget, and there is no clients table to sweep.
 *  - The authorize page carries its state in the form, not in a table: after
 *    the email code is checked, the consent form holds a short-lived signed
 *    ticket naming the user and binding every parameter of the request.
 *  - A grant is one row holding the hashes of its current access and refresh
 *    tokens. Issuing, refreshing and revoking are each one row write, and the
 *    grant id travels inside both tokens, so every lookup is by primary key.
 *
 * Tokens are only ever stored as SHA-256. Access tokens last an hour; refresh
 * tokens 90 days from their last use and rotate on every use. Everything an
 * agent holds dies with its grant: disconnecting it under Connected agents or
 * removing the user (users.ts deleteUser deletes the grants and codes) ends it
 * on the very next request. Codes and grants also carry the user's
 * token_version and are checked against it, so bumping that column would end
 * them all at once; nothing bumps it today, it is there for a future "sign out
 * every agent" control.
 */

import { Hono } from 'hono';

import {
  adminEmail,
  base64UrlDecode,
  base64UrlEncode,
  checkCode,
  clientKey,
  digestsMatch,
  hmacKey,
  randomHex,
  sha256Hex,
  startSignIn,
} from './auth';
import { getSetting } from './db';
import { consentPage, oauthErrorPage, signInPage } from './pages';
import { type UserRow, accessibleSites, getUserById, isOwner, withRole } from './users';

/* -------------------------------------------------------------- constants -- */

/** The one scope: read the analytics this user can see. Nothing here writes. */
export const SCOPE = 'read';
export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60;
export const CODE_TTL_SECONDS = 10 * 60;
/** Time between entering the email code and pressing Allow. */
const TICKET_TTL_SECONDS = 10 * 60;
/** A grant's last_used_at is rewritten at most this often, like sessions' last_seen. */
const USED_EVERY_SECONDS = 60 * 60;

const MAX_REDIRECT_URIS = 5;
const MAX_URI_LENGTH = 512;
const MAX_NAME_LENGTH = 100;

// Prefixed so a leaked token is recognisable (and catchable by secret
// scanners), and carrying the grant id so it is looked up by primary key.
const ACCESS_PATTERN = /^nsa_([0-9a-f]{16})_([0-9a-f]{64})$/;
const REFRESH_PATTERN = /^nsr_([0-9a-f]{16})_([0-9a-f]{64})$/;

const now = () => Math.floor(Date.now() / 1000);

/* ---------------------------------------------------------- instance key -- */

const SETTING_KEY = 'oauth_signing_key';

/**
 * The HMAC key that signs client ids and consent tickets.
 *
 * Generated on first use and kept in `settings` rather than asked of the
 * deployment as a secret: one fewer thing to set up, and the only cost of
 * losing it is that registered clients register again. INSERT OR IGNORE then
 * a re-read, so two first requests racing agree on one key. One row, written
 * once in the life of the instance.
 */
async function signingKey(db: D1Database): Promise<CryptoKey> {
  let secret = await getSetting(db, SETTING_KEY);
  if (!secret) {
    await db
      .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .bind(SETTING_KEY, randomHex(32))
      .run();
    secret = (await getSetting(db, SETTING_KEY)) ?? '';
  }
  return hmacKey(secret);
}

const encoder = new TextEncoder();

/**
 * `<payload>.<signature>`, base64url. `purpose` is mixed into the MAC so a
 * value signed as one thing (a ticket) can never be presented as another (a
 * client id).
 */
async function sign(db: D1Database, purpose: string, payload: unknown): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', await signingKey(db), encoder.encode(`${purpose}.${body}`));
  return `${body}.${base64UrlEncode(new Uint8Array(mac))}`;
}

async function unsign<T>(db: D1Database, purpose: string, value: string): Promise<T | null> {
  const dot = value.indexOf('.');
  if (dot <= 0 || value.length > 8192) return null;
  const body = value.slice(0, dot);
  const mac = base64UrlDecode(value.slice(dot + 1));
  if (!mac) return null;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(db),
    mac,
    encoder.encode(`${purpose}.${body}`),
  );
  if (!valid) return null;
  const bytes = base64UrlDecode(body);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- clients -- */

export interface Client {
  id: string;
  name: string;
  redirectUris: string[];
  issuedAt: number;
}

interface ClientPayload {
  n: string;
  r: string[];
  t: number;
}

const CLIENT_PREFIX = 'nsc1.';

/** The client a signed id describes, or null if it was not issued here. */
export async function verifyClientId(db: D1Database, id: unknown): Promise<Client | null> {
  if (typeof id !== 'string' || !id.startsWith(CLIENT_PREFIX)) return null;
  const payload = await unsign<ClientPayload>(db, 'client', id.slice(CLIENT_PREFIX.length));
  if (!payload || typeof payload.n !== 'string' || !Array.isArray(payload.r)) return null;
  return { id, name: payload.n, redirectUris: payload.r.map(String), issuedAt: Number(payload.t) || 0 };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Schemes a code must never be sent to. Anything that would run or read
 * something in the browser itself, or that is not a way back to an app.
 */
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'filesystem:',
  'ftp:',
  'ws:',
  'wss:',
  'mailto:',
  'tel:',
  'sms:',
]);

/**
 * Why a redirect URI cannot be registered, or null if it can.
 *
 * Allowed: https anywhere (Claude, ChatGPT and other hosted agents), http only
 * on loopback (Claude Code, the MCP Inspector and other local tools, RFC 8252
 * §7.3), and private-use URI schemes such as `cursor://…` (desktop apps, RFC
 * 8252 §7.1). This is an instance for one person and the people they invite,
 * not a platform, so there is no allow-list of agent vendors: what stops a
 * code going somewhere unwanted is the consent screen, which names the exact
 * host before anything is sent, and PKCE, which makes a code useless to anyone
 * but the client that started the flow.
 */
export function redirectUriProblem(uri: string): string | null {
  if (uri.length > MAX_URI_LENGTH) return 'redirect URI is too long';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'redirect URI is not a URL';
  }
  if (url.hash) return 'redirect URI must not have a fragment';
  if (url.username || url.password) return 'redirect URI must not carry credentials';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname) ? null : 'use https, or http only on localhost';
  }
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return `the ${url.protocol} scheme is not allowed`;
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) ? null : 'redirect URI has an invalid scheme';
}

/** What the consent screen shows as the destination. */
function redirectLabel(uri: string): string {
  const url = new URL(uri);
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.host;
  return url.host ? `${url.protocol}//${url.host}` : `${url.protocol}${url.pathname}`;
}

/**
 * The CSP source that lets the consent form's response redirect to `uri`.
 *
 * Browsers apply `form-action` to every redirect that follows a form
 * submission, not only to the form's own action — Chrome blocks a 302 to an
 * origin the policy does not list. So the consent page lists exactly the one
 * place this flow will redirect to (an https/http origin, or a private-use
 * scheme). The alternatives were worse: dropping `form-action` would let an
 * injected form post anywhere, and answering Allow with a page that links or
 * meta-refreshes onward breaks custom schemes in some browsers and needs a
 * second click. A 302 under an exact policy works everywhere.
 */
function formActionSource(uri: string): string {
  const url = new URL(uri);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : url.protocol;
}

/**
 * The headers on every page the authorize flow serves. No script at all,
 * styles only inline, no framing (the Allow button must not be clickjacked),
 * no referrer (the URL carries the OAuth request), never cached.
 */
function pageHeaders(redirectUri?: string): Record<string, string> {
  const formAction = redirectUri ? `'self' ${formActionSource(redirectUri)}` : "'self'";
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src 'self'",
      `form-action ${formAction}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

/* ---------------------------------------------------------------- tokens -- */

interface GrantRow {
  id: string;
  user_id: number;
  client_id: string;
  client_name: string;
  scope: string;
  token_version: number;
  access_hash: string;
  access_expires_at: number;
  refresh_hash: string;
  refresh_expires_at: number;
  created_at: number;
  last_used_at: number;
}

interface TokenPair {
  access: string;
  refresh: string;
  accessHash: string;
  refreshHash: string;
}

async function newTokens(grantId: string): Promise<TokenPair> {
  const access = `nsa_${grantId}_${randomHex(32)}`;
  const refresh = `nsr_${grantId}_${randomHex(32)}`;
  return { access, refresh, accessHash: await sha256Hex(access), refreshHash: await sha256Hex(refresh) };
}

function tokenResponse(pair: TokenPair): Record<string, unknown> {
  return {
    access_token: pair.access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: pair.refresh,
    scope: SCOPE,
  };
}

/** The account a grant acts for, if it still exists and still trusts the grant. */
async function grantUser(env: Env, grant: GrantRow): Promise<UserRow | null> {
  const row = await getUserById(env.DB, grant.user_id);
  if (!row || row.token_version !== grant.token_version) return null;
  return withRole(row, adminEmail(env));
}

/**
 * Resolve an MCP request's access token to its user, or null.
 *
 * Reads two rows (grant, user). Writes only `last_used_at`, at most once an
 * hour per grant, so an agent polling the realtime tool does not spend the
 * write budget on bookkeeping.
 */
export async function resolveAccessToken(
  env: Env,
  token: string,
  at = now(),
): Promise<{ user: UserRow; grantId: string } | null> {
  const match = ACCESS_PATTERN.exec(token);
  if (!match) return null;
  const grant = await env.DB.prepare('SELECT * FROM oauth_grants WHERE id = ?')
    .bind(match[1])
    .first<GrantRow>();
  if (!grant || grant.access_expires_at <= at) return null;
  if (!digestsMatch(await sha256Hex(token), grant.access_hash)) return null;

  const user = await grantUser(env, grant);
  if (!user) return null;

  if (at - grant.last_used_at >= USED_EVERY_SECONDS) {
    await env.DB.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').bind(at, grant.id).run();
  }
  return { user, grantId: grant.id };
}

/* ---------------------------------------------------------- grants (API) -- */

export interface PublicGrant {
  id: string;
  client_name: string;
  created_at: number;
  last_used_at: number;
}

/** GET /api/oauth/grants: the agents this user has connected. */
export async function listGrants(db: D1Database, userId: number): Promise<PublicGrant[]> {
  const { results } = await db
    .prepare(
      `SELECT id, client_name, created_at, last_used_at FROM oauth_grants
       WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<PublicGrant>();
  return results;
}

/** DELETE /api/oauth/grants/:id. Only the grant's own user can disconnect it. */
export async function deleteGrant(db: D1Database, userId: number, grantId: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM oauth_grants WHERE id = ? AND user_id = ?')
    .bind(grantId, userId)
    .run();
  return result.meta.changes > 0;
}

/* ------------------------------------------------------------- endpoints -- */

/**
 * CORS on everything an agent's browser-side code may call (metadata,
 * registration, token, revoke). Safe for the same reason as /api: nothing
 * here uses cookies, so another origin can do nothing it could not already do.
 */
export const OAUTH_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
};

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...OAUTH_CORS, ...headers },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status, NO_STORE);
}

export function originOf(request: Request): string {
  return new URL(request.url).origin;
}

/** The resource the access tokens are for (RFC 8707): the MCP endpoint. */
export function resourceFor(base: string): string {
  return `${base}/mcp`;
}

/** Path-inserted per RFC 9728 §3.1, which is what the 401 from /mcp points at. */
export function resourceMetadataUrl(base: string): string {
  return `${base}/.well-known/oauth-protected-resource/mcp`;
}

function protectedResourceMetadata(base: string) {
  return {
    resource: resourceFor(base),
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'NsMetry',
  };
}

function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * A `resource` parameter, if given, must name this server. Both the MCP URL
 * and the bare origin are accepted: clients differ on which they send, and
 * this server protects exactly one resource either way.
 */
function resourceOk(base: string, resource: string | undefined): boolean {
  if (!resource) return true;
  const trimmed = resource.replace(/\/+$/, '');
  return trimmed === resourceFor(base) || trimmed === base;
}

/** A request body as flat string fields: forms per the RFCs, JSON leniently. */
async function formFields(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  const out: Record<string, string> = {};
  try {
    if (type.includes('application/json')) {
      const body: unknown = await request.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
      }
    } else {
      // Decoded from bytes rather than with .text(), which workerd warns about
      // on a form content type (it cannot know the form is plain ASCII).
      const text = new TextDecoder().decode(await request.arrayBuffer());
      for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    }
  } catch {
    // A malformed body is an empty one; every caller rejects missing fields.
  }
  return out;
}

/** client_id from the body, or from HTTP Basic as some public clients send it. */
function clientIdFrom(request: Request, fields: Record<string, string>): string {
  if (fields.client_id) return fields.client_id;
  const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!basic) return '';
  try {
    return decodeURIComponent(atob(basic[1]!).split(':')[0] ?? '');
  } catch {
    return '';
  }
}

type OAuthEnv = { Bindings: Env };
export const oauthRoutes = new Hono<OAuthEnv>();

for (const path of [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/*',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/*',
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke',
]) {
  oauthRoutes.options(path, () => new Response(null, { status: 204, headers: OAUTH_CORS }));
}

/* ---- metadata -- */

// Both the bare and the path-inserted form: a client that read the 401 from
// /mcp asks for `/mcp` on the end, one that guessed asks for the bare path.
oauthRoutes.get('/.well-known/oauth-protected-resource', (c) =>
  json(protectedResourceMetadata(originOf(c.req.raw))),
);
oauthRoutes.get('/.well-known/oauth-protected-resource/*', (c) =>
  json(protectedResourceMetadata(originOf(c.req.raw))),
);
oauthRoutes.get('/.well-known/oauth-authorization-server', (c) =>
  json(authorizationServerMetadata(originOf(c.req.raw))),
);
oauthRoutes.get('/.well-known/oauth-authorization-server/*', (c) =>
  json(authorizationServerMetadata(originOf(c.req.raw))),
);

/* ---- registration (RFC 7591) -- */

/**
 * Register a public client. Writes nothing: the response's client_id is the
 * registration, signed. Anyone may call this — registering grants nothing by
 * itself; every client still needs a signed-in user to approve it.
 */
oauthRoutes.post('/oauth/register', async (c) => {
  const text = await c.req.text();
  if (text.length > 16 * 1024) return oauthError('invalid_client_metadata', 'registration is too large');
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return oauthError('invalid_client_metadata', 'send the registration as a JSON object');
  }

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return oauthError('invalid_redirect_uri', `give between 1 and ${MAX_REDIRECT_URIS} redirect_uris`);
  }
  for (const uri of uris) {
    const problem = typeof uri === 'string' ? redirectUriProblem(uri) : 'redirect URI must be a string';
    if (problem) return oauthError('invalid_redirect_uri', problem);
  }
  const redirectUris = [...new Set(uris as string[])];

  // Only the code flow exists here. Asking for implicit or client_credentials
  // is a client that will not work, better told now than at the token step.
  if (Array.isArray(body.grant_types) && !body.grant_types.includes('authorization_code')) {
    return oauthError('invalid_client_metadata', 'only authorization_code (with refresh_token) is supported');
  }
  if (Array.isArray(body.response_types) && body.response_types.some((t) => t !== 'code')) {
    return oauthError('invalid_client_metadata', 'only the code response type is supported');
  }

  // Self-asserted and shown on the consent screen next to the verified
  // redirect host, so it is trimmed of control characters and kept short.
  const rawName = typeof body.client_name === 'string' ? body.client_name : '';
  const name =
    rawName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH) ||
    redirectLabel(redirectUris[0]!);

  const issuedAt = now();
  const payload: ClientPayload = { n: name, r: redirectUris, t: issuedAt };
  const clientId = CLIENT_PREFIX + (await sign(c.env.DB, 'client', payload));

  // Whatever authentication method was asked for, this server only does
  // public clients with PKCE: RFC 7591 §3.2.1 lets the server substitute, and
  // the response says what the client must actually do.
  return json(
    {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    },
    201,
    NO_STORE,
  );
});

/* ---- authorize -- */

/** The parameters of an authorization request, echoed through every step. */
const REQUEST_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
] as const;

type AuthorizeRequest = Partial<Record<(typeof REQUEST_FIELDS)[number], string>>;

interface Ticket {
  /** user id */
  u: number;
  /**
   * The account's email and created_at. users.id is a plain INTEGER PRIMARY
   * KEY, so SQLite hands a deleted account's id to the next one created; the
   * id alone would let a removed viewer's saved consent page approve a grant
   * for whoever was invited after them. The ticket is stateless, so
   * deleteUser cannot void it: these two fields make it name the account.
   */
  m: string;
  c: number;
  /** the user's token_version when they signed in */
  v: number;
  /** hash of the request it was issued for */
  h: string;
  /** expires at */
  e: number;
}

function requestFieldsOf(source: Record<string, string>): AuthorizeRequest {
  const out: AuthorizeRequest = {};
  for (const name of REQUEST_FIELDS) {
    const value = source[name];
    if (value !== undefined && value !== '') out[name] = value.slice(0, 2048);
  }
  return out;
}

/** Binds a ticket to every parameter, so a ticket cannot be replayed against another client or redirect. */
function requestHash(request: AuthorizeRequest): Promise<string> {
  return sha256Hex(JSON.stringify(REQUEST_FIELDS.map((name) => request[name] ?? '')));
}

/** Send the browser back to the client with an error, per RFC 6749 §4.1.2.1. */
function redirectBack(base: string, redirectUri: string, params: Record<string, string>, state?: string): Response {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (state) url.searchParams.set('state', state);
  // RFC 9207: names the issuer, so a client talking to several servers can
  // tell which one this answer came from (mix-up defence).
  url.searchParams.set('iss', base);
  return new Response(null, { status: 302, headers: { location: url.toString(), 'cache-control': 'no-store' } });
}

const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

async function handleAuthorize(env: Env, request: Request): Promise<Response> {
  const base = originOf(request);
  const url = new URL(request.url);
  const posted = request.method === 'POST' ? await formFields(request) : {};
  // On a POST the form's own fields are the request; the query string is only
  // read on the first GET.
  const source = request.method === 'POST' ? posted : Object.fromEntries(url.searchParams);
  const req = requestFieldsOf(source);

  const errorPage = (message: string) =>
    new Response(oauthErrorPage(message), { status: 400, headers: pageHeaders() });

  // Until the client and its redirect URI are verified, errors are shown here:
  // redirecting to an unverified URI would make this an open redirector.
  const client = await verifyClientId(env.DB, req.client_id);
  if (!client) return errorPage('This app is not registered with this instance (unknown client_id).');
  if (!req.redirect_uri && client.redirectUris.length === 1) req.redirect_uri = client.redirectUris[0]!;
  const redirectUri = req.redirect_uri ?? '';
  if (!client.redirectUris.includes(redirectUri)) {
    return errorPage('The redirect_uri does not exactly match one the app registered.');
  }

  const back = (error: string, description: string) =>
    redirectBack(base, redirectUri, { error, error_description: description }, req.state);

  if (req.response_type !== 'code') return back('unsupported_response_type', 'only response_type=code is supported');
  if (req.code_challenge_method !== 'S256' || !CODE_CHALLENGE_PATTERN.test(req.code_challenge ?? '')) {
    return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  if (!resourceOk(base, req.resource)) return back('invalid_target', 'resource must be this server\'s /mcp');

  const fields: Record<string, string> = Object.fromEntries(
    Object.entries(req).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const action = '/oauth/authorize';
  const intro = `${client.name} (returns to ${redirectLabel(redirectUri)}) is asking to read your analytics.`;
  const page = (html: string, status = 200) =>
    new Response(html, { status, headers: pageHeaders() });

  const step = request.method === 'POST' ? posted.step : undefined;

  if (step === 'email') {
    const result = await startSignIn(env, posted.email, clientKey(request));
    if (result.status !== 200 || !('ok' in result.body)) {
      const error = 'error' in result.body ? result.body.error : 'could not send a code';
      return page(signInPage({ action, step: 'email', email: posted.email, error, fields, intro }), result.status);
    }
    return page(
      signInPage({
        action,
        step: 'code',
        email: posted.email,
        // With no mail transport configured the code is in the Worker logs,
        // and the page must say so or the administrator waits for nothing.
        ...(result.body.message ? { notice: result.body.message } : {}),
        fields,
        intro,
      }),
    );
  }

  if (step === 'code') {
    const checked = await checkCode(env, posted.email, posted.code, clientKey(request));
    if (!('user' in checked)) {
      return page(
        signInPage({ action, step: 'code', email: posted.email, error: checked.error, fields, intro }),
        checked.status,
      );
    }
    return consent(env, checked.user, client, redirectUri, req, fields);
  }

  if (step === 'consent') {
    const ticket = await unsign<Ticket>(env.DB, 'ticket', posted.ticket ?? '');
    // A missing, forged, stale or mismatched ticket starts the sign-in over
    // rather than erroring: it is what a back button or a slow afternoon
    // produces, and the only way past it is the email code again.
    const fresh =
      ticket !== null &&
      ticket.e > now() &&
      digestsMatch(ticket.h, await requestHash(req));
    const row = fresh ? await getUserById(env.DB, ticket.u) : null;
    if (
      !fresh ||
      !row ||
      row.email !== ticket.m ||
      row.created_at !== ticket.c ||
      row.token_version !== ticket.v
    ) {
      return page(
        signInPage({ action, step: 'email', error: 'That took too long; sign in again.', fields, intro }),
        400,
      );
    }

    if (posted.decision !== 'approve') return back('access_denied', 'the user denied the request');

    const code = randomHex(32);
    const at = now();
    await env.DB.batch([
      // Expired codes are swept here, the only place they are created, so the
      // table needs no cron job and stays a handful of rows.
      env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').bind(at),
      env.DB.prepare(
        `INSERT INTO oauth_codes (code_hash, client_id, client_name, redirect_uri, user_id, token_version,
                                  code_challenge, scope, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        await sha256Hex(code),
        client.id,
        client.name,
        redirectUri,
        row.id,
        row.token_version,
        req.code_challenge!,
        SCOPE,
        at + CODE_TTL_SECONDS,
      ),
    ]);
    return redirectBack(base, redirectUri, { code }, req.state);
  }

  return page(signInPage({ action, step: 'email', fields, intro }));
}

/**
 * The consent screen, reached only by proving the emailed code. The ticket in
 * it is the CSRF defence: no cookie means no ambient authority to ride, and
 * the only way to get a ticket is to sign in on this very page, so a form on
 * another site cannot approve anything on someone's behalf.
 */
async function consent(
  env: Env,
  user: UserRow,
  client: Client,
  redirectUri: string,
  req: AuthorizeRequest,
  fields: Record<string, string>,
): Promise<Response> {
  const ticket: Ticket = {
    u: user.id,
    m: user.email,
    c: user.created_at,
    v: user.token_version,
    h: await requestHash(req),
    e: now() + TICKET_TTL_SECONDS,
  };
  const sites = isOwner(user) ? [] : (await accessibleSites(env.DB, user)).map((s) => s.domain);
  const html = consentPage({
    clientName: client.name,
    redirectHost: redirectLabel(redirectUri),
    email: user.email,
    sites,
    allSites: isOwner(user),
    fields: { ...fields, step: 'consent', ticket: await sign(env.DB, 'ticket', ticket) },
  });
  return new Response(html, { status: 200, headers: pageHeaders(redirectUri) });
}

oauthRoutes.get('/oauth/authorize', (c) => handleAuthorize(c.env, c.req.raw));
oauthRoutes.post('/oauth/authorize', (c) => handleAuthorize(c.env, c.req.raw));

/* ---- token -- */

const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

async function pkceChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}

interface CodeRow {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  user_id: number;
  token_version: number;
  code_challenge: string;
  scope: string;
  expires_at: number;
}

oauthRoutes.post('/oauth/token', async (c) => {
  const env = c.env;
  const base = originOf(c.req.raw);
  const fields = await formFields(c.req.raw);
  const client = await verifyClientId(env.DB, clientIdFrom(c.req.raw, fields));
  if (!client) return oauthError('invalid_client', 'unknown client_id', 401);
  if (!resourceOk(base, fields.resource)) return oauthError('invalid_target', 'resource must be this server\'s /mcp');

  const at = now();

  if (fields.grant_type === 'authorization_code') {
    const code = fields.code ?? '';
    if (!/^[0-9a-f]{64}$/.test(code)) return oauthError('invalid_grant', 'invalid authorization code');

    // DELETE … RETURNING redeems the code in the same statement that reads
    // it: two concurrent exchanges cannot both get it, and a code presented
    // with a wrong verifier is gone too, so the verifier cannot be guessed.
    const row = await env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *')
      .bind(await sha256Hex(code))
      .first<CodeRow>();
    if (!row || row.expires_at <= at) return oauthError('invalid_grant', 'the code is invalid, spent or expired');
    if (row.client_id !== client.id) return oauthError('invalid_grant', 'the code was issued to another client');
    if (fields.redirect_uri && fields.redirect_uri !== row.redirect_uri) {
      return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
    }
    const verifier = fields.code_verifier ?? '';
    if (!VERIFIER_PATTERN.test(verifier) || !digestsMatch(await pkceChallenge(verifier), row.code_challenge)) {
      return oauthError('invalid_grant', 'PKCE verification failed');
    }

    const user = await getUserById(env.DB, row.user_id);
    if (!user || user.token_version !== row.token_version) {
      return oauthError('invalid_grant', 'the account no longer exists');
    }

    const grantId = randomHex(8);
    const pair = await newTokens(grantId);
    await env.DB.prepare(
      `INSERT INTO oauth_grants (id, user_id, client_id, client_name, scope, token_version,
                                 access_hash, access_expires_at, refresh_hash, refresh_expires_at,
                                 created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        grantId,
        user.id,
        client.id,
        row.client_name,
        row.scope,
        user.token_version,
        pair.accessHash,
        at + ACCESS_TTL_SECONDS,
        pair.refreshHash,
        at + REFRESH_TTL_SECONDS,
        at,
        at,
      )
      .run();
    return json(tokenResponse(pair), 200, NO_STORE);
  }

  if (fields.grant_type === 'refresh_token') {
    const presented = fields.refresh_token ?? '';
    const match = REFRESH_PATTERN.exec(presented);
    if (!match) return oauthError('invalid_grant', 'invalid refresh token');
    const grant = await env.DB.prepare('SELECT * FROM oauth_grants WHERE id = ?').bind(match[1]).first<GrantRow>();
    const hash = await sha256Hex(presented);
    if (
      !grant ||
      grant.refresh_expires_at <= at ||
      grant.client_id !== client.id ||
      !digestsMatch(hash, grant.refresh_hash)
    ) {
      // A superseded refresh token is simply refused, not treated as theft
      // that revokes the grant: a client that lost the response to its last
      // refresh would otherwise be disconnected by its own retry. The stolen-
      // token case is bounded anyway — the old token never works again, and
      // the holder of the current one is the legitimate client.
      return oauthError('invalid_grant', 'the refresh token is invalid, spent or expired');
    }
    if (!(await grantUser(env, grant))) return oauthError('invalid_grant', 'the account no longer exists');

    const pair = await newTokens(grant.id);
    // Conditional on the presented hash, so two racing refreshes with the
    // same token produce one winner and one invalid_grant, never two pairs.
    // The refresh lifetime slides: 90 days from the last use.
    const updated = await env.DB.prepare(
      `UPDATE oauth_grants
       SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?, last_used_at = ?
       WHERE id = ? AND refresh_hash = ?`,
    )
      .bind(pair.accessHash, at + ACCESS_TTL_SECONDS, pair.refreshHash, at + REFRESH_TTL_SECONDS, at, grant.id, hash)
      .run();
    if (updated.meta.changes !== 1) return oauthError('invalid_grant', 'the refresh token was already used');
    return json(tokenResponse(pair), 200, NO_STORE);
  }

  return oauthError('unsupported_grant_type', 'use authorization_code or refresh_token');
});

/* ---- revoke (RFC 7009) -- */

/**
 * Revoking either token of a grant ends the whole grant: an agent that signs
 * out means "forget me", and leaving its other token alive would not.
 * Always 200, per the RFC, whether or not the token was known.
 */
oauthRoutes.post('/oauth/revoke', async (c) => {
  const fields = await formFields(c.req.raw);
  const token = fields.token ?? '';
  const match = ACCESS_PATTERN.exec(token) ?? REFRESH_PATTERN.exec(token);
  if (match) {
    const grant = await c.env.DB.prepare('SELECT access_hash, refresh_hash FROM oauth_grants WHERE id = ?')
      .bind(match[1])
      .first<{ access_hash: string; refresh_hash: string }>();
    const hash = await sha256Hex(token);
    if (grant && (digestsMatch(hash, grant.access_hash) || digestsMatch(hash, grant.refresh_hash))) {
      await c.env.DB.prepare('DELETE FROM oauth_grants WHERE id = ?').bind(match[1]).run();
    }
  }
  return json({}, 200, NO_STORE);
});
