/**
 * OAuth 2.1 for AI agents (src/oauth.ts), end to end through the Worker.
 *
 * The authorize flow is driven the way a browser drives it: plain form posts,
 * the hidden fields of each page echoed into the next, and the emailed code
 * read from the log line the Worker writes when no mail transport is set up
 * (the pool configures none; see vitest.config.ts).
 */

import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { base64UrlEncode } from '../src/auth';
import { ensureSchema } from '../src/db';
import { resolveAccessToken } from '../src/oauth';
import { createSession } from '../src/sessions';
import { createUser, deleteUser, getUserByEmail } from '../src/users';

const db = env.DB;
const ADMIN = 'owner@example.com';
const BASE = 'https://nsmetry.test';
const REDIRECT = 'http://127.0.0.1:33418/callback';

async function reset(): Promise<void> {
  await ensureSchema(db);
  for (const table of ['sessions', 'auth_codes', 'auth_limits', 'site_access', 'users', 'sites', 'settings', 'oauth_grants', 'oauth_codes']) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.batch([
    db.prepare("INSERT INTO sites (id, domain, created_at) VALUES (1, 'example.com', 0)"),
    db.prepare("INSERT INTO sites (id, domain, created_at) VALUES (2, 'my-app', 0)"),
  ]);
}

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

/* --------------------------------------------------------------- helpers -- */

async function register(body: Record<string, unknown> = {}): Promise<{ client_id: string } & Record<string, unknown>> {
  const response = await SELF.fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Agent', redirect_uris: [REDIRECT], ...body }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string };
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(bytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

const decodeEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The hidden inputs of a page, as a browser would submit them. */
function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) {
    out[decodeEntities(m[1]!)] = decodeEntities(m[2]!);
  }
  return out;
}

function postForm(fields: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${BASE}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

/** Submit the email step and fish the code out of the Worker's log line. */
async function emailStep(fields: Record<string, string>, email: string): Promise<{ html: string; code: string }> {
  const log = vi.spyOn(console, 'log');
  const response = await postForm({ ...fields, email });
  const html = await response.text();
  expect(response.status, html).toBe(200);
  const line = log.mock.calls.map((args) => String(args[0])).find((l) => l.includes('sign-in-code'));
  log.mockRestore();
  if (!line) throw new Error('no sign-in code was logged');
  return { html, code: (JSON.parse(line) as { code: string }).code };
}

interface Flow {
  clientId: string;
  verifier: string;
  /** The consent page's hidden fields, ready to post with a decision. */
  consent: Record<string, string>;
  consentResponse: Response;
  consentHtml: string;
}

/** Register (unless given a client), open authorize, sign in by code, reach consent. */
async function toConsent(email = ADMIN, clientId?: string, extra: Record<string, string> = {}): Promise<Flow> {
  const id = clientId ?? (await register()).client_id;
  const { verifier, challenge } = await pkcePair();
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'read',
    resource: `${BASE}/mcp`,
    ...extra,
  });
  const first = await SELF.fetch(`${BASE}/oauth/authorize?${query}`, { redirect: 'manual' });
  const firstHtml = await first.text();
  expect(first.status, firstHtml).toBe(200);
  expect(firstHtml).toContain('Test Agent');
  expect(firstHtml).not.toContain('<script');

  const { html: codeHtml, code } = await emailStep(hiddenFields(firstHtml), email);
  const consentResponse = await postForm({ ...hiddenFields(codeHtml), email, code });
  const consentHtml = await consentResponse.text();
  return { clientId: id, verifier, consent: hiddenFields(consentHtml), consentResponse, consentHtml };
}

/** Approve on the consent page and return the code from the redirect. */
async function approve(flow: Flow): Promise<string> {
  const response = await postForm({ ...flow.consent, decision: 'approve' });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get('state')).toBe('xyz');
  expect(location.searchParams.get('iss')).toBe(BASE);
  return location.searchParams.get('code')!;
}

function token(fields: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

async function fullFlow(email = ADMIN): Promise<Tokens & { clientId: string }> {
  const flow = await toConsent(email);
  const code = await approve(flow);
  const response = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: flow.verifier,
    client_id: flow.clientId,
    redirect_uri: REDIRECT,
  });
  expect(response.status).toBe(200);
  return { ...((await response.json()) as Tokens), clientId: flow.clientId };
}

/* ----------------------------------------------------------------- tests -- */

