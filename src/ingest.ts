/**
 * Event ingestion. Rows written is the free plan's hardest limit, so this path
 * does no UPDATEs, touches no indexed table, and never reads back what it just
 * wrote:
 *
 *   POST /api/event         one event           -> exactly one row
 *   POST /api/events/batch  up to 50 events     -> one row per *segment*
 *
 * A segment is the events of one batch that share a visitor and a device
 * profile — for an app flushing its queue, that is the whole batch. Writing it
 * as one row (see RAW_APP_COLUMNS in db.ts) is what lets a fleet of apps
 * sending a hundred thousand events a day fit in the free plan at all: one row
 * per event would spend the day's write budget on raw events alone.
 *
 * Both endpoints share every step that decides what an event *is* — field
 * names, validation, clamping, identity — so the two can never disagree.
 */

import { RAW_INSERT_COLUMNS, alterRawTable, createRawTableSql, rawTable } from './db';
import { partsForTs } from './time';
import { isBot, parseUa } from './ua';
import { getDailySalt, siteUidSecret, uidFor, userVisitorHash, visitorHash } from './visitor';

/** Beacon bodies are tiny; anything larger is not one of ours. */
const MAX_BODY_BYTES = 4096;
/** Fifty events at their largest legal size fit comfortably; nothing bigger is a batch. */
const MAX_BATCH_BYTES = 128 * 1024;
export const MAX_BATCH_EVENTS = 50;

const MAX_PATH_LENGTH = 512;
const MAX_FIELD_LENGTH = 255;
const MAX_NAME_LENGTH = 64;
const MAX_USER_ID_LENGTH = 256;
const MAX_VERSION_LENGTH = 32;

export const MAX_PROPS = 10;
const MAX_PROP_KEY = 40;
const MAX_PROP_VALUE = 100;
const PROP_KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * The beacon's own field names are one letter long because the browser script
 * sends one on every navigation. Anything calling the HTTP API by hand — an
 * app, a backend, an agent wiring up instrumentation — gets the readable
 * spelling of each field as well; both name the same column.
 */
type EventPayload = Record<string, unknown>;

/** First of `keys` that holds a string, so short and long spellings both work. */
function pick(payload: EventPayload, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** First of `keys` that is present at all, whatever its type. */
function present(payload: EventPayload, ...keys: string[]): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null) return payload[key];
  }
  return undefined;
}

/**
 * Where the event happened, as a URL.
 *
 * Browsers send `location.href`. An app has no URL, only a screen, so a bare
 * path — `/settings`, `/onboarding/step-2` — is accepted and resolved against a
 * placeholder origin that is thrown away straight after: only the pathname and
 * the utm_* parameters are ever read from it.
 */
function eventUrl(raw: string): URL | null {
  try {
    if (raw.startsWith('/')) return new URL(raw, 'app://nsmetry.invalid');
    return new URL(raw);
  } catch {
    return null;
  }
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
} as const;

function beaconResponse(status: number, message?: string): Response {
  return new Response(message ?? null, {
    status,
    headers: { ...CORS_HEADERS, 'cache-control': 'no-store' },
  });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeDomain(raw: string): string {
  return clamp(raw.trim().toLowerCase().replace(/^www\./, ''), MAX_FIELD_LENGTH);
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return clamp(trimmed === '' ? '/' : trimmed, MAX_PATH_LENGTH);
}

/**
 * Only the referrer's host is kept. Full referrer URLs routinely carry search
 * terms, session tokens and internal paths — storing them would undercut the
 * whole point of the project.
 */
function referrerHost(referrer: string, siteDomain: string): string {
  if (referrer === '') return '';
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    return host === siteDomain ? '' : clamp(host, MAX_FIELD_LENGTH);
  } catch {
    return '';
  }
}

/**
 * Screen width, kept as one of four buckets.
 *
 * The exact pixel width is a meaningful fingerprinting signal and we have no
 * use for it, so it is thrown away at the door rather than stored and bucketed
 * later.
 */
