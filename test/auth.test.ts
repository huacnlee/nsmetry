/**
 * Accounts, email-code sign-in, bearer sessions and access control.
 *
 * The pool names owner@example.com as ADMIN_EMAIL (vitest.config.ts) and sets
 * up no mail transport, so every code goes to console.log — which is also how
 * these tests read it, through the same path an administrator would use.
 */

import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILS_PER_DAY, SENDS_PER_HOUR, checkCode, codeHash, startSignIn } from '../src/auth';
import { ensureSchema, getSetting, migrateLegacyAdmin, setSetting } from '../src/db';
import { SEEN_EVERY_SECONDS, SESSION_IDLE_SECONDS, createSession, resolveSession } from '../src/sessions';
import {
  accessibleSites,
  canAccessSite,
  createUser,
  ensureAdminAccount,
  getUserByEmail,
  setSiteAccess,
  withRole,
} from '../src/users';

const db = env.DB;
const ADMIN = 'owner@example.com';
const BASE = 'https://nsmetry.test';

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

function post(path: string, body: unknown, token?: string, ip?: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'cf-connecting-ip': ip } : {}),
    },
    body: JSON.stringify(body),
  });
}

function api(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

/** Ask for a code and fish it out of the log line the Worker writes. */
async function requestCode(email: string): Promise<string> {
  const log = vi.spyOn(console, 'log');
  const response = await post('/api/auth/start', { email });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; delivery: string; codeLength: number; codeDigits?: number; message?: string };
  expect(body).toMatchObject({ ok: true, delivery: 'log', codeLength: 8 });
  // Apps 0.1.2–0.1.3 show digit-only cells when they see `codeDigits`; letters would not fit in them.
  expect(body.codeDigits).toBeUndefined();
  expect(body.message).toMatch(/wrangler tail/);

  const line = log.mock.calls.map((args) => String(args[0])).find((l) => l.includes('sign-in-code'));
  log.mockRestore();
  if (!line) throw new Error('no sign-in code was logged');
  const parsed = JSON.parse(line) as { to: string; code: string };
  expect(parsed.to).toBe(email);
  expect(parsed.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  return parsed.code;
}

async function signIn(email: string): Promise<{ token: string; user: { id: number; role: string; siteIds: number[] } }> {
  const code = await requestCode(email);
  const response = await post('/api/auth/verify', { email, code: code.toLowerCase() });
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string; user: { id: number; role: string; siteIds: number[] } };
}

/* ------------------------------------------------------------- sign-in -- */

