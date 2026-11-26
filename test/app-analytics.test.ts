/**
 * The app-first data model: ingest fields, batches, uid privacy, the app
 * rollups (active users, first seen, event properties), the app analytics
 * endpoints, app_version as a dimension, and upgrades from older storage.
 *
 * Time is faked (Date only) so a test can ingest on several days through the
 * real handlers, which stamp events with the receive time.
 */

import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addToSketch, encodeSketch, estimateSketch, mergeSketch, newSketch } from '../src/app-analytics';
import { ensureSchema, listRawTables, rawEvents, rawTable, setSetting, SETTING_CUBE2_FROM } from '../src/db';
import { cleanProps, handleBatchIngest, handleIngest } from '../src/ingest';
import { loadBreakdown, loadTotals } from '../src/query';
import { rollupDay, rollupHour } from '../src/rollup';
import { createSession } from '../src/sessions';
import { partsFor } from '../src/time';
import { createUser, ensureAdminAccount } from '../src/users';
import { getDailySalt, visitorHash } from '../src/visitor';

const db = env.DB;
const workerEnv = env as unknown as Env;

const UA = 'Disktree/2.3 (iPhone; iOS 17.0)';
const DAY1 = '2026-03-08';
const DAY2 = '2026-03-09';
const TODAY = '2026-03-10';

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