function screenBucket(raw: unknown): string {
  const width = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(width) || width <= 0) return '';
  if (width >= 1440) return '≥ 1440px';
  if (width >= 1024) return '1024–1439';
  if (width >= 768) return '768–1023';
  return '< 768px';
}

/**
 * Clean an event's properties, or null when they are not an object at all.
 *
 * Properties end up as rollup keys, so they are held to what a breakdown can
 * use: at most ten flat keys of a safe shape, each a short string, number or
 * boolean. Anything else — nested objects, arrays, long values, odd keys — is
 * dropped silently rather than failing the event, because an app that
 * attaches one bad property should still be counted. Every value is stored as
 * a string: a property is a label to group by, not a number to sum.
 */
export function cleanProps(raw: unknown): Record<string, string> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;

  const out: Record<string, string> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_PROPS) break;
    if (key.length > MAX_PROP_KEY || !PROP_KEY_PATTERN.test(key)) continue;

    let text: string;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
    else if (typeof value === 'boolean') text = value ? 'true' : 'false';
    else continue;

    out[key] = clamp(text, MAX_PROP_VALUE);
    kept++;
  }
  return out;
}

/** An event that passed validation, before it is given an identity. */
interface ParsedEvent {
  name: string;
  path: string;
  ref: string;
  screen: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  userAgent: string;
  userId: string;
  appVersion: string;
  props: Record<string, string>;
  /** Requested timestamp; only honoured by the batch endpoint. */
  ts: number | undefined;
}

type ParseResult = { ok: true; event: ParsedEvent } | { ok: false; status: number; message: string };

function invalid(message: string): ParseResult {
  return { ok: false, status: 400, message };
}

/**
 * Validate and normalise one event body. Shared by both endpoints.
 *
 * `fallbackUa` is the request's User-Agent (or a batch's top-level `ua`):
 * an app's HTTP client announces itself as `okhttp/4.12` or `CFNetwork`, which
 * says nothing about the device and trips the bot filter besides, so the body
 * may describe the device instead. That adds no capability the header did not
 * already grant: anyone can already send any User-Agent they like.
 */
function parseEvent(payload: unknown, siteDomain: string, fallbackUa: string): ParseResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return invalid('invalid payload');
  }
  const body = payload as EventPayload;

  const userAgent = clamp(pick(body, 'ua', 'user_agent') ?? fallbackUa, 512);

  const target = eventUrl(pick(body, 'u', 'url', 'path') ?? '/');
  if (!target) return invalid('invalid url');

  const rawName = pick(body, 'n', 'name')?.trim();
  // A screen view is an app's page view: same metric, same panels, one name.
  const name = !rawName || rawName === 'screen_view' ? 'pageview' : clamp(rawName, MAX_NAME_LENGTH);

  const rawUserId = present(body, 'user_id', 'uid');
  let userId = '';
  if (rawUserId !== undefined) {
    if (typeof rawUserId === 'number' && Number.isFinite(rawUserId)) userId = String(rawUserId);
    else if (typeof rawUserId === 'string') userId = rawUserId.trim();
    else return invalid('invalid user_id');
    if (userId.length > MAX_USER_ID_LENGTH) return invalid('invalid user_id');
  }

  const rawVersion = present(body, 'app_version', 'v');
  if (rawVersion !== undefined && typeof rawVersion !== 'string') return invalid('invalid app_version');
  const appVersion = clamp((rawVersion ?? '').trim(), MAX_VERSION_LENGTH);

  const props = cleanProps(present(body, 'props', 'p'));
  if (props === null) return invalid('invalid props');

  const rawTs = body.ts;
  if (rawTs !== undefined && rawTs !== null && (typeof rawTs !== 'number' || !Number.isFinite(rawTs))) {
    return invalid('invalid ts');
  }

  const params = target.searchParams;
  return {
    ok: true,
    event: {
      name,
      path: normalizePath(target.pathname),
      ref: referrerHost(pick(body, 'r', 'referrer') ?? '', siteDomain),
      screen: screenBucket(body.w ?? body.screen_width),
      utmSource: clamp(params.get('utm_source') ?? '', MAX_FIELD_LENGTH),
      utmMedium: clamp(params.get('utm_medium') ?? '', MAX_FIELD_LENGTH),
      utmCampaign: clamp(params.get('utm_campaign') ?? '', MAX_FIELD_LENGTH),
      userAgent,
      userId,
      appVersion,
      props,
      ts: typeof rawTs === 'number' ? Math.floor(rawTs) : undefined,
    },
  };
}