describe('email code sign-in', () => {
  it('signs the administrator in on first use and creates the account', async () => {
    expect(await getUserByEmail(db, ADMIN)).toBeNull();
    const { token, user } = await signIn(ADMIN);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(user).toMatchObject({ role: 'owner', siteIds: [] });

    const me = await api('/api/me', token);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(ADMIN);

    // Only hashes are stored: neither the token nor the code is in the database.
    const stored = await db.prepare('SELECT token_hash FROM sessions').all<{ token_hash: string }>();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]!.token_hash).not.toBe(token);
  });

  it('accepts the code typed loosely, and only once', async () => {
    const code = await requestCode(ADMIN);
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`;
    expect((await post('/api/auth/verify', { email: ADMIN, code: typed })).status).toBe(200);
    expect((await post('/api/auth/verify', { email: ADMIN, code })).status).toBe(401);
  });

  it('rejects a wrong code, and stops after five tries on one code', async () => {
    const code = await requestCode(ADMIN);
    const wrong = code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA';
    for (let i = 0; i < 5; i++) {
      const response = await post('/api/auth/verify', { email: ADMIN, code: wrong });
      expect(response.status).toBe(401);
    }
    // The right code no longer works either: the tries are spent.
    const response = await post('/api/auth/verify', { email: ADMIN, code });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toMatch(/too many attempts/);
  });

  it('rejects an expired code', async () => {
    const code = await requestCode(ADMIN);
    await db.prepare('UPDATE auth_codes SET expires_at = ?').bind(Math.floor(Date.now() / 1000) - 1).run();
    const response = await post('/api/auth/verify', { email: ADMIN, code });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toMatch(/expired/);
  });

  it('refuses an email that was never invited, before writing anything', async () => {
    const response = await post('/api/auth/start', { email: 'stranger@example.com' });
    expect(response.status).toBe(403);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM auth_codes').first<{ n: number }>())?.n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM auth_limits').first<{ n: number }>())?.n).toBe(0);
  });

  it('signs an invited viewer in as a viewer', async () => {
    await createUser(db, { email: 'viewer@example.com', siteIds: [2] });
    const { user } = await signIn('viewer@example.com');
    expect(user).toMatchObject({ role: 'viewer', siteIds: [2] });
  });

  it('rejects malformed input', async () => {
    expect((await post('/api/auth/start', { email: 'nope' })).status).toBe(400);
    expect((await post('/api/auth/verify', { email: ADMIN, code: '123' })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/auth/start`, { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('makes people wait a minute between codes for one address', async () => {
    await requestCode(ADMIN);
    const again = await post('/api/auth/start', { email: ADMIN });
    expect(again.status).toBe(429);
  });

  it('caps the codes mailed per hour to one caller', async () => {
    const hour = new Date().toISOString().slice(0, 13);
    await db
      .prepare('INSERT INTO auth_limits (key, n, expires_at) VALUES (?, ?, ?)')
      .bind(`send-ip:203.0.113.9:${hour}`, SENDS_PER_HOUR, Math.floor(Date.now() / 1000) + 3600)
      .run();
    const response = await post('/api/auth/start', { email: ADMIN }, undefined, '203.0.113.9');
    expect(response.status).toBe(429);
    // Another caller is not starved by the first one's quota.
    expect((await post('/api/auth/start', { email: ADMIN }, undefined, '198.51.100.7')).status).toBe(200);
  });

  it('locks only the guessing caller out for the day after too many wrong codes', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const attacker = '203.0.113.9';
    await db
      .prepare('INSERT INTO auth_limits (key, n, expires_at) VALUES (?, ?, ?)')
      .bind(`fail-ip:${attacker}:${day}`, FAILS_PER_DAY - 1, Math.floor(Date.now() / 1000) + 86400)
      .run();

    const code = await requestCode(ADMIN);
    const wrong = code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA';
    expect((await post('/api/auth/verify', { email: ADMIN, code: wrong }, undefined, attacker)).status).toBe(401);

    // The attacker is locked out, even with the right code, and gets no new code…
    expect((await post('/api/auth/verify', { email: ADMIN, code }, undefined, attacker)).status).toBe(429);
    expect((await post('/api/auth/start', { email: ADMIN }, undefined, attacker)).status).toBe(429);
    // …but the administrator's outstanding code still works from their own network.
    expect((await post('/api/auth/verify', { email: ADMIN, code }, undefined, '198.51.100.7')).status).toBe(200);
  });

  it('spends each of a code\'s five tries once, however many guesses race', async () => {
    const code = await requestCode(ADMIN);
    const wrong = code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA';
    const now = Math.floor(Date.now() / 1000);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => checkCode(env, ADMIN, wrong, '203.0.113.9', now)),
    );
    const compared = results.filter((r) => 'error' in r && r.error === 'that code is not right').length;
    expect(compared).toBe(5);
    const day = new Date(now * 1000).toISOString().slice(0, 10);
    const fails = await db
      .prepare('SELECT n FROM auth_limits WHERE key = ?')
      .bind(`fail-ip:203.0.113.9:${day}`)
      .first<{ n: number }>();
    expect(fails?.n).toBe(5);
  });

  it('answers with a clear error until ADMIN_EMAIL is set', async () => {
    const unset = { ...env, ADMIN_EMAIL: '' } as unknown as Env;
    const start = await startSignIn(unset, ADMIN);
    expect(start.status).toBe(503);
    expect((start.body as { error: string }).error).toMatch(/ADMIN_EMAIL/);
    const check = await checkCode(unset, ADMIN, 'ABCDEFGH');
    expect(check).toMatchObject({ status: 503 });
  });

  it('withdraws a code when the invitation is withdrawn first', async () => {
    const invited = await createUser(db, { email: 'viewer@example.com', siteIds: [] });
    const code = await requestCode('viewer@example.com');
    await db.prepare('DELETE FROM users WHERE id = ?').bind(invited!.id).run();
    // The code row still exists here (a raw delete, not deleteUser), so this
    // exercises the re-check after a correct code.
    await db
      .prepare('INSERT OR REPLACE INTO auth_codes (email, hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, 0)')
      .bind('viewer@example.com', await codeHash('viewer@example.com', code), Math.floor(Date.now() / 1000) + 600)
      .run();
    expect((await post('/api/auth/verify', { email: 'viewer@example.com', code })).status).toBe(403);
  });
});

/* ------------------------------------------------------------- sessions -- */

