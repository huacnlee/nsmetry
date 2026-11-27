/**
 * People: raw user ids kept only for sites that opt in (src/people.ts).
 *
 * Ingest must store nothing while the setting is off, store and refresh at
 * most hourly while it is on, and forget everything when it is turned off.
 * The routes follow the same access rules as every other report.
 */

import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureSchema, listRawTables } from '../src/db';
import { clearSiteCache, handleBatchIngest, handleIngest } from '../src/ingest';
import { createSession } from '../src/sessions';
import { createUser, ensureAdminAccount } from '../src/users';

const db = env.DB;
const workerEnv = env as unknown as Env;
const BASE = 'https://analytics.example.com';
const UA = 'MyApp/1.0 (Macintosh; macOS 26.0)';

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, 'cf-connecting-ip': '198.51.100.7' },
    body: JSON.stringify(body),
  });
}

const send = (body: unknown) => handleIngest(post('/api/event', body), workerEnv);
const sendBatch = (body: unknown) => handleBatchIngest(post('/api/events/batch', body), workerEnv);

interface Identity {
  site_id: number;
  user_id: string;
  first_seen: number;
  last_seen: number;
}

async function identities(): Promise<Identity[]> {
  const { results } = await db
    .prepare('SELECT site_id, user_id, first_seen, last_seen FROM app_identities ORDER BY site_id, user_id')
    .all<Identity>();
  return results;
}

const ts = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

async function ownerToken(): Promise<string> {
  const owner = await ensureAdminAccount(db, 'owner@example.com');
  return createSession(db, owner!.id);
}

function api(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-03-10T12:00:00Z');
  await ensureSchema(db);
  for (const table of await listRawTables(db)) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const table of ['app_identities', 'site_access', 'sessions', 'users', 'sites', 'settings']) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.batch([
    db.prepare("INSERT INTO sites (id, domain, created_at) VALUES (1, 'myapp', 0)"),
    db.prepare("INSERT INTO sites (id, domain, created_at) VALUES (2, 'other-app', 0)"),
  ]);
  clearSiteCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ingest', () => {
  it('stores no user id while the setting is off (the default)', async () => {
    expect((await send({ site: 'myapp', name: 'screen_view', path: '/', user_id: 'jane@example.com' })).status).toBe(204);
    expect(
      (await sendBatch({ site: 'myapp', events: [{ name: 'screen_view', path: '/', user_id: 'joe@example.com' }] })).status,
    ).toBe(204);
    expect(await identities()).toEqual([]);
  });

  it('stores each person once per batch while on, and refreshes last_seen at most hourly', async () => {
    await db.prepare('UPDATE sites SET keep_user_ids = 1 WHERE id = 1').run();
    clearSiteCache();

    const batch = (userIds: string[]) =>
      sendBatch({ site: 'myapp', events: userIds.map((user_id) => ({ name: 'screen_view', path: '/', user_id })) });
    expect((await batch(['jane@example.com', 'jane@example.com', 'joe@example.com'])).status).toBe(204);
    // Events without a user id and other sites are left alone.
    await send({ site: 'myapp', name: 'screen_view', path: '/' });
    await send({ site: 'other-app', name: 'screen_view', path: '/', user_id: 'jane@example.com' });

    const first = ts('2026-03-10T12:00:00Z');
    expect(await identities()).toEqual([
      { site_id: 1, user_id: 'jane@example.com', first_seen: first, last_seen: first },
      { site_id: 1, user_id: 'joe@example.com', first_seen: first, last_seen: first },
    ]);

    // Within the hour: no row written.
    at('2026-03-10T12:30:00Z');
    await batch(['jane@example.com']);
    expect((await identities())[0]!.last_seen).toBe(first);

    // Past it: last_seen moves, first_seen stays.
    at('2026-03-10T13:30:01Z');
    await send({ site: 'myapp', name: 'screen_view', path: '/', user_id: 'jane@example.com' });
    expect((await identities())[0]).toEqual({
      site_id: 1,
      user_id: 'jane@example.com',
      first_seen: first,
      last_seen: ts('2026-03-10T13:30:01Z'),
    });
  });

  it('keeps nothing once turned off, even from an isolate whose cache still says on', async () => {
    const token = await ownerToken();
    expect((await api('PUT', '/api/sites/1/keep-user-ids', token, { enabled: true })).status).toBe(200);
    await send({ site: 'myapp', name: 'screen_view', path: '/', user_id: 'jane@example.com' });
    expect(await identities()).toHaveLength(1);

    // Prime the cache with "on", then turn it off behind its back.
    await db.prepare('UPDATE sites SET keep_user_ids = 0 WHERE id = 1').run();
    await db.prepare('DELETE FROM app_identities').run();
    await send({ site: 'myapp', name: 'screen_view', path: '/', user_id: 'joe@example.com' });
    expect(await identities()).toEqual([]);
  });
});