/** An event with its identity worked out: everything a row needs. */
interface IdentifiedEvent extends ParsedEvent {
  visitor: string;
  uid: string;
  browser: string;
  os: string;
  device: string;
  at: number;
}

/**
 * Give each event its visitor hash and, when it carried a user_id, its uid.
 *
 * Without a user_id nothing changes: the visitor is the daily ip+ua hash. With
 * one, the daily hash is derived from the id instead, and the uid is the
 * site-keyed pseudonym that active users and retention count. The raw id is
 * dropped here; nothing after this function ever sees it.
 */
async function identify(
  db: D1Database,
  siteId: number,
  events: ParsedEvent[],
  ip: string,
  now: number,
  honourTs: boolean,
): Promise<IdentifiedEvent[]> {
  const today = partsForTs(now).day;
  const salt = await getDailySalt(db, today);
  const secret = events.some((e) => e.userId !== '') ? await siteUidSecret(db, siteId) : '';
  const dayStart = Date.parse(`${today}T00:00:00Z`) / 1000;

  // Hashing is the only CPU this path spends, and a batch tends to repeat one
  // install's identity fifty times, so each distinct input is hashed once.
  const memo = new Map<string, Promise<string>>();
  const once = (key: string, make: () => Promise<string>): Promise<string> => {
    let hit = memo.get(key);
    if (!hit) {
      hit = make();
      memo.set(key, hit);
    }
    return hit;
  };

  return Promise.all(
    events.map(async (event) => {
      const visitor =
        event.userId !== ''
          ? await once(`v:u:${event.userId}`, () => userVisitorHash(salt, siteId, event.userId))
          : await once(`v:a:${event.userAgent}`, () => visitorHash(salt, siteId, ip, event.userAgent));
      const uid =
        event.userId !== '' ? await once(`u:${event.userId}`, () => uidFor(secret, siteId, event.userId)) : '';
      // A client's clock is only trusted inside the day this request lands in:
      // the raw table it goes into belongs to today, and the day's rollup has
      // already been written for every day before it.
      const at = honourTs && event.ts !== undefined && event.ts >= dayStart && event.ts <= now ? event.ts : now;
      return { ...event, visitor, uid, at, ...parseUa(event.userAgent) };
    }),
  );
}

type RowValues = (string | number)[];

/** One single-event row, in RAW_INSERT_COLUMNS order. */
function singleRow(siteId: number, country: string, e: IdentifiedEvent): RowValues {
  const props = Object.keys(e.props).length > 0 ? JSON.stringify(e.props) : '';
  return [
    siteId, e.at, e.visitor, e.name, e.path, e.ref, country, e.browser, e.os, e.device, e.screen,
    e.utmSource, e.utmMedium, e.utmCampaign,
    e.uid, e.appVersion, props, '', 0, 0, 0, '',
  ];
}

/**
 * Group a batch into segments and turn each into one row.
 *
 * Everything in the key is a column of the row, so it must be the same for
 * every event in the segment; what varies per event (time, name, path, props)
 * goes into the JSON. A segment of one event that kept its arrival time is
 * stored as an ordinary single row — no JSON for readers to open.
 */