describe('bearer sessions', () => {
  it('requires a token on every other /api route', async () => {
    expect((await SELF.fetch(`${BASE}/api/me`)).status).toBe(401);
    expect((await api('/api/me', 'f'.repeat(64))).status).toBe(401);
    expect((await api('/api/me', 'not-a-token')).status).toBe(401);
  });

  it('signs out the token on logout, and only that token', async () => {
    const first = await signIn(ADMIN);
    const second = await createSession(db, first.user.id);

    const out = await post('/api/auth/logout', {}, first.token);
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });

    expect((await api('/api/me', first.token)).status).toBe(401);
    expect((await api('/api/me', second)).status).toBe(200);
  });

  it('expires after 90 idle days and records use at most hourly', async () => {
    const admin = await ensureAdminAccount(db, ADMIN);
    const now = 1_800_000_000;
    const token = await createSession(db, admin!.id, '', now);

    expect(await resolveSession(db, token, now + 60)).toBe(admin!.id);
    const seen = () => db.prepare('SELECT last_seen FROM sessions').first<{ last_seen: number }>();
    expect((await seen())?.last_seen).toBe(now); // no write within the hour

    expect(await resolveSession(db, token, now + SEEN_EVERY_SECONDS)).toBe(admin!.id);
    expect((await seen())?.last_seen).toBe(now + SEEN_EVERY_SECONDS);

    const later = now + SEEN_EVERY_SECONDS + SESSION_IDLE_SECONDS + 1;
    expect(await resolveSession(db, token, later)).toBeNull();
    expect(await seen()).toBeNull(); // deleted on sight
  });
});

/* ---------------------------------------------------------- permissions -- */

