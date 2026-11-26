/**
 * A day in the life of a full fleet, metered against the free plan.
 *
 * One hundred sites on one account:
 *   - 6 apps with 300 to 2,000 daily users each (6,300 in all, about 85% of
 *     them returning users already in app_users — see NEW_USER_SHARE), every
 *     user using the app in one to three sessions of 1 to 30 minutes, sending
 *     screen views and custom events with properties through
 *     POST /api/events/batch. The requests are the ones the shipped SDK makes:
 *     every user's events go through the real queue (sdk/js/src/core.ts, which
 *     sdk/nsh shares verbatim) on a virtual clock, so its flush timer, batch
 *     cap and background flush decide how many requests a session costs;
 *   - 6 websites with a few hundred pageviews a day, one request each;
 *   - 88 idle sites with 0 to 30 pageviews a day;
 *   - the cron every ten minutes and the 00:25 backstop, as wrangler.jsonc
 *     schedules them, through the real `scheduled` handler: each fold unit it
 *     plans goes through the SELF binding to POST /internal/fold, and each of
 *     those is a Worker request, counted as one;
 *   - one person with the console open for eight hours: the realtime panel
 *     polling every 30 seconds with the previous answer's cursor, and forty
 *     loads of the screens the app has, as the requests app/api.ts builds for
 *     them (asserted below), across today, 7, 30 and 90 days and 12 months,
 *     some of them filtered.
 *
 * Every request goes through the real Worker (`worker.fetch`, middleware and
 * all), with the D1 binding wrapped so each statement's `meta.rows_read` /
 * `meta.rows_written` — the numbers D1 bills — is added up. The day must stay
 * under TARGET (half of each free-plan limit) and under the design's own caps
 * (DESIGN_CAPS), both in src/budget.ts, and each part under its ceiling.
 *
 * History. Two years of a full fleet cannot be simulated here in reasonable
 * time, so the cost over finished days is measured separately: the day's
 * level-0 block of each site — written by the real nightly run — is copied onto
 * the 729 days before it, the higher dyadic levels are built from those with
 * the same merge the nightly run uses (src/blocks.ts), and the same loads are
 * replayed against that history. Their reads and writes are added to the day's
 * totals; their requests are not (the day already counted them).
 *
 * If this test fails, make the change cheaper. Never raise TARGET or the caps.
 */

import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DESIGN_CAPS, FREE_PLAN, TARGET, overDesignCaps, overTarget, shareOfTarget, type DailyUsage } from '../src/budget';
import { SETTING_BLOCKS_FROM, ensureSchema, listRawTables, setSetting } from '../src/db';
import worker from '../src/index';
import { createSession } from '../src/sessions';
import { ensureAdminAccount } from '../src/users';
import { siteUidSecret, uidFor } from '../src/visitor';
import { shiftDay } from '../src/query';
import { type BlockCore, type UserSet, MAX_LEVEL, blockStatement, clearBlockCache, decodeUserSet, encodeUserSet, mergeBlockProps, mergeCores, unionUsers } from '../src/blocks';
import { type DayState, dayNumber, dayString } from '../src/fold';
import { resetBlocksFromCache } from '../src/state';
import { clearSiteCache } from '../src/ingest';
import { clearTodayMemo } from '../src/reads';
import { type Platform, createClient } from '../sdk/js/src/core';
import { type TransportRequest, createApi } from '../app/api';

/* ----------------------------------------------------------------- meter -- */

interface Tally {
  requests: number;
  rowsRead: number;
  rowsWritten: number;
  statements: number;
  /** Of rowsWritten, what schema changes (the hourly rename) wrote. */
  ddlWritten: number;
}

const blank = (): Tally => ({ requests: 0, rowsRead: 0, rowsWritten: 0, statements: 0, ddlWritten: 0 });

/** Where the statements currently running are billed to. */
let bucket: Tally = blank();

/** Reads per statement shape, for finding what to make cheaper (set DEBUG_SQL). */
const DEBUG_SQL = false;
const bySql = new Map<string, { n: number; read: number; written: number }>();
let currentName = '';