function segmentRows(siteId: number, country: string, events: IdentifiedEvent[], now: number): RowValues[] {
  const segments = new Map<string, IdentifiedEvent[]>();
  for (const e of events) {
    const key = JSON.stringify([
      e.visitor, e.uid, e.browser, e.os, e.device, e.screen, e.appVersion, e.ref,
      e.utmSource, e.utmMedium, e.utmCampaign,
    ]);
    const list = segments.get(key);
    if (list) list.push(e);
    else segments.set(key, [e]);
  }

  const rows: RowValues[] = [];
  for (const list of segments.values()) {
    const first = list[0]!;
    if (list.length === 1 && first.at === now) {
      rows.push(singleRow(siteId, country, first));
      continue;
    }

    list.sort((a, b) => a.at - b.at);
    const views = list.filter((e) => e.name === 'pageview');
    const packed = list.map((e) =>
      Object.keys(e.props).length > 0 ? [e.at, e.name, e.path, e.props] : [e.at, e.name, e.path],
    );
    rows.push([
      siteId,
      // Arrival time, not event time: the table is keyed by (site_id, ts),
      // and the realtime panel seeks the last half hour of arrivals by it.
      now,
      first.visitor,
      '',
      views[0]?.path ?? '',
      first.ref, country, first.browser, first.os, first.device, first.screen,
      first.utmSource, first.utmMedium, first.utmCampaign,
      first.uid, first.appVersion, '',
      JSON.stringify(packed),
      views.length,
      views[0]?.at ?? 0,
      views[views.length - 1]?.at ?? 0,
      views[views.length - 1]?.path ?? '',
    ]);
  }
  return rows;
}

const INSERT_PLACEHOLDERS = RAW_INSERT_COLUMNS.split(',').map(() => '?').join(', ');

/**
 * Insert rows into one hour table: a single statement for one row, one D1
 * batch (one round trip, one transaction) for several.
 */
export async function insertRows(db: D1Database, table: string, rows: RowValues[]): Promise<void> {
  if (rows.length === 0) return;
  const sql = `INSERT INTO ${table} (${RAW_INSERT_COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})`;
  const write = async (): Promise<void> => {
    if (rows.length === 1) await db.prepare(sql).bind(...rows[0]!).run();
    else await db.batch(rows.map((row) => db.prepare(sql).bind(...row)));
  };

  try {
    await write();
    return;
  } catch (error) {
    const message = String(error);
    // Always recover from a missing table, even if this isolate believed it
    // existed — the rollup job renames and drops tables, and a cached belief
    // must never be the reason an event is lost.
    if (/no such table/i.test(message)) {
      await db.prepare(createRawTableSql(table)).run();
    } else if (/no such column|has no column named/i.test(message)) {
      // The hour in flight was created by an older build. Widening it is DDL,
      // so it costs nothing and the event still lands in its own hour.
      await alterRawTable(db, table);
    } else {
      throw error;
    }
  }

  await write();
}

/**
 * Read a body of at most `limit` bytes, or null if it runs past that.
 *
 * The Content-Length check upstream only catches clients that declare their
 * size honestly. Reading the stream chunk by chunk and cancelling it at the
 * cap is what stops a chunked or mislabelled body from being buffered whole.
 */
async function readBounded(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readJson(request: Request, limit: number): Promise<{ body: unknown } | Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > limit) return beaconResponse(413, 'payload too large');
  const raw = await readBounded(request, limit);
  if (raw === null) return beaconResponse(413, 'payload too large');
  try {
    return { body: JSON.parse(raw) as unknown };
  } catch {
    return beaconResponse(400, 'invalid payload');
  }
}

/** The site a body names, or the response explaining why not. */
/**
 * Sites by domain, per isolate: a hit for five minutes, a miss for one. Every
 * beacon used to read the sites table; on the free plan that was a row read per
 * event for an answer that changes a few times a year. A deleted site bumps
 * the `sites_gen` setting, which each isolate rereads once a minute, so a
 * removed domain stops being accepted within that minute everywhere.
 */
const SITE_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;
const siteCache = new Map<string, { id: number | null; at: number }>();
let siteGen: { value: string | null; at: number } | null = null;

export function clearSiteCache(): void {
  siteCache.clear();
  siteGen = null;
}