describe('administrator and viewers', () => {
  it('lets only the administrator manage sites, people and settings', async () => {
    await createUser(db, { email: 'viewer@example.com', siteIds: [1] });
    const viewer = (await signIn('viewer@example.com')).token;

    for (const [method, path, body] of [
      ['GET', '/api/users', undefined],
      ['POST', '/api/users', { email: 'x@example.com', siteIds: [] }],
      ['PATCH', '/api/users/1', { siteIds: [] }],
      ['DELETE', '/api/users/1', undefined],
      ['POST', '/api/sites', { domain: 'new.example' }],
      ['DELETE', '/api/sites/1', undefined],
      ['PUT', '/api/settings/tracker-url', { url: '' }],
    ] as const) {
      const response = await api(path, viewer, { method, body: body ? JSON.stringify(body) : undefined });
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    // What a viewer can do: read its own account and its own sites.
    const sites = (await (await api('/api/sites', viewer)).json()) as { sites: { domain: string }[] };
    expect(sites.sites.map((s) => s.domain)).toEqual(['example.com']);
    expect((await api('/api/summary?site=2&range=7d', viewer)).status).toBe(403);
  });

  it('invites, re-grants and removes a viewer', async () => {
    const admin = (await signIn(ADMIN)).token;

    const invited = await api('/api/users', admin, {
      method: 'POST',
      body: JSON.stringify({ email: ' Viewer@Example.com ', siteIds: [1, 99] }),
    });
    expect(invited.status).toBe(200);
    const { user } = (await invited.json()) as { user: { id: number; email: string; role: string; siteIds: number[] } };
    // Normalised, a viewer, and the id that is not a site was dropped.
    expect(user).toMatchObject({ email: 'viewer@example.com', role: 'viewer', siteIds: [1] });

    const duplicate = await api('/api/users', admin, {
      method: 'POST',
      body: JSON.stringify({ email: 'viewer@example.com', siteIds: [] }),
    });
    expect(duplicate.status).toBe(409);
    const self = await api('/api/users', admin, { method: 'POST', body: JSON.stringify({ email: ADMIN, siteIds: [] }) });
    expect(self.status).toBe(400);

    const patched = await api(`/api/users/${user.id}`, admin, { method: 'PATCH', body: JSON.stringify({ siteIds: [2] }) });
    expect(((await patched.json()) as { user: { siteIds: number[] } }).user.siteIds).toEqual([2]);

    const list = (await (await api('/api/users', admin)).json()) as { users: { email: string; role: string }[] };
    expect(list.users.map((u) => [u.email, u.role])).toEqual([
      [ADMIN, 'owner'],
      ['viewer@example.com', 'viewer'],
    ]);

    const viewerToken = (await signIn('viewer@example.com')).token;
    expect((await api('/api/me', viewerToken)).status).toBe(200);

    const removed = await api(`/api/users/${user.id}`, admin, { method: 'DELETE' });
    expect(await removed.json()).toEqual({ ok: true });
    // Signed out at once, and can no longer ask for a code.
    expect((await api('/api/me', viewerToken)).status).toBe(401);
    expect((await post('/api/auth/start', { email: 'viewer@example.com' })).status).toBe(403);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(user.id).first<{ n: number }>())?.n).toBe(0);
  });

  it('refuses to remove or re-grant the administrator', async () => {
    const { token, user } = await signIn(ADMIN);
    expect((await api(`/api/users/${user.id}`, token, { method: 'DELETE' })).status).toBe(400);
    expect((await api(`/api/users/${user.id}`, token, { method: 'PATCH', body: '{"siteIds":[]}' })).status).toBe(400);
    expect((await api('/api/users/999', token, { method: 'DELETE' })).status).toBe(404);
  });

  it('adds and removes sites by domain or bare name', async () => {
    const admin = (await signIn(ADMIN)).token;
    const added = await api('/api/sites', admin, { method: 'POST', body: JSON.stringify({ domain: 'Disktree' }) });
    const { site } = (await added.json()) as { site: { id: number; domain: string } };
    expect(site.domain).toBe('disktree');
    expect(await (await api(`/api/sites/${site.id}`, admin, { method: 'DELETE' })).json()).toEqual({ ok: true });
    expect((await api('/api/sites', admin, { method: 'POST', body: '{"domain":"not a site"}' })).status).toBe(400);

    // A deleted site's id is never handed out again: its rollups are kept, and
    // a new site with the same id would inherit them.
    const next = await api('/api/sites', admin, { method: 'POST', body: JSON.stringify({ domain: 'omasend' }) });
    const { site: again } = (await next.json()) as { site: { id: number } };
    expect(again.id).toBeGreaterThan(site.id);
  });

  it('decides the administrator by ADMIN_EMAIL, not by the stored role', async () => {
    // An account from the password era that still says 'owner'.
    await db
      .prepare("INSERT INTO users (email, password_hash, password_salt, role, created_at) VALUES ('old@example.com', 'h', 's', 'owner', 0)")
      .run();
    const old = (await getUserByEmail(db, 'old@example.com'))!;
    expect(withRole(old, ADMIN).role).toBe('viewer');
    expect(await accessibleSites(db, withRole(old, ADMIN))).toEqual([]);

    const { token, user } = await signIn('old@example.com');
    expect(user.role).toBe('viewer');
    expect((await api('/api/users', token)).status).toBe(403);

    // Moving ADMIN_EMAIL moves the rights.
    expect(withRole(old, 'old@example.com').role).toBe('owner');
  });

  it('gives a viewer only the sites it was granted, and revokes at once', async () => {
    const viewer = withRole((await createUser(db, { email: 'client@example.com', siteIds: [1, 2] }))!, ADMIN);
    expect(await canAccessSite(db, viewer, 1)).toBe(true);
    await setSiteAccess(db, viewer.id, [2]);
    expect(await canAccessSite(db, viewer, 1)).toBe(false);
    expect(await canAccessSite(db, viewer, 2)).toBe(true);
  });

  it('carries a pre-user-model install forward as an ordinary account', async () => {
    await setSetting(db, 'admin_hash', 'legacy-hash');
    await setSetting(db, 'admin_salt', 'legacy-salt');
    await migrateLegacyAdmin(db);

    const migrated = await getUserByEmail(db, 'admin');
    expect(migrated).not.toBeNull();
    // Not an email, so it can never sign in; and not ADMIN_EMAIL, so it is no owner.
    expect(withRole(migrated!, ADMIN).role).toBe('viewer');
    expect(await getSetting(db, 'admin_hash')).toBeNull();
  });
});

/* ------------------------------------------------------------------ CORS -- */

describe('CORS', () => {
  it('answers preflights on any /api route without a session', async () => {
    const response = await SELF.fetch(`${BASE}/api/users/3`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'DELETE' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    expect(response.headers.get('access-control-allow-methods')).toMatch(/PATCH/);
  });

  it('marks every /api answer, errors included, and sets no cookies', async () => {
    const denied = await SELF.fetch(`${BASE}/api/me`);
    expect(denied.headers.get('access-control-allow-origin')).toBe('*');

    const start = await post('/api/auth/start', { email: 'stranger@example.com' });
    expect(start.headers.get('access-control-allow-origin')).toBe('*');

    const { token } = await signIn(ADMIN);
    const me = await api('/api/me', token);
    expect(me.headers.get('access-control-allow-origin')).toBe('*');
    expect(me.headers.get('set-cookie')).toBeNull();
  });

  it('no longer serves the password pages', async () => {
    for (const path of ['/setup', '/login']) {
      const response = await SELF.fetch(`${BASE}${path}`, { redirect: 'manual' });
      expect(response.status).toBe(404);
    }
  });
});