function bill(meta: { rows_read?: number; rows_written?: number } | undefined, sql = ''): void {
  if (DEBUG_SQL) {
    const key = `${currentName} | ${sql.replace(/\s+/g, ' ').slice(0, 140)}`;
    const entry = bySql.get(key) ?? { n: 0, read: 0, written: 0 };
    entry.n += 1;
    entry.read += meta?.rows_read ?? 0;
    entry.written += meta?.rows_written ?? 0;
    bySql.set(key, entry);
  }
  bucket.statements += 1;
  bucket.rowsRead += meta?.rows_read ?? 0;
  bucket.rowsWritten += meta?.rows_written ?? 0;
  if (/^\s*(ALTER|CREATE|DROP)\b/i.test(sql)) bucket.ddlWritten += meta?.rows_written ?? 0;
  if (/\bFROM blocks\b/i.test(sql)) blockRows += meta?.rows_read ?? 0;
}

/**
 * A D1 statement that bills what it runs.
 *
 * `first()` is answered through `all()`, because only `all()` and `run()`
 * return the meta D1 bills by; it reads the same rows either way.
 */
class MeteredStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): MeteredStatement {
    return new MeteredStatement(this.inner.bind(...values), this.sql);
  }

  async all<T>(): Promise<D1Result<T>> {
    const result = await this.inner.all<T>();
    bill(result.meta, this.sql);
    return result;
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = await this.inner.run<T>();
    bill(result.meta, this.sql);
    return result;
  }

  async first<T>(column?: string): Promise<T | null> {
    const { results } = await this.all<Record<string, unknown>>();
    const row = results[0];
    if (row === undefined) return null;
    return (column === undefined ? row : (row[column] ?? null)) as T;
  }

  raw(): never {
    throw new Error('raw() is not metered; nothing in src/ should use it');
  }
}

function metered(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => new MeteredStatement(target.prepare(sql), sql);
      }
      if (property === 'batch') {
        return async (statements: MeteredStatement[]) => {
          const results = await target.batch(statements.map((s) => s.inner));
          results.forEach((result, i) => bill(result.meta, statements[i]!.sql));
          return results;
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
}

const db = env.DB;

/* ---------------------------------------------------------------- random -- */

/** mulberry32: a seeded generator, so the simulated day is the same every run. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = generator(20261126);
const between = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
const choose = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

/* ----------------------------------------------------------------- fleet -- */

const DAY = '2026-03-10';
const DAY_START = Date.parse(`${DAY}T00:00:00Z`) / 1000;
const NEXT_DAY = '2026-03-11';

const APP_DAU = [300, 500, 800, 1200, 1500, 2000];
const WEB_PAGEVIEWS = [200, 300, 400, 500, 600, 700];
const IDLE_SITES = 88;
/** Console loads over the eight hours (buildLoads). */
const LOADS = 40;

const SCREENS = ['/home', '/library', '/player', '/search', '/settings', '/profile', '/share', '/onboarding'];
const PATHS = ['/', '/pricing', '/docs', '/blog', '/about', '/changelog', '/docs/install', '/blog/launch'];
const REFERRERS = ['', '', '', 'https://www.google.com/', 'https://news.ycombinator.com/', 'https://x.com/'];
const COUNTRIES = ['US', 'US', 'US', 'DE', 'GB', 'JP', 'BR', 'IN', 'FR', 'CA', 'SG', 'HK', 'AU', 'NL', 'KR'];
const VERSIONS = ['2.3.1', '2.4.0', '2.4.0', '2.5.0-beta'];
const PHONES = [
  'Disktree/2.4 (iPhone; iOS 17.4)',
  'Disktree/2.4 (Linux; Android 14; Pixel 8)',
  'Disktree/2.4 (Macintosh; macOS 14.4)',
];
const BROWSERS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
];

interface Site {
  id: number;
  name: string;
  kind: 'app' | 'web' | 'idle';
}

const sites: Site[] = [
  ...APP_DAU.map((_, i) => ({ id: i + 1, name: `app${i + 1}`, kind: 'app' as const })),
  ...WEB_PAGEVIEWS.map((_, i) => ({ id: i + 7, name: `web${i + 1}.example`, kind: 'web' as const })),
  ...Array.from({ length: IDLE_SITES }, (_, i) => ({ id: i + 13, name: `idle${i + 1}.example`, kind: 'idle' as const })),
];

/** One thing that happens during the day, at a second of the day. */
type Happening =
  | { at: number; kind: 'batch'; site: Site; body: string; ua: string; ip: string; country: string; events: number }
  | { at: number; kind: 'pageview'; site: Site; body: unknown; ua: string; ip: string; country: string }
  | { at: number; kind: 'realtime' }
  | { at: number; kind: 'dashboard'; index: number };