function request(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://analytics.example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, 'cf-connecting-ip': '198.51.100.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const send = (body: unknown, headers?: Record<string, string>) => handleIngest(request('/api/event', body, headers), workerEnv);
const sendBatch = (body: unknown) => handleBatchIngest(request('/api/events/batch', body), workerEnv);

/** Unix seconds of an ISO time. */
const ts = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

interface StoredRow {
  name: string;
  path: string;
  visitor: string;
  uid: string;
  app_version: string;
  props: string;
  batch: string;
  browser: string;
  os: string;
  pv: number;
}

async function storedRows(): Promise<StoredRow[]> {
  const out: StoredRow[] = [];
  for (const table of await listRawTables(db)) {
    const { results } = await db.prepare(`SELECT * FROM ${table} ORDER BY site_id, ts, name`).all<StoredRow>();
    out.push(...results);
  }
  return out;
}

async function storedEvents(): Promise<{ ts: number; name: string; path: string; props: string; uid: string }[]> {
  const out: { ts: number; name: string; path: string; props: string; uid: string }[] = [];
  for (const table of await listRawTables(db)) {
    const { results } = await db
      .prepare(`SELECT ts, name, path, props, uid FROM (${rawEvents(table)}) ORDER BY ts, name`)
      .all<{ ts: number; name: string; path: string; props: string; uid: string }>();
    out.push(...results);
  }
  return out;
}

async function resetDatabase(): Promise<void> {
  for (const table of await listRawTables(db)) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const table of [
    'stats_hourly',
    'stats_daily',
    'stats_cube',
    'stats_cube2',
    'today_visits',
    'app_daily',
    'app_users',
    'site_access',
    'sessions',
    'users',
    'sites',
    'settings',
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(`${TODAY}T12:00:00Z`);
  await ensureSchema(db);
  await resetDatabase();
  await db.batch([
    db.prepare("INSERT INTO sites (id, domain, created_at) VALUES (1, 'disktree', 0)"),
    db.prepare("INSERT INTO sites (id, domain, created_at) VALUES (2, 'example.com', 0)"),
    db.prepare("INSERT INTO sites (id, domain, created_at) VALUES (3, 'omasend', 0)"),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

/* ---------------------------------------------------------------- ingest -- */

describe('ingest', () => {
  it('accepts the readable field names, app fields, and screen_view as a pageview', async () => {
    const response = await send({
      site: 'disktree',
      name: 'screen_view',
      path: '/settings',
      user_id: 'install-123',
      app_version: '2.3.1',
      props: { plan: 'pro', n: 3, beta: true },
    });
    expect(response.status).toBe(204);

    const short = await send({ d: 'disktree', n: 'purchase', u: '/settings', uid: 'install-123', v: '2.3.1', p: { a: 1 } });
    expect(short.status).toBe(204);

    const rows = await storedRows();
    // One row written per single event.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'pageview',
      path: '/settings',
      app_version: '2.3.1',
      props: JSON.stringify({ plan: 'pro', n: '3', beta: 'true' }),
      batch: '',
      browser: 'App',
      os: 'iOS',
    });
    expect(rows[0]!.uid).toMatch(/^[0-9a-f]{24}$/);
    expect(rows[1]).toMatchObject({ name: 'purchase', props: '{"a":"1"}' });
    // Short and long spellings name the same columns, so the same install
    // gets the same uid and the same daily visitor.
    expect(rows[1]!.uid).toBe(rows[0]!.uid);
    expect(rows[1]!.visitor).toBe(rows[0]!.visitor);
  });

  it('cleans properties: ten flat keys of a safe shape, short scalar values', () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(cleanProps(many)!)).toHaveLength(10);

    expect(
      cleanProps({
        ok: 'yes',
        'bad key': 1,
        ['x'.repeat(41)]: 1,
        nested: { a: 1 },
        list: [1, 2],
        nan: Number.NaN,
        long: 'v'.repeat(150),
        'a.b-c_d': false,
      }),
    ).toEqual({ ok: 'yes', long: 'v'.repeat(100), 'a.b-c_d': 'false' });

    expect(cleanProps(undefined)).toEqual({});
    expect(cleanProps([1])).toBeNull();
    expect(cleanProps('x')).toBeNull();
  });

  it('rejects malformed bodies and unknown sites', async () => {
    expect((await send({ site: 'disktree', props: [1] })).status).toBe(400);
    expect((await send({ site: 'disktree', user_id: { id: 1 } })).status).toBe(400);
    expect((await send({ site: 'disktree', app_version: 3 })).status).toBe(400);
    expect((await send({ name: 'x' })).status).toBe(400);
    expect((await send('not json')).status).toBe(400);
    expect((await send({ site: 'nope' })).status).toBe(404);
    expect(await storedRows()).toHaveLength(0);
  });

  it('batches: one request, a segment per user, client times honoured only within today', async () => {
    const response = await sendBatch({
      site: 'disktree',
      events: [
        { name: 'screen_view', path: '/home', user_id: 'u1', v: '2.3.1', ts: ts(`${TODAY}T10:00:00Z`) },
        { name: 'purchase', path: '/home', user_id: 'u1', v: '2.3.1', props: { plan: 'pro' }, ts: ts(`${TODAY}T10:01:00Z`) },
        { name: 'late', user_id: 'u1', v: '2.3.1', ts: ts(`${DAY2}T23:00:00Z`) },
        { name: 'future', user_id: 'u1', v: '2.3.1', ts: ts(`${TODAY}T18:00:00Z`) },
        { name: 'screen_view', path: '/other', user_id: 'u2', v: '2.3.1' },
      ],
    });
    expect(response.status).toBe(204);

    const rows = await storedRows();
    // Two users, two segments: one row each, not one per event.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.batch !== '')?.pv).toBe(1);

    const now = ts(`${TODAY}T12:00:00Z`);
    const events = await storedEvents();
    expect(events.map((e) => [e.ts, e.name])).toEqual([
      [ts(`${TODAY}T10:00:00Z`), 'pageview'],
      [ts(`${TODAY}T10:01:00Z`), 'purchase'],
      [now, 'future'],
      [now, 'late'],
      [now, 'pageview'],
    ]);
    expect(events.find((e) => e.name === 'purchase')?.props).toBe('{"plan":"pro"}');
  });

  it('validates a batch as a whole', async () => {
    const one = { name: 'x', user_id: 'u1' };
    expect((await sendBatch({ site: 'disktree', events: [] })).status).toBe(400);
    expect((await sendBatch({ site: 'disktree', events: Array.from({ length: 51 }, () => one) })).status).toBe(400);
    expect((await sendBatch({ site: 'disktree', events: [one, { ...one, props: 'x' }] })).status).toBe(400);
    expect((await sendBatch({ site: 'disktree', events: [one, { ...one, ts: 'soon' }] })).status).toBe(400);
    expect((await sendBatch({ site: 'nope', events: [one] })).status).toBe(404);
    expect(await storedRows()).toHaveLength(0);

    expect((await sendBatch({ site: 'disktree', events: Array.from({ length: 50 }, () => one) })).status).toBe(204);
    expect(await storedRows()).toHaveLength(1);
  });

  it('is routed and answers CORS', async () => {
    const response = await SELF.fetch(
      request('/api/events/batch', { site: 'disktree', events: [{ name: 'open', user_id: 'u1' }] }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

/* -------------------------------------------------------------- identity -- */

describe('app identity', () => {
  it('never stores the raw user id, anywhere', async () => {
    await send({ site: 'disktree', user_id: 'install-SECRET-42' });
    await sendBatch({ site: 'disktree', events: [{ name: 'open', user_id: 'install-SECRET-42' }] });
    await rollupDay(db, TODAY);

    const { results: tables } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'")
      .all<{ name: string }>();
    for (const { name } of tables) {
      const { results } = await db.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(results), name).not.toContain('install-SECRET-42');
    }
  });

  it('keeps a uid stable across days and sites apart, while the visitor hash rotates daily', async () => {
    at(`${DAY1}T09:00:00Z`);
    await send({ site: 'disktree', user_id: 'same' });
    at(`${DAY2}T09:00:00Z`);
    await send({ site: 'disktree', user_id: 'same' });
    await send({ site: 'omasend', user_id: 'same' });

    const [first, second, other] = await storedRows();
    expect(first!.uid).toBe(second!.uid);
    expect(first!.visitor).not.toBe(second!.visitor);
    expect(other!.uid).not.toBe(second!.uid);

    // Keyed by a per-site secret that lives only in the database.
    const secret = await db.prepare("SELECT value FROM settings WHERE key = 'uid_secret:3'").first<{ value: string }>();
    expect(secret?.value).toMatch(/^[0-9a-f]{64}$/);
    const plain = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('same'));
    expect(first!.uid).not.toBe([...new Uint8Array(plain)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join(''));
  });

  it('changes nothing for events without a user id', async () => {
    await send({ site: 'example.com', url: 'https://example.com/' });
    const [row] = await storedRows();
    expect(row!.uid).toBe('');
    const salt = await getDailySalt(db, TODAY);
    expect(row!.visitor).toBe(await visitorHash(salt, 2, '198.51.100.7', UA));
  });
});

/* --------------------------------------------------------------- rollups -- */

/** Each user opens the home screen and buys a plan. */
async function day(iso: string, users: Record<string, string>): Promise<void> {
  at(iso);
  for (const [user, plan] of Object.entries(users)) {
    await sendBatch({
      site: 'disktree',
      events: [
        { name: 'screen_view', path: '/home', user_id: user, v: plan === 'pro' ? '2.4.0' : '2.3.1' },
        { name: 'purchase', path: '/home', user_id: user, v: plan === 'pro' ? '2.4.0' : '2.3.1', props: { plan } },
      ],
    });
  }
}

async function appDay(dayId: string): Promise<{ active: string[]; new: string[]; props: unknown } | null> {
  const row = await db
    .prepare('SELECT active, new, props FROM app_daily WHERE site_id = 1 AND day = ?')
    .bind(dayId)
    .first<{ active: string; new: string; props: string }>();
  return row && { active: JSON.parse(row.active), new: JSON.parse(row.new), props: JSON.parse(row.props) };
}

describe('app rollups', () => {
  beforeEach(async () => {
    await day(`${DAY1}T09:00:00Z`, { alice: 'pro', bob: 'free' });
    await day(`${DAY2}T09:00:00Z`, { alice: 'pro', carol: 'pro' });
    at(`${TODAY}T00:30:00Z`);
    await rollupDay(db, DAY1);
    await rollupDay(db, DAY2);
  });

  it('records active and first-seen users per day', async () => {
    const one = await appDay(DAY1);
    const two = await appDay(DAY2);
    expect(one?.active).toHaveLength(2);
    expect(one?.new).toHaveLength(2);
    expect(two?.active).toHaveLength(2);
    expect(two?.new).toHaveLength(1);
    // alice is in both days' active lists but new only on the first.
    const alice = one!.active.find((uid) => two!.active.includes(uid));
    expect(two!.new).not.toContain(alice);

    const { results } = await db.prepare('SELECT uid, first_day FROM app_users ORDER BY first_day').all<{ uid: string; first_day: string }>();
    expect(results.map((r) => r.first_day)).toEqual([DAY1, DAY1, DAY2]);
    expect(results.find((r) => r.uid === alice)?.first_day).toBe(DAY1);
  });

  it('counts event properties per value with their users', async () => {
    expect((await appDay(DAY1))?.props).toEqual({ purchase: { plan: { pro: [1, 1], free: [1, 1] } } });
    expect((await appDay(DAY2))?.props).toEqual({ purchase: { plan: { pro: [2, 2] } } });
  });

  it('folds a day again without moving anyone first day', async () => {
    // A straggler lands in an already-rolled day; folding it again must keep
    // the day's new users new, and add only the straggler.
    await day(`${DAY2}T23:59:00Z`, { dave: 'free' });
    at(`${TODAY}T01:00:00Z`);
    await rollupDay(db, DAY2);
    const two = await appDay(DAY2);
    // The day's raw tables were dropped by the first rollup, so the re-fold
    // sees only the straggler — and must not mark anyone else as returning.
    expect(two?.new).toHaveLength(1);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM app_users').first<{ n: number }>();
    expect(count?.n).toBe(4);
  });

  it('makes app_version a dimension: ranked, and filterable from the cube and from raw', async () => {
    const window = { from: DAY1, to: DAY2 };
    const now = new Date(`${TODAY}T12:00:00Z`);
    expect(await loadBreakdown(db, 1, window, [], 'app_version', 10, now)).toEqual([
      { name: '2.4.0', value: 3, visits: 3 },
      { name: '2.3.1', value: 1, visits: 1 },
    ]);
    const pro = await loadTotals(db, 1, DAY1, DAY2, [{ dim: 'app_version', value: '2.4.0' }], now);
    expect(pro.views).toBe(3);
    const byVersion = await loadBreakdown(db, 1, window, [{ dim: 'app_version', value: '2.3.1' }], 'event', 10, now);
    expect(byVersion).toEqual([{ name: 'purchase', value: 1, visits: 1 }]);

    await day(`${TODAY}T11:00:00Z`, { erin: 'pro', frank: 'free' });
    const today = await loadTotals(db, 1, TODAY, TODAY, [{ dim: 'app_version', value: '2.4.0' }], now);
    expect(today.views).toBe(1);
  });
});

/* ------------------------------------------------------------- endpoints -- */

async function ownerToken(): Promise<string> {
  const owner = await ensureAdminAccount(db, 'owner@example.com');
  return createSession(db, owner!.id);
}

async function get(path: string, token?: string): Promise<Response> {
  return SELF.fetch(`https://analytics.example.com${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('app analytics endpoints', () => {
  beforeEach(async () => {
    await day(`${DAY1}T09:00:00Z`, { alice: 'pro', bob: 'free' });
    await day(`${DAY2}T09:00:00Z`, { alice: 'pro', carol: 'pro' });
    at(`${TODAY}T00:30:00Z`);
    await rollupDay(db, DAY1);
    await rollupDay(db, DAY2);
    await day(`${TODAY}T11:00:00Z`, { alice: 'free', dave: 'pro' });
    at(`${TODAY}T12:00:00Z`);
  });

  it('reports daily, new, weekly and monthly active users, today included', async () => {
    const response = await get('/api/active-users?site=1&range=7d', await ownerToken());
    expect(response.status).toBe(200);
    const body = await response.json<{
      tracked: boolean;
      labels: string[];
      dau: number[];
      new: number[];
      totals: { active: number; new: number };
      wau: number;
      mau: number;
    }>();
    expect(body.tracked).toBe(true);
    expect(body.labels).toHaveLength(7);
    expect(body.labels.slice(-3)).toEqual([DAY1, DAY2, TODAY]);
    expect(body.dau.slice(-3)).toEqual([2, 2, 2]);
    expect(body.new.slice(-3)).toEqual([2, 1, 1]);
    expect(body.totals).toEqual({ active: 4, new: 4 });
    expect(body.wau).toBe(4);
    expect(body.mau).toBe(4);
  });

  it('says a web-only site is not tracked', async () => {
    const body = await (await get('/api/active-users?site=2&range=30d', await ownerToken())).json<{ tracked: boolean; mau: number }>();
    expect(body).toMatchObject({ tracked: false, mau: 0 });
  });

  it('builds day and week retention cohorts', async () => {
    const token = await ownerToken();
    const daily = await (await get('/api/retention?site=1&cohort=day&periods=3', token)).json<{
      tracked: boolean;
      cohorts: { label: string; size: number; retained: number[] }[];
    }>();
    expect(daily.tracked).toBe(true);
    expect(daily.cohorts).toEqual([
      { label: DAY1, size: 2, retained: [2, 1, 1] },
      { label: DAY2, size: 1, retained: [1, 0] },
      { label: TODAY, size: 1, retained: [1] },
    ]);

    // 2026-03-08 is a Sunday: its week starts 2026-03-02; the 9th and 10th
    // are the next week.
    const weekly = await (await get('/api/retention?site=1&cohort=week&periods=2', token)).json<{
      cohorts: { label: string; size: number; retained: number[] }[];
    }>();
    expect(weekly.cohorts).toEqual([
      { label: '2026-03-02', size: 2, retained: [2, 1] },
      { label: '2026-03-09', size: 2, retained: [2] },
    ]);

    expect((await get('/api/retention?site=1&cohort=month', token)).status).toBe(400);
  });

  it('lists custom events and their properties across rolled-up days and today', async () => {
    const token = await ownerToken();
    const events = await (await get('/api/events?site=1&range=7d', token)).json<{ events: { name: string; count: number; users: number }[] }>();
    expect(events.events).toEqual([{ name: 'purchase', count: 6, users: 6 }]);

    const filtered = await (
      await get(`/api/events?site=1&range=7d&f=${encodeURIComponent('app_version:2.3.1')}`, token)
    ).json<{ events: { name: string; count: number }[] }>();
    expect(filtered.events).toEqual([{ name: 'purchase', count: 2, users: 2 }]);

    const keys = await (await get('/api/event-properties?site=1&range=7d&event=purchase', token)).json();
    expect(keys).toEqual({ keys: [{ key: 'plan', count: 6 }] });

    const values = await (await get('/api/event-properties?site=1&range=7d&event=purchase&key=plan', token)).json();
    expect(values).toEqual({ values: [{ name: 'pro', value: 4 }, { name: 'free', value: 2 }] });

    expect((await get('/api/event-properties?site=1&range=7d', token)).status).toBe(400);

    // Folded, today's share comes from the hour's packed counts instead.
    await rollupHour(db, 'ev_2026031011');
    expect(await (await get('/api/event-properties?site=1&range=7d&event=purchase', token)).json()).toEqual(keys);
    expect(await (await get('/api/event-properties?site=1&range=7d&event=purchase&key=plan', token)).json()).toEqual(values);
  });

  it("answers today's visits the same from the merged state as from raw rows", async () => {
    const token = await ownerToken();
    const read = async (q: string): Promise<unknown> => (await get(`/api/${q}`, token)).json();
    const queries = [
      'summary?site=1&range=today',
      'summary?site=1&range=7d',
      'breakdown?site=1&range=today&dim=entry,exit,app_version',
      `breakdown?site=1&range=today&dim=entry,exit,app_version&f=${encodeURIComponent('app_version:2.4.0')}`,
      `summary?site=1&range=7d&f=${encodeURIComponent('app_version:2.4.0')}`,
    ];
    const raw = await Promise.all(queries.map(read));

    // 11:00 folded into today_visits; alice comes back at 13:00 on another
    // screen, so her visit spans the folded hour and the live one.
    await rollupHour(db, 'ev_2026031011');
    const state = await db.prepare('SELECT through, json_array_length(visits) AS n FROM today_visits WHERE site_id = 1').first();
    expect(state).toEqual({ through: `${TODAY}T11`, n: 2 });
    expect(await Promise.all(queries.map(read))).toEqual(raw);

    at(`${TODAY}T13:10:00Z`);
    await sendBatch({ site: 'disktree', events: [{ name: 'screen_view', path: '/settings', user_id: 'alice', v: '2.3.1' }] });
    const live = await Promise.all(queries.map(read));
    const exits = (live[2] as { breakdowns: Record<string, { name: string }[]> }).breakdowns.exit!.map((r) => r.name);
    expect(exits).toContain('/settings');

    // A second fold of the same hour cannot be merged twice: the state is
    // given up and the same answers come from raw rows again.
    await rollupHour(db, 'ef_2026031011');
    expect(await db.prepare('SELECT visits FROM today_visits WHERE site_id = 1').first()).toEqual({ visits: null });
    expect(await Promise.all(queries.map(read))).toEqual(live);
  });

  it('charts one event over time: finished days, today by hour folded or not, and filtered', async () => {
    const token = await ownerToken();
    type Series = { granularity: string; labels: string[]; count: number[]; users: number[] };
    const week = await (await get('/api/event-series?site=1&range=7d&event=purchase', token)).json<Series>();
    expect(week.granularity).toBe('day');
    expect(week.labels).toHaveLength(7);
    expect(week.labels.slice(-3)).toEqual([DAY1, DAY2, TODAY]);
    expect(week.count.slice(-3)).toEqual([2, 2, 2]);
    expect(week.users.slice(-3)).toEqual([2, 2, 2]);
    expect(week.count.slice(0, 4)).toEqual([0, 0, 0, 0]);

    const free = await (
      await get(`/api/event-series?site=1&range=7d&event=purchase&f=${encodeURIComponent('app_version:2.3.1')}`, token)
    ).json<Series>();
    expect(free.count.slice(-3)).toEqual([1, 0, 1]);
    expect(free.users.slice(-3)).toEqual([1, 0, 1]);

    const hourly = async (): Promise<Series> =>
      (await get('/api/event-series?site=1&range=today&event=purchase', token)).json<Series>();
    const raw = await hourly();
    expect(raw.granularity).toBe('hour');
    expect(raw.labels).toHaveLength(13);
    expect(raw.count[11]).toBe(2);
    expect(raw.users[11]).toBe(2);
    expect(raw.count.reduce((a, b) => a + b, 0)).toBe(2);

    // Once the hour is folded the same answer comes from its packed row.
    await rollupHour(db, 'ev_2026031011');
    expect(await hourly()).toEqual(raw);

    const none = await (await get('/api/event-series?site=1&range=7d&event=nope', token)).json<Series>();
    expect(none.count).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect((await get('/api/event-series?site=1&range=7d', token)).status).toBe(400);
    expect((await get('/api/event-series?site=1&range=90d&event=purchase&f=country:DE', token)).status).toBe(400);
  });

  it('applies the same access checks as every other report', async () => {
    expect((await get('/api/active-users?site=1&range=7d')).status).toBe(401);
    const viewer = await createUser(db, { email: 'viewer@example.com', siteIds: [2] });
    const token = await createSession(db, viewer!.id);
    expect((await get('/api/active-users?site=1&range=7d', token)).status).toBe(403);
    expect((await get('/api/retention?site=1', token)).status).toBe(403);
    expect((await get('/api/events?site=2&range=7d', token)).status).toBe(200);
  });
});

/* -------------------------------------------------------------- upgrades -- */

describe('storage from older builds', () => {
  it('reads and writes an hour table created before the app columns existed', async () => {
    const suffix = partsFor(new Date()).suffix;
    const table = rawTable(suffix);
    await db
      .prepare(
        `CREATE TABLE ${table} (site_id INTEGER NOT NULL, ts INTEGER NOT NULL, visitor TEXT NOT NULL,
         name TEXT NOT NULL, path TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '',
         country TEXT NOT NULL DEFAULT '', browser TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '',
         device TEXT NOT NULL DEFAULT '', screen TEXT NOT NULL DEFAULT '', utm_source TEXT NOT NULL DEFAULT '',
         utm_medium TEXT NOT NULL DEFAULT '', utm_campaign TEXT NOT NULL DEFAULT '')`,
      )
      .run();
    await db
      .prepare(`INSERT INTO ${table} (site_id, ts, visitor, name, path) VALUES (2, ?, 'old', 'pageview', '/legacy')`)
      .bind(ts(`${TODAY}T12:00:00Z`))
      .run();

    const now = new Date();
    // A reader of the in-flight legacy hour widens it rather than failing…
    expect((await loadTotals(db, 2, TODAY, TODAY, [], now)).views).toBe(1);
    // …and so does a batch landing in it.
    expect((await sendBatch({ site: 'example.com', events: [{ path: '/a' }, { path: '/b' }] })).status).toBe(204);
    expect((await loadTotals(db, 2, TODAY, TODAY, [], now)).views).toBe(3);

    at(`${'2026-03-11'}T00:30:00Z`);
    await rollupDay(db, TODAY);
    const daily = await db
      .prepare("SELECT pageviews FROM stats_daily WHERE site_id = 2 AND day = ? AND dim = '_total'")
      .bind(TODAY)
      .first<{ pageviews: number }>();
    expect(daily?.pageviews).toBe(3);
  });

  it('reads filtered history from both cube generations without double counting', async () => {
    // A day from before the upgrade, in the old cube, which has no app_version.
    await db
      .prepare(
        `INSERT INTO stats_cube (site_id, day, name, path, ref, country, browser, os, device, screen,
           utm_source, utm_medium, utm_campaign, pageviews, visitors, entrances, exits, bounces, duration)
         VALUES (1, ?, 'pageview', '/home', '', 'DE', 'App', 'iOS', 'Mobile', '', '', '', '', 5, 5, 5, 5, 5, 0)`,
      )
      .bind(DAY1)
      .run();

    // The first rollup after the upgrade records where stats_cube2 begins.
    await day(`${DAY2}T09:00:00Z`, { alice: 'pro' });
    at(`${TODAY}T00:30:00Z`);
    await rollupDay(db, DAY2);
    const cutoff = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(SETTING_CUBE2_FROM).first<{ value: string }>();
    expect(cutoff?.value).toBe(DAY2);

    const now = new Date(`${TODAY}T12:00:00Z`);
    const filters = [{ dim: 'path', value: '/home' }];
    expect((await loadTotals(db, 1, DAY1, DAY2, filters, now)).views).toBe(6);
    // Old days have no app_version, so filtering by one only finds new days.
    expect((await loadTotals(db, 1, DAY1, DAY2, [{ dim: 'app_version', value: '2.4.0' }], now)).views).toBe(1);

    // A pre-set cutoff (an instance that already wrote cube2) is respected.
    await setSetting(db, SETTING_CUBE2_FROM, DAY1);
    expect((await loadTotals(db, 1, DAY1, DAY2, filters, now)).views).toBe(1);
  });
});

describe('user sketches', () => {
  // Stored uids are hex digests, which is what the sketch hashes on.
  const uid = async (n: number): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`user-${n}`));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  };

  it('counts small sets exactly and large ones within a few percent, merged across days', async () => {
    const small = newSketch();
    addToSketch(small, await Promise.all([1, 2, 3, 3, 2].map(uid)));
    expect(estimateSketch(small)).toBe(3);

    // Thirty days of 2,000 users each, half of them returning every day.
    const month = newSketch();
    for (let day = 0; day < 30; day += 1) {
      const sketch = newSketch();
      const ids = await Promise.all(
        Array.from({ length: 2000 }, (_, i) => uid(i < 1000 ? i : 1000 + day * 1000 + i)),
      );
      addToSketch(sketch, ids);
      // Each day's sketch goes through its stored form, as the rollup does.
      mergeSketch(month, encodeSketch(sketch));
    }
    const truth = 1000 + 30 * 1000;
    expect(Math.abs(estimateSketch(month) - truth) / truth).toBeLessThan(0.05);
  });
});