async function cachedSite(db: D1Database, domain: string): Promise<{ id: number } | null> {
  const now = Date.now();
  if (!siteGen || now - siteGen.at > MISS_TTL_MS) {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'sites_gen'").first<{ value: string }>();
    const value = row?.value ?? null;
    if (siteGen && siteGen.value !== value) siteCache.clear();
    siteGen = { value, at: now };
  }
  const hit = siteCache.get(domain);
  if (hit && now - hit.at < (hit.id === null ? MISS_TTL_MS : SITE_TTL_MS)) return hit.id === null ? null : { id: hit.id };
  const site = await db.prepare('SELECT id FROM sites WHERE domain = ?').bind(domain).first<{ id: number }>();
  if (siteCache.size > 1000) siteCache.clear();
  siteCache.set(domain, { id: site?.id ?? null, at: now });
  return site;
}

async function lookupSite(db: D1Database, body: EventPayload): Promise<{ id: number; domain: string } | Response> {
  const siteKey = pick(body, 'd', 'site', 'domain');
  if (siteKey === undefined) return beaconResponse(400, 'invalid payload');

  const domain = normalizeDomain(siteKey);
  const site = await cachedSite(db, domain);

  // A clear 404 here is worth the enumeration risk: "I pasted the snippet and
  // nothing showed up" is the single most common self-hosting failure, and the
  // usual cause is a domain mismatch.
  if (!site) return beaconResponse(404, `site not registered: ${domain}`);
  return { id: site.id, domain };
}

function requestCountry(request: Request): string {
  return clamp((request.cf?.country as string | undefined) ?? '', 8);
}

/** `POST /api/event` and the tracker's own path: one event, one row. */
export async function handleIngest(request: Request, env: Env): Promise<Response> {
  const read = await readJson(request, MAX_BODY_BYTES);
  if (read instanceof Response) return read;
  const body = read.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return beaconResponse(400, 'invalid payload');
  }

  const headerUa = request.headers.get('user-agent') ?? '';
  // Bots are dropped before any read or write so they never touch the budget.
  if (isBot(clamp(pick(body as EventPayload, 'ua', 'user_agent') ?? headerUa, 512))) return beaconResponse(204);

  const site = await lookupSite(env.DB, body as EventPayload);
  if (site instanceof Response) return site;

  const parsed = parseEvent(body, site.domain, headerUa);
  if (!parsed.ok) return beaconResponse(parsed.status, parsed.message);

  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  // The single endpoint never honours a client timestamp: the browser script
  // does not send one, and a lone event is always "now".
  const [event] = await identify(env.DB, site.id, [{ ...parsed.event, ts: undefined }], ip, now, false);

  await insertRows(env.DB, rawTable(partsForTs(now).suffix), [singleRow(site.id, requestCountry(request), event!)]);
  return beaconResponse(204);
}

/**
 * `POST /api/events/batch`: up to fifty events for one site, one request.
 *
 * The batch is all-or-nothing on validation — a client with a bug finds out
 * from a 400 instead of silently losing a fraction of its queue — but bots are
 * still dropped per event, since the User-Agent may be given per event.
 */
export async function handleBatchIngest(request: Request, env: Env): Promise<Response> {
  const read = await readJson(request, MAX_BATCH_BYTES);
  if (read instanceof Response) return read;
  const body = read.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return beaconResponse(400, 'invalid payload');
  }
  const batch = body as EventPayload;

  const list = batch.events;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH_EVENTS) {
    return beaconResponse(400, `events must be an array of 1 to ${MAX_BATCH_EVENTS}`);
  }

  const site = await lookupSite(env.DB, batch);
  if (site instanceof Response) return site;

  const fallbackUa = clamp(pick(batch, 'ua', 'user_agent') ?? request.headers.get('user-agent') ?? '', 512);
  const parsed: ParsedEvent[] = [];
  for (const item of list) {
    const result = parseEvent(item, site.domain, fallbackUa);
    if (!result.ok) return beaconResponse(result.status, result.message);
    if (!isBot(result.event.userAgent)) parsed.push(result.event);
  }
  if (parsed.length === 0) return beaconResponse(204);

  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const events = await identify(env.DB, site.id, parsed, ip, now, true);

  await insertRows(
    env.DB,
    rawTable(partsForTs(now).suffix),
    segmentRows(site.id, requestCountry(request), events, now),
  );
  return beaconResponse(204);
}