/** One thing a user does in the app: a screen view or a custom event with properties. */
function appAction(client: ReturnType<typeof createClient>): void {
  const roll = random();
  const path = choose(SCREENS);
  if (roll < 0.45) client.screen(path);
  else if (roll < 0.75) client.track('tap', { button: choose(['play', 'pause', 'next', 'like', 'share', 'download']) });
  else if (roll < 0.9) client.track('search', { results: between(0, 40), source: choose(['bar', 'voice']) });
  else if (roll < 0.97) client.track('download', { quality: choose(['low', 'high', 'lossless']), size_mb: between(1, 90) });
  else client.track('purchase', { plan: choose(['monthly', 'yearly']), trial: random() < 0.3 });
}

/** Lets the SDK's promise chain (drain → fetch) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/**
 * One user's day in an app, through the real SDK queue on a virtual clock:
 * returns every request it made, at the second it made it.
 *
 * Sessions: three in four are short (1–8 minutes, a phone), one in four long
 * (10–30 minutes, a desktop app), with roughly one action every 30 to 90
 * seconds. Each ends with the app going to the background, which flushes.
 */
async function appUserRequests(site: Site, userId: string): Promise<{ at: number; body: string; events: number }[]> {
  const sent: { at: number; body: string; events: number }[] = [];
  let clock = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let hide: () => void = () => {};
  const platform: Platform = {
    fetch: async (_url, init) => {
      const body = String(init.body);
      sent.push({ at: Math.floor(clock), body, events: (JSON.parse(body) as { events: unknown[] }).events.length });
      return new Response(null, { status: 202 });
    },
    now: () => (DAY_START + clock) * 1000,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms / 1000, fn });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    onHide: (fn) => {
      hide = fn;
      return () => {};
    },
    randomId: () => `${userId}-anon`,
  };
  const advance = async (to: number): Promise<void> => {
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of timers) if (entry[1].at <= to && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
      await settle();
    }
    clock = to;
  };

  const client = createClient(
    { endpoint: 'https://analytics.example.com', site: site.name, userId, appVersion: choose(VERSIONS), ua: choose(PHONES) },
    platform,
  );
  const sessions = between(1, 3);
  const starts = Array.from({ length: sessions }, () => between(0, 86_399 - 31 * 60)).sort((a, b) => a - b);
  let free = 0;
  for (const planned of starts) {
    const start = Math.max(planned, free);
    const minutes = random() < 0.75 ? between(1, 8) : between(10, 30);
    const end = Math.min(start + minutes * 60, 86_399);
    if (start >= end) break;
    await advance(start);
    client.screen('/home');
    for (let t = start + between(30, 90); t < end; t += between(30, 90)) {
      await advance(t);
      appAction(client);
      await settle();
    }
    await advance(end);
    hide();
    await settle();
    free = end + 60;
  }
  await advance(86_399);
  await client.shutdown();
  return sent;
}
function ip(): string {
  return `${between(1, 223)}.${between(0, 255)}.${between(0, 255)}.${between(1, 254)}`;
}

async function plan(): Promise<{ happenings: Happening[]; appEvents: number; webPageviews: number; idlePageviews: number }> {
  const happenings: Happening[] = [];
  let appEventCount = 0;
  let webPageviews = 0;
  let idlePageviews = 0;

  for (const [index, dau] of APP_DAU.entries()) {
    const site = sites[index]!;
    for (let user = 0; user < dau; user += 1) {
      const address = ip();
      const country = choose(COUNTRIES);
      for (const request of await appUserRequests(site, `${site.name}-install-${user}`)) {
        appEventCount += request.events;
        happenings.push({
          at: request.at,
          kind: 'batch',
          site,
          body: request.body,
          ua: 'NsMetry-JS/0.1.0',
          ip: address,
          country,
          events: request.events,
        });
      }
    }
  }

  const web = (site: Site, pageviews: number): void => {
    let left = pageviews;
    while (left > 0) {
      // A visit: one to five pages a few seconds apart, from one browser.
      const views = Math.min(left, between(1, 5));
      const start = between(0, 86_000);
      const ua = choose(BROWSERS);
      const address = ip();
      const ref = choose(REFERRERS);
      const country = choose(COUNTRIES);
      for (let v = 0; v < views; v += 1) {
        happenings.push({
          at: start + v * between(5, 60),
          kind: 'pageview',
          site,
          body: { site: site.name, url: `https://${site.name}${choose(PATHS)}`, referrer: v === 0 ? ref : '' },
          ua,
          ip: address,
          country,
        });
      }
      left -= views;
    }
  };

  WEB_PAGEVIEWS.forEach((pageviews, i) => {
    web(sites[6 + i]!, pageviews);
    webPageviews += pageviews;
  });
  for (const site of sites.filter((s) => s.kind === 'idle')) {
    const pageviews = between(0, 30);
    web(site, pageviews);
    idlePageviews += pageviews;
  }

  // Eight hours of the console, 09:00 to 17:00.
  for (let at = 9 * 3600; at < 17 * 3600; at += 30) happenings.push({ at, kind: 'realtime' });
  for (let index = 0; index < LOADS; index += 1) {
    happenings.push({ at: 9 * 3600 + Math.floor((index + 0.5) * ((8 * 3600) / LOADS)), kind: 'dashboard', index });
  }

  happenings.sort((a, b) => a.at - b.at);
  return { happenings, appEvents: appEventCount, webPageviews, idlePageviews };
}