describe('metadata', () => {
  it('serves protected-resource metadata, bare and path-inserted', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await SELF.fetch(`${BASE}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(await response.json()).toMatchObject({
        resource: `${BASE}/mcp`,
        authorization_servers: [BASE],
        scopes_supported: ['read'],
      });
    }
  });

  it('serves authorization-server metadata with PKCE S256 and public clients', async () => {
    const response = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  });

  it('answers CORS preflight on the token endpoint', async () => {
    const response = await SELF.fetch(`${BASE}/oauth/token`, { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('registration', () => {
  it('registers a public client without writing a row', async () => {
    const before = await db.prepare('SELECT COUNT(*) AS n FROM settings').first<{ n: number }>();
    await register(); // first call creates the instance signing key (one row, once)
    const after = await db.prepare('SELECT COUNT(*) AS n FROM settings').first<{ n: number }>();
    const body = await register({ token_endpoint_auth_method: 'client_secret_basic' });
    const later = await db.prepare('SELECT COUNT(*) AS n FROM settings').first<{ n: number }>();

    expect(after!.n - before!.n).toBe(1);
    expect(later!.n).toBe(after!.n);
    expect(body).toMatchObject({
      client_name: 'Test Agent',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    expect(body.client_id).toMatch(/^nsc1\./);
  });

  it('accepts https, loopback http and private-use schemes, refuses the rest', async () => {
    for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:6274/cb', 'cursor://anysphere/cb']) {
      await register({ redirect_uris: [ok] });
    }
    for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'https://x.example/cb#frag', 'not a url']) {
      const response = await SELF.fetch(`${BASE}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [bad] }),
      });
      expect(response.status, bad).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    }
  });

  it('rejects a forged or tampered client id at authorize', async () => {
    const { client_id } = await register();
    const tampered = `${client_id.slice(0, -2)}AA`;
    const response = await SELF.fetch(
      `${BASE}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(tampered)}&redirect_uri=${encodeURIComponent(REDIRECT)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('not registered');
  });
});

describe('authorize', () => {
  it('shows an error page, not a redirect, for an unregistered redirect_uri', async () => {
    const { client_id } = await register();
    const { challenge } = await pkcePair();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: 'https://attacker.example/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const response = await SELF.fetch(`${BASE}/oauth/authorize?${query}`, { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('requires PKCE S256', async () => {
    const { client_id } = await register();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: 'plain-challenge',
      code_challenge_method: 'plain',
      state: 's1',
    });
    const response = await SELF.fetch(`${BASE}/oauth/authorize?${query}`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('s1');
  });

  it('serves the pages without script, unframeable, with form-action naming only the redirect origin', async () => {
    const flow = await toConsent();
    expect(flow.consentResponse.status).toBe(200);
    const csp = flow.consentResponse.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' http://127.0.0.1:33418");
    expect(flow.consentHtml).toContain('Test Agent');
    expect(flow.consentHtml).toContain('127.0.0.1:33418');
    expect(flow.consentHtml).not.toContain('<script');
    expect(flow.consent.ticket).toBeTruthy();
  });

  it('refuses a wrong email code and stays on the code step', async () => {
    const { client_id } = await register();
    const { challenge } = await pkcePair();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const first = await (await SELF.fetch(`${BASE}/oauth/authorize?${query}`)).text();
    const { html } = await emailStep(hiddenFields(first), ADMIN);
    const response = await postForm({ ...hiddenFields(html), email: ADMIN, code: 'AAAAAAAA' });
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('not right');
    expect(hiddenFields(body).ticket).toBeUndefined();
  });

  it('refuses an uninvited email', async () => {
    const { client_id } = await register();
    const { challenge } = await pkcePair();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const first = await (await SELF.fetch(`${BASE}/oauth/authorize?${query}`)).text();
    const response = await postForm({ ...hiddenFields(first), email: 'stranger@example.com' });
    expect(response.status).toBe(403);
  });

  it('rejects a consent post with a forged or re-targeted ticket', async () => {
    const flow = await toConsent();
    // Same ticket, different redirect: the ticket is bound to every parameter.
    const other = await postForm({ ...flow.consent, state: 'changed', decision: 'approve' });
    expect(other.status).toBe(400);
    expect(await other.text()).toContain('sign in again');

    const forged = await postForm({ ...flow.consent, ticket: 'eyJ1IjoxfQ.AAAA', decision: 'approve' });
    expect(forged.status).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM oauth_codes').first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('a removed viewer’s saved consent page cannot approve for the next account given its id', async () => {
    const mallory = await createUser(db, { email: 'mallory@example.com', siteIds: [1] });
    const flow = await toConsent('mallory@example.com');
    await deleteUser(db, (await getUserByEmail(db, 'mallory@example.com'))!);
    // SQLite reuses the highest deleted INTEGER PRIMARY KEY.
    const alice = await createUser(db, { email: 'alice@example.com', siteIds: [1] });
    expect(alice!.id).toBe(mallory!.id);

    const response = await postForm({ ...flow.consent, decision: 'approve' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('sign in again');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM oauth_codes').first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('sends access_denied back when the user denies', async () => {
    const flow = await toConsent();
    const response = await postForm({ ...flow.consent, decision: 'deny' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('code')).toBeNull();
  });
});

describe('token', () => {
  it('runs the full authorize → token PKCE flow and the token reaches /mcp', async () => {
    const tokens = await fullFlow();
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.access_token).toMatch(/^nsa_/);
    expect(tokens.refresh_token).toMatch(/^nsr_/);

    // Only hashes are stored.
    const grant = await db.prepare('SELECT * FROM oauth_grants').first<Record<string, unknown>>();
    expect(JSON.stringify(grant)).not.toContain(tokens.access_token);
    expect(JSON.stringify(grant)).not.toContain(tokens.refresh_token);
    expect(grant!.client_name).toBe('Test Agent');

    const resolved = await resolveAccessToken(env, tokens.access_token);
    expect(resolved?.user.email).toBe(ADMIN);
  });

  it('refuses a wrong verifier and burns the code', async () => {
    const flow = await toConsent();
    const code = await approve(flow);
    const bad = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: (await pkcePair()).verifier,
      client_id: flow.clientId,
      redirect_uri: REDIRECT,
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' });

    // Even the right verifier cannot use it now.
    const retry = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: flow.verifier,
      client_id: flow.clientId,
      redirect_uri: REDIRECT,
    });
    expect(retry.status).toBe(400);
  });

  it('redeems a code only once', async () => {
    const flow = await toConsent();
    const code = await approve(flow);
    const fields = {
      grant_type: 'authorization_code',
      code,
      code_verifier: flow.verifier,
      client_id: flow.clientId,
      redirect_uri: REDIRECT,
    };
    expect((await token(fields)).status).toBe(200);
    const again = await token(fields);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a code presented by another client', async () => {
    const flow = await toConsent();
    const code = await approve(flow);
    const other = await register({ client_name: 'Other' });
    const response = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: flow.verifier,
      client_id: other.client_id,
    });
    expect(response.status).toBe(400);
  });

  it('rotates the refresh token and retires both old tokens', async () => {
    const first = await fullFlow();
    const response = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: first.clientId,
    });
    expect(response.status).toBe(200);
    const second = (await response.json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);

    // The spent refresh token and the old access token no longer work.
    const reuse = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: first.clientId });
    expect(reuse.status).toBe(400);
    expect(await resolveAccessToken(env, first.access_token)).toBeNull();
    expect(await resolveAccessToken(env, second.access_token)).not.toBeNull();
    // Still one grant: rotation rewrites the row rather than adding one.
    expect(await db.prepare('SELECT COUNT(*) AS n FROM oauth_grants').first<{ n: number }>()).toEqual({ n: 1 });
  });

  it('expires access tokens after an hour', async () => {
    const tokens = await fullFlow();
    const later = Math.floor(Date.now() / 1000) + 3601;
    expect(await resolveAccessToken(env, tokens.access_token, later)).toBeNull();
  });

  it('refuses an unsupported grant type', async () => {
    const { client_id } = await register();
    const response = await token({ grant_type: 'client_credentials', client_id });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });
});

describe('revocation and grants', () => {
  it('revoking either token ends the whole grant', async () => {
    const tokens = await fullFlow();
    const response = await SELF.fetch(`${BASE}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refresh_token, client_id: tokens.clientId }).toString(),
    });
    expect(response.status).toBe(200);
    expect(await resolveAccessToken(env, tokens.access_token)).toBeNull();
    const refresh = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId });
    expect(refresh.status).toBe(400);
  });

  it('lists and disconnects grants under /api/oauth/grants, per user', async () => {
    const tokens = await fullFlow();
    const admin = await getUserByEmail(db, ADMIN);
    const session = await createSession(db, admin!.id, 'test');

    const list = await SELF.fetch(`${BASE}/api/oauth/grants`, { headers: { authorization: `Bearer ${session}` } });
    expect(list.status).toBe(200);
    const { grants } = (await list.json()) as { grants: { id: string; client_name: string }[] };
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ client_name: 'Test Agent' });
    expect(Object.keys(grants[0]!).sort()).toEqual(['client_name', 'created_at', 'id', 'last_used_at']);

    // Another person cannot see or delete it.
    const viewer = await createUser(db, { email: 'viewer@example.com', siteIds: [1] });
    const viewerSession = await createSession(db, viewer!.id, 'test');
    const theirs = await SELF.fetch(`${BASE}/api/oauth/grants`, { headers: { authorization: `Bearer ${viewerSession}` } });
    expect(((await theirs.json()) as { grants: unknown[] }).grants).toEqual([]);
    const steal = await SELF.fetch(`${BASE}/api/oauth/grants/${grants[0]!.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${viewerSession}` },
    });
    expect(steal.status).toBe(404);
    expect(await resolveAccessToken(env, tokens.access_token)).not.toBeNull();

    const removed = await SELF.fetch(`${BASE}/api/oauth/grants/${grants[0]!.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(await resolveAccessToken(env, tokens.access_token)).toBeNull();
  });

  it('a removed user’s agents stop working at once', async () => {
    await createUser(db, { email: 'viewer@example.com', siteIds: [1] });
    const tokens = await fullFlow('viewer@example.com');
    expect(await resolveAccessToken(env, tokens.access_token)).not.toBeNull();

    const viewer = await getUserByEmail(db, 'viewer@example.com');
    await deleteUser(db, viewer!);
    expect(await resolveAccessToken(env, tokens.access_token)).toBeNull();
    const refresh = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.clientId });
    expect(refresh.status).toBe(400);
  });

  it('requires a session for /api/oauth/grants', async () => {
    const response = await SELF.fetch(`${BASE}/api/oauth/grants`);
    expect(response.status).toBe(401);
  });
});