describe('routes', () => {
  it('lets only the administrator toggle the setting, and turning it off deletes the ids', async () => {
    const token = await ownerToken();
    const viewer = await createUser(db, { email: 'viewer@example.com', siteIds: [1] });
    const viewerToken = await createSession(db, viewer!.id);

    expect((await api('PUT', '/api/sites/1/keep-user-ids', viewerToken, { enabled: true })).status).toBe(403);
    expect((await api('PUT', '/api/sites/1/keep-user-ids', token, { enabled: 'yes' })).status).toBe(400);
    expect((await api('PUT', '/api/sites/99/keep-user-ids', token, { enabled: true })).status).toBe(404);

    const on = await api('PUT', '/api/sites/1/keep-user-ids', token, { enabled: true });
    expect(await on.json()).toEqual({ enabled: true });
    const sites = (await (await api('GET', '/api/sites', token)).json()) as { sites: { id: number; keep_user_ids: number }[] };
    expect(sites.sites.find((s) => s.id === 1)!.keep_user_ids).toBe(1);

    await send({ site: 'myapp', name: 'screen_view', path: '/', user_id: 'jane@example.com' });
    expect(await identities()).toHaveLength(1);

    expect((await api('PUT', '/api/sites/1/keep-user-ids', token, { enabled: false })).status).toBe(200);
    expect(await identities()).toEqual([]);
    await send({ site: 'myapp', name: 'screen_view', path: '/', user_id: 'jane@example.com' });
    expect(await identities()).toEqual([]);
  });

  it('lists people seen in the window, newest first, with the total', async () => {
    const token = await ownerToken();
    const off = (await (await api('GET', '/api/people?site=1', token)).json()) as Record<string, unknown>;
    expect(off).toEqual({ enabled: false, days: 30, people: [], total: 0 });

    await api('PUT', '/api/sites/1/keep-user-ids', token, { enabled: true });
    at('2026-02-01T08:00:00Z');
    await send({ site: 'myapp', name: 'screen_view', path: '/', user_id: 'gone@example.com' });
    at('2026-03-09T08:00:00Z');
    await send({ site: 'myapp', name: 'screen_view', path: '/', user_id: 'joe@example.com' });
    at('2026-03-10T12:00:00Z');
    await send({ site: 'myapp', name: 'screen_view', path: '/', user_id: 'jane@example.com' });

    const body = (await (await api('GET', '/api/people?site=1&days=30', token)).json()) as {
      enabled: boolean;
      total: number;
      people: { user_id: string; first_seen: number; last_seen: number }[];
    };
    expect(body.enabled).toBe(true);
    expect(body.total).toBe(2);
    expect(body.people.map((p) => p.user_id)).toEqual(['jane@example.com', 'joe@example.com']);

    const wide = (await (await api('GET', '/api/people?site=1&days=60&limit=1', token)).json()) as typeof body;
    expect(wide.total).toBe(3);
    expect(wide.people).toHaveLength(1);

    expect((await api('GET', '/api/people?site=1&days=0', token)).status).toBe(400);
    expect((await api('GET', '/api/people?site=1')).status).toBe(401);
  });

  it('checks site access like every other report', async () => {
    const owner = await ownerToken();
    await api('PUT', '/api/sites/1/keep-user-ids', owner, { enabled: true });
    const viewer = await createUser(db, { email: 'viewer@example.com', siteIds: [2] });
    const token = await createSession(db, viewer!.id);
    expect((await api('GET', '/api/people?site=1', token)).status).toBe(403);
    expect((await api('GET', '/api/people?site=2', token)).status).toBe(200);
  });
});