/**
 * The console's loads over the day, as app/api.ts builds them: the requests
 * are made by calling the app's own API client with a transport that records
 * the URL, so a change to what the app asks for changes what is measured.
 *
 *  - Overview: the summary with the previous period, and one breakdown of
 *    every card it shows (app/screens/insights).
 *  - One deeper screen in turn (geography, tech, pages, sources): its summary
 *    and its breakdown.
 *  - An app also opens Events (its list and its own summary, no comparison:
 *    events.tsx), every other time an event's detail (trend, property keys,
 *    one key's values), and Users (active users; every third time retention).
 *  - One load in four visits Settings, whose site list asks a 7-day breakdown.
 */
const OVERVIEW_DIMS = ['path', 'entry', 'exit', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'event', 'country', 'browser', 'os', 'device'] as const;
const DEEP: { dims: readonly string[]; limit: number }[] = [
  { dims: ['country'], limit: 50 },
  { dims: ['browser', 'os', 'device', 'screen', 'app_version'], limit: 20 },
  { dims: ['path', 'entry', 'exit'], limit: 50 },
  { dims: ['referrer', 'utm_source', 'utm_medium', 'utm_campaign'], limit: 50 },
];
type RangeId = 'today' | '7d' | '30d' | '90d' | '12mo';
const RANGE_DAYS: Record<RangeId, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90, '12mo': 365 };

/** The URL every app call makes, recorded instead of sent. */
function recordedApi(): { api: ReturnType<typeof createApi>; take: () => string[] } {
  let urls: string[] = [];
  const api = createApi({
    baseUrl: () => '',
    token: () => 'x',
    transport: async (req: TransportRequest) => {
      urls.push(req.url);
      return { status: 200, json: {} };
    },
  });
  return {
    api,
    take: () => {
      const out = urls;
      urls = [];
      return out;
    },
  };
}

interface Load {
  urls: string[];
  /** Days the load's ranges cover (for the block-rows ceiling). */
  days: number;
}

async function buildLoads(): Promise<Load[]> {
  const { api, take } = recordedApi();
  const loads: Load[] = [];
  for (let i = 0; i < LOADS; i += 1) {
    // Every range the app offers. The last four: 12 months on two apps and a
    // website, and a filtered 30 days on the largest app.
    const extra = i - 36;
    const range: RangeId = extra >= 0 ? (extra === 3 ? '30d' : '12mo') : (['today', '7d', '30d', 'today', '90d', '7d'] as const)[i % 6]!;
    const site = extra >= 0 ? [1, 7, 4, 6][extra]! : i % 3 === 2 ? 7 + (i % 6) : 1 + (i % 6);
    const filtered = extra >= 0 ? extra === 3 : i % 4 === 3;
    const filters = filtered ? [site <= 6 ? { dim: 'app_version', value: '2.4.0' } : { dim: 'path', value: '/pricing' }] : [];
    const scope = { site, range, filters, compare: true } as Parameters<typeof api.summary>[0];
    const plain = { ...scope, compare: false };
    await api.summary(scope);
    await api.breakdown(plain, [...OVERVIEW_DIMS] as never, 8);
    const deep = DEEP[i % DEEP.length]!;
    await api.summary(scope);
    await api.breakdown(plain, deep.dims as never, deep.limit);
    if (site <= 6) {
      await api.events(plain);
      await api.summary(plain);
      if (i % 2 === 0) {
        await api.eventSeries(plain, 'tap');
        await api.eventKeys(plain, 'tap');
        await api.eventValues(plain, 'tap', 'button', 10);
      }
      await api.activeUsers({ site, range } as never);
      if (i % 3 === 0) await api.retention(site, 'week', 8);
    }
    if (i % 4 === 1) await api.breakdown({ site, range: '7d' } as never, ['path', 'event'] as never, 1);
    loads.push({ urls: take(), days: RANGE_DAYS[range] });
  }
  return loads;
}

/**
 * Share of an app's daily users seen for the first time that day.
 *
 * The fleet is simulated on an ordinary day of apps that have been running
 * for a while, so most of today's users were first seen on an earlier day:
 * app_users already holds them (seeded unmetered, like the history below),
 * and the rollup writes a first-seen row only for the new ones. A day on
 * which every user is new costs one more row written per user — an app's
 * launch day, which is what the other half of the free plan is for.
 */
const NEW_USER_SHARE = 0.15;

async function seedReturningUsers(): Promise<void> {
  const insert = db.prepare('INSERT INTO app_users (site_id, uid, first_day) VALUES (?, ?, ?)');
  for (const [index, dau] of APP_DAU.entries()) {
    const site = sites[index]!;
    const secret = await siteUidSecret(db, site.id);
    const statements: D1PreparedStatement[] = [];
    for (let user = 0; user < dau; user += 1) {
      if (user % 100 < NEW_USER_SHARE * 100) continue;
      const uid = await uidFor(secret, site.id, `${site.name}-install-${user}`);
      statements.push(insert.bind(site.id, uid, shiftDay(DAY, -(1 + (user % 120)))));
    }
    for (let i = 0; i < statements.length; i += 200) await db.batch(statements.slice(i, i + 200));
  }
}

/* ----------------------------------------------------------------- drive -- */

let token = '';

/** Block rows (rows read from `blocks`) of the request running now. */
let blockRows = 0;
/** Per request: block rows read, and the bound for its ranges. */
const blockReads: { path: string; rows: number; bound: number }[] = [];

async function call(request: Request): Promise<Response> {
  bucket.requests += 1;
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, meteredEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Raw rows each fold unit folded (the CPU proxy: a unit folds at most 300). */
const unitRows: number[] = [];
/** Rows folded by a unit whose state write then lost (refolded later). */
let lost = 0;

/** The SELF binding: each unit is a real request to POST /internal/fold, counted as one. */
const self = {
  fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await call(new Request(String(input), init));
    const body = (await response.clone().json()) as { results?: { rows: number; written: boolean }[] };
    unitRows.push((body.results ?? []).reduce((n, r) => n + r.rows, 0));
    lost += (body.results ?? []).filter((r) => !r.written && r.rows > 0).reduce((n, r) => n + r.rows, 0);
    return response;
  },
};

const meteredEnv = { ...(env as unknown as Env), DB: metered(db), SELF: self } as unknown as Env;

function post(path: string, body: unknown, ua: string, address: string, country: string): Request {
  return new Request(`https://analytics.example.com${path}`, {
    method: 'POST',
    // What the SDK sends: text/plain (no CORS preflight) and a body as built.
    headers: { 'content-type': 'text/plain;charset=UTF-8', 'user-agent': ua, 'cf-connecting-ip': address },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    // What Cloudflare's edge attaches to every request; the country is a
    // dimension, so leaving it empty would make every rollup look cheaper.
    cf: { country },
  } as RequestInit);
}

function get(path: string): Request {
  return new Request(`https://analytics.example.com${path}`, { headers: { authorization: `Bearer ${token}` } });
}

/** One trigger of a cron, through the Worker's own scheduled handler. */
async function cron(expression: string): Promise<void> {
  bucket.requests += 1;
  const controller = createScheduledController({ scheduledTime: Date.now(), cron: expression });
  const ctx = createExecutionContext();
  await worker.scheduled(controller, meteredEnv, ctx);
  await waitOnExecutionContext(ctx);
}

const tallies = {
  appIngest: blank(),
  webIngest: blank(),
  idleIngest: blank(),
  fold: blank(),
  nightly: blank(),
  realtime: blank(),
  dashboardToday: blank(),
  dashboardHistory: blank(),
};
const quietCron = blank();

/** Each load's requests, made against the history (and their block rows). */
async function replay(load: Load): Promise<void> {
  for (const path of load.urls) {
    blockRows = 0;
    const response = await call(get(path));
    if (response.status >= 300) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    // Two levels per power of two on each side of the range, for the range and
    // its comparison, plus the handful of exact single-row reads.
    const days = Math.max(load.days * 2, 60);
    blockReads.push({ path, rows: blockRows, bound: 2 * Math.ceil(Math.log2(days)) * 2 + 40 });
  }
}

function at(second: number): void {
  vi.setSystemTime(new Date((DAY_START + second) * 1000));
}

async function expectOk(response: Response, what: string): Promise<void> {
  if (response.status >= 300) throw new Error(`${what}: ${response.status} ${await response.text()}`);
}

/** Days of history: the longest replayed load, 12mo with comparison, reads 730. */
const HISTORY_DAYS = 729;

/**
 * Copy each site's level-0 block of the day onto the HISTORY_DAYS days before
 * it (unmetered), then build every higher level over them the way the nightly
 * run does: cores side by side (mergeCores), users unioned, properties merged.
 */
async function copyHistory(): Promise<void> {
  const d = dayNumber(DAY);
  const { results: info } = await db.prepare('PRAGMA table_info(blocks)').all<{ name: string }>();
  const columns = info.map((c) => c.name);
  const select = columns.map((c) => (c === 'start' ? 't.start - k.n' : `t.${c}`)).join(', ');
  await db
    .prepare(
      `WITH RECURSIVE k(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM k WHERE n < ${HISTORY_DAYS})
       INSERT OR REPLACE INTO blocks (${columns.join(', ')}) SELECT ${select} FROM blocks t, k WHERE t.level = 0 AND t.start = ?`,
    )
    .bind(d)
    .run();
  const { results: siteRows } = await db
    .prepare('SELECT site_id, core, users, props FROM blocks WHERE level = 0 AND start = ?')
    .bind(d)
    .all<{ site_id: number; core: string; users: unknown; props: string }>();
  const first = d - HISTORY_DAYS;
  for (const row of siteRows) {
    let level = new Map<number, { core: BlockCore; users: UserSet; props: DayState['props'] }>();
    const day = { core: JSON.parse(row.core) as BlockCore, users: decodeUserSet(row.users), props: JSON.parse(row.props) as DayState['props'] };
    for (let s = first; s <= d; s += 1) level.set(s, day);
    for (let k = 1; k <= MAX_LEVEL; k += 1) {
      const half = 1 << (k - 1);
      const next = new Map<number, { core: BlockCore; users: UserSet; props: DayState['props'] }>();
      const statements: D1PreparedStatement[] = [];
      for (const [start, left] of level) {
        if (start % (1 << k) !== 0) continue;
        const right = level.get(start + half);
        if (!right) continue;
        const parent = {
          core: mergeCores(left.core, right.core, half),
          users: unionUsers([left.users, right.users]),
          props: mergeBlockProps(left.props, right.props),
        };
        next.set(start, parent);
        statements.push(
          blockStatement(db, row.site_id, k, start, { core: JSON.stringify(parent.core), users: encodeUserSet(parent.users), props: JSON.stringify(parent.props) }),
        );
      }
      for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
      level = next;
    }
  }
  clearBlockCache();
  clearTodayMemo();
}

let fleet: Awaited<ReturnType<typeof plan>>;
let loads: Load[];

async function resetDatabase(): Promise<void> {
  for (const table of await listRawTables(db)) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const table of ['stats_hourly', 'stats_daily', 'stats_cube', 'stats_cube2', 'today_visits', 'app_daily', 'app_users', 'day_state', 'blocks', 'site_access', 'sessions', 'users', 'sites', 'settings']) {
    try {
      await db.prepare(`DELETE FROM ${table}`).run();
    } catch (error) {
      if (!/no such table/i.test(String(error))) throw error;
    }
  }
  clearSiteCache();
  resetBlocksFromCache();
  clearBlockCache();
  clearTodayMemo();
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(-60);
  await ensureSchema(db);
  await resetDatabase();
  // Every day of the history and the day itself are the fold's (blocks), as
  // on an instance that has run this design for two years.
  await setSetting(db, SETTING_BLOCKS_FROM, shiftDay(DAY, -HISTORY_DAYS));
  resetBlocksFromCache();
  const insert = db.prepare('INSERT INTO sites (id, domain, created_at) VALUES (?, ?, 0)');
  await db.batch(sites.map((s) => insert.bind(s.id, s.name)));
  const owner = await ensureAdminAccount(db, 'owner@example.com');
  token = await createSession(db, owner!.id);
  fleet = await plan();
  loads = await buildLoads();
  await seedReturningUsers();

  // The day, in order, with the cron every ten minutes (wrangler.jsonc). Runs
  // from midnight to 00:30 of the next day finish the day: they are billed as
  // the nightly work, and so is the 00:25 backstop.
  let nextCron = 10 * 60;
  let cursor: string | null = null;
  const runCron = async (second: number): Promise<void> => {
    at(second);
    bucket = second >= 86_400 ? tallies.nightly : tallies.fold;
    currentName = second >= 86_400 ? 'nightly' : 'fold';
    await cron('*/10 * * * *');
  };
  for (const happening of fleet.happenings) {
    while (happening.at >= nextCron) {
      await runCron(nextCron);
      nextCron += 600;
    }
    at(happening.at);
    if (happening.kind === 'batch') {
      bucket = tallies.appIngest;
      currentName = 'appIngest';
      await expectOk(await call(post('/api/events/batch', happening.body, happening.ua, happening.ip, happening.country)), 'batch');
    } else if (happening.kind === 'pageview') {
      bucket = happening.site.kind === 'web' ? tallies.webIngest : tallies.idleIngest;
      currentName = 'ingest';
      await expectOk(await call(post('/api/event', happening.body, happening.ua, happening.ip, happening.country)), 'pageview');
    } else if (happening.kind === 'realtime') {
      bucket = tallies.realtime;
      currentName = 'realtime';
      // The first poll of the day has no cursor; every later one passes the last answer's.
      const response = await call(get(`/api/realtime?site=6${cursor ? `&since=${cursor}` : ''}`));
      await expectOk(response, 'realtime');
      cursor = ((await response.json()) as { cursor: string }).cursor;
    } else {
      bucket = tallies.dashboardToday;
      currentName = 'dashboardToday';
      for (const path of loads[happening.index]!.urls) await expectOk(await call(get(path)), path);
    }
  }
  while (nextCron <= 86_400 + 30 * 60) {
    if (nextCron === 86_400 + 30 * 60) {
      // 00:25, the backstop, falls between the 00:20 and 00:30 runs.
      at(86_400 + 25 * 60);
      bucket = tallies.nightly;
      currentName = 'nightly';
      await cron('25 0 * * *');
    }
    await runCron(nextCron);
    nextCron += 600;
  }

  // A run with nothing to fold anywhere, at 02:35 of the next day: what a
  // cron costs a fleet that sent nothing. Measured on its own.
  at(86_400 + 2 * 3600 + 35 * 60);
  bucket = quietCron;
  currentName = 'quietCron';
  resetBlocksFromCache();
  await cron('*/10 * * * *');
  quietCron.requests = 0;

  // History: two years of finished days, read by the same loads.
  bucket = blank();
  await copyHistory();
  at(86_400 + 9 * 3600);
  bucket = tallies.dashboardHistory;
  currentName = 'dashboardHistory';
  for (const load of loads) await replay(load);
  tallies.dashboardHistory.requests = 0;
}, 1_800_000);

afterAll(() => {
  vi.useRealTimers();
});

/* ---------------------------------------------------------------- verdict -- */

function dumpSql(): void {
  if (!DEBUG_SQL) return;
  const sorted = [...bySql].sort((a, b) => b[1].read - a[1].read).filter((e, i) => i < 60 || e[1].written > 0);
  for (const [sql, e] of sorted) console.log(`SQL ${e.read}\t${e.written}\t${e.n}\t${sql}`);
}

function total(): DailyUsage {
  const sum: DailyUsage = { requests: 0, rowsRead: 0, rowsWritten: 0 };
  for (const t of Object.values(tallies)) {
    sum.requests += t.requests;
    sum.rowsRead += t.rowsRead;
    sum.rowsWritten += t.rowsWritten;
  }
  return sum;
}

/** What each part of the day may read at most (rows), whatever the totals. */
const CEILINGS: Partial<Record<keyof typeof tallies, number>> = {
  fold: 80_000,
  nightly: 10_000,
  realtime: 20_000,
  dashboardToday: 60_000,
  dashboardHistory: 30_000,
};

describe('a full fleet on the free plan', () => {
  it('stays under TARGET and the design caps', () => {
    const day = total();
    for (const [name, t] of Object.entries(tallies)) console.log(JSON.stringify({ name, ...t }));
    dumpSql();
    console.log(
      JSON.stringify(
        {
          fleet: { appEvents: fleet.appEvents, webPageviews: fleet.webPageviews, idlePageviews: fleet.idlePageviews },
          day,
          freePlan: FREE_PLAN,
          target: TARGET,
          designCaps: DESIGN_CAPS,
          shareOfTarget: shareOfTarget(day),
          units: { count: unitRows.length, maxRows: Math.max(0, ...unitRows), folded: unitRows.reduce((a, b) => a + b, 0), lost },
          perRealtimePoll: tallies.realtime.rowsRead / tallies.realtime.requests,
          maxBlockRows: blockReads.reduce((m, r) => (r.rows > m.rows ? r : m), { path: '', rows: 0, bound: 0 }),
          quietCron,
        },
        null,
        2,
      ),
    );
    expect(overTarget(day)).toEqual([]);
    expect(overDesignCaps(day)).toEqual([]);
    if (DEBUG_SQL) throw new Error('debug report above (vitest shows console output of failing tests)');
  });

  it('keeps each part of the day under its ceiling', () => {
    for (const [name, ceiling] of Object.entries(CEILINGS)) {
      expect(tallies[name as keyof typeof tallies].rowsRead, name).toBeLessThanOrEqual(ceiling!);
    }
  });

  it('bounds the work of one request: 300 raw rows a unit, a few block rows per range', () => {
    expect(unitRows.length).toBeGreaterThan(0);
    expect(Math.max(...unitRows)).toBeLessThanOrEqual(300);
    for (const r of blockReads) expect(r.rows, r.path).toBeLessThanOrEqual(r.bound);
  });

  it('asks what app/api.ts asks', () => {
    const urls = loads.flatMap((l) => l.urls);
    expect(urls).toContain(
      `/api/breakdown?site=1&range=today&cmp=1`.replace('&cmp=1', '') + `&dim=${encodeURIComponent(OVERVIEW_DIMS.join(','))}&limit=8`,
    );
    expect(urls).toContain('/api/summary?site=1&range=today&cmp=1');
    expect(urls).toContain('/api/summary?site=1&range=today');
    expect(urls).toContain('/api/retention?site=1&cohort=week&periods=8');
    expect(urls.some((u) => u.startsWith('/api/breakdown?site=') && u.includes('range=7d') && u.endsWith(`&dim=${encodeURIComponent('path,event')}&limit=1`))).toBe(true);
  });

  it('writes at most one raw row per app flush, however many events it carries', () => {
    const batches = fleet.happenings.filter((h) => h.kind === 'batch').length;
    expect(tallies.appIngest.requests).toBe(batches);
    // Plus, once per app, its uid secret and the day's salt, and the DDL of
    // creating each hour's raw table (billed as schema rows, not per event).
    const data = tallies.appIngest.rowsWritten - tallies.appIngest.ddlWritten;
    expect(data).toBeLessThanOrEqual(batches + 2 * APP_DAU.length);
  });

  it('costs nothing when nothing was sent', () => {
    expect(quietCron.rowsWritten).toBe(0);
    expect(quietCron.rowsRead).toBeLessThanOrEqual(5);
  });

  it('turned the day into blocks completely', async () => {
    const d = dayNumber(DAY);
    const { results } = await db
      .prepare('SELECT site_id, core FROM blocks WHERE level = 0 AND start = ?')
      .bind(d)
      .all<{ site_id: number; core: string }>();
    const cores = results.map((r) => JSON.parse(r.core) as BlockCore);
    const views = cores.reduce((n, c) => n + (c.v.views[0] ?? 0), 0);
    const dau = cores.reduce((n, c) => n + (c.v.dau[0] ?? 0), 0);
    expect(views).toBeGreaterThan(fleet.webPageviews + fleet.idlePageviews);
    expect(dau).toBe(APP_DAU.reduce((a, b) => a + b, 0));
    const states = await db.prepare('SELECT DISTINCT day FROM day_state WHERE fmt > 0').all<{ day: number }>();
    expect(states.results.every((s) => s.day > d)).toBe(true);
    expect(dayString(d)).toBe(DAY);
    expect(NEXT_DAY > DAY).toBe(true);
  });
});
