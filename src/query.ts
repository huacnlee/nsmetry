/**
 * The dashboard's read model.
 *
 * Every panel on the console asks the same question — "these metrics, over this
 * range, narrowed by this stack of filters" — so there is one place that knows
 * how to answer it and four thin endpoints on top.
 *
 * Where the numbers come from depends on whether a filter is active:
 *
 *   no filters, past days   -> stats_daily      (one row per dimension value)
 *   no filters, today       -> stats_hourly's packed hours + the unfolded raw
 *                              hours for rankings; raw rows for the totals,
 *                              which must count each visitor once a day
 *   filters,    past days   -> the filter cube  (stats_cube, then stats_cube2)
 *   filters,    today       -> today's raw tables, read directly
 *
 * The split matters because the per-dimension rollups cannot answer a question
 * about two dimensions at once: summing "pages" and "countries" separately has
 * already thrown away which pages the German visitors read. The cube keeps the
 * whole tuple, so it can.
 *
 * One vocabulary runs through all of it. A *visit* is one visitor's pageviews
 * inside a UTC day, which is the most a system that stores no session id can
 * honestly claim, and it makes visits and daily unique visitors the same
 * number. Every other metric is a ratio over visits.
 */

import {
  SETTING_CUBE2_FROM,
  foldedTable,
  cubeSource,
  getSetting,
  hourlyDimRows,
  isFolded,
  rawEvents,
  rawRows,
  rawTable,
  rawTablesForDay,
  tableSuffix,
  unionAll,
  visitStateRows,
  withCurrentRawTables,
} from './db';
import { FILTER_COLUMNS, type BreakdownDim } from './dimensions';
import { blocksFrom } from './state';
import { freshComponents, freshEventSeries, freshFilteredHours, freshHours, freshRankings, splitRange } from './reads';
import { type FoldRow, FOLD_COLUMNS, MAX_K, compareCursor, epochDay } from './fold';
import { isValidDay, partsFor } from './time';

export type Metric = 'visitors' | 'views' | 'vpv' | 'bounce' | 'time';

export const METRICS: readonly Metric[] = ['visitors', 'views', 'vpv', 'bounce', 'time'];

export interface Filter {
  dim: string;
  value: string;
}

/** The raw ingredients every metric is derived from. */
export interface Components {
  views: number;
  visits: number;
  bounces: number;
  duration: number;
}

export interface Bucket extends Components {
  label: string;
}

export interface BreakdownRow {
  name: string;
  value: number;
  visits: number;
}

export type Granularity = 'hour' | 'day' | 'week' | 'month';

export interface Range {
  id: string;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  granularity: Granularity;
  /** Human phrasing for the compare series, e.g. "previous 30 days". */
  prevLabel: string;
}

const EMPTY: Components = { views: 0, visits: 0, bounces: 0, duration: 0 };

const RANGES: Record<string, { days: number; granularity: Granularity; prevLabel: string }> = {
  today: { days: 1, granularity: 'hour', prevLabel: 'yesterday' },
  '7d': { days: 7, granularity: 'day', prevLabel: 'previous 7 days' },
  '30d': { days: 30, granularity: 'day', prevLabel: 'previous 30 days' },
  '90d': { days: 90, granularity: 'week', prevLabel: 'previous 90 days' },
  '12mo': { days: 365, granularity: 'month', prevLabel: 'previous year' },
};

export const RANGE_IDS = Object.keys(RANGES);

/** Upper bound on a custom range, so one bad query string cannot walk forever. */
const MAX_RANGE_DAYS = 3660;

export function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return partsFor(date).day;
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  ) + 1;
}

/**
 * Resolve `?range=30d`, or an explicit `from`/`to` pair.
 *
 * The comparison window is always the same number of days ending the day before
 * the range starts, so "previous 30 days" means exactly that rather than the
 * same dates a month earlier.
 */
export function resolveRange(
  rangeId: string | undefined,
  from: string | undefined,
  to: string | undefined,
  now: Date,
): Range | null {
  const today = partsFor(now).day;

  if (from || to) {
    const start = from ?? today;
    const end = to ?? today;
    // Validated here rather than at each endpoint, because everything below
    // walks the range a day at a time: a malformed or absurd pair would other-
    // wise turn one mistyped bookmark into millions of iterations and a scan to
    // match. Ten years is far past any real question and still bounded.
    if (!isValidDay(start) || !isValidDay(end) || start > end) return null;
    const length = daysBetween(start, end);
    if (length > MAX_RANGE_DAYS) return null;
    return {
      id: 'custom',
      from: start,
      to: end,
      prevFrom: shiftDay(start, -length),
      prevTo: shiftDay(start, -1),
      granularity: length === 1 ? 'hour' : length > 180 ? 'month' : length > 45 ? 'week' : 'day',
      prevLabel: `previous ${length} days`,
    };
  }

  const preset = RANGES[rangeId ?? '30d'];
  if (!preset) return null;

  const start = shiftDay(today, -(preset.days - 1));
  return {
    id: rangeId ?? '30d',
    from: start,
    to: today,
    prevFrom: shiftDay(start, -preset.days),
    prevTo: shiftDay(start, -1),
    granularity: preset.granularity,
    prevLabel: preset.prevLabel,
  };
}

/**
 * Parse `f=path:/docs,country:DE` into a filter stack.
 *
 * Values may contain commas and colons — a path can be `/a,b` and a referrer
 * can carry a port — so only the *first* colon of each entry separates the
 * dimension from its value, and values are percent-encoded by the client.
 * Unknown dimension names are dropped rather than rejected, so an old bookmark
 * degrades to a wider view instead of an error page.
 */
export function parseFilters(raw: string | undefined | null): Filter[] {
  if (!raw) return [];

  const filters: Filter[] = [];
  for (const entry of raw.split(',')) {
    const colon = entry.indexOf(':');
    if (colon <= 0) continue;

    const dim = entry.slice(0, colon).trim();
    if (!Object.hasOwn(FILTER_COLUMNS, dim)) continue;

    let value: string;
    try {
      value = decodeURIComponent(entry.slice(colon + 1));
    } catch {
      value = entry.slice(colon + 1);
    }
    if (filters.some((f) => f.dim === dim && f.value === value)) continue;
    filters.push({ dim, value });
    if (filters.length >= 12) break;
  }
  return filters;
}

/**
 * The longest window a filtered query may cover, in days.
 *
 * Unfiltered, a finished day is a handful of rollup rows. Filtered, it is a
 * walk of that day's whole stats_cube2 tuple list — thousands of rows a day
 * for an app with a few thousand users — and D1 bills every one. Measured in
 * test/budget.test.ts, one filtered 12-month view of a 1,200-DAU app read about
 * 3.7M rows, more than the daily target on its own; a filtered 30-day view of
 * the largest app costs a fraction of it. So filters stop at a month (the
 * comparison window may add another), and longer ranges are unfiltered only.
 */
export const MAX_FILTERED_DAYS = 31;

/** Why a filter stack cannot be applied to this window, or null when it can. */
export function filterSpanError(from: string, to: string, filters: Filter[]): string | null {
  if (filters.length === 0) return null;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  return days > MAX_FILTERED_DAYS
    ? `filters work on ranges of up to ${MAX_FILTERED_DAYS} days; pick 30d or shorter, or remove the filters`
    : null;
}

export function serializeFilters(filters: Filter[]): string {
  return filters.map((f) => `${f.dim}:${encodeURIComponent(f.value)}`).join(',');
}

/**
 * Turn a filter stack into a SQL predicate plus its bindings.
 *
 * Several values on one dimension are OR-ed and different dimensions are
 * AND-ed, which is what makes clicking two countries mean "either" and a
 * country plus a path mean "both". Column names come from a fixed allowlist;
 * only values are ever bound.
 */
function filterClause(filters: Filter[]): { sql: string; binds: string[] } {
  if (filters.length === 0) return { sql: '', binds: [] };

  const byDim = new Map<string, string[]>();
  for (const { dim, value } of filters) {
    const list = byDim.get(dim);
    if (list) list.push(value);
    else byDim.set(dim, [value]);
  }

  const parts: string[] = [];
  const binds: string[] = [];
  for (const [dim, values] of byDim) {
    const column = FILTER_COLUMNS[dim]!;
    parts.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    binds.push(...values);
  }
  return { sql: ` AND ${parts.join(' AND ')}`, binds };
}


/* ------------------------------------------------------------ raw today -- */

/** Today's raw tables, of both kinds (see rawTable in db.ts). */
export async function todayTables(db: D1Database, now: Date): Promise<string[]> {
  return rawTablesForDay(db, partsFor(now).day);
}

/** True when a filter stack can only be answered event by event. */
function needsEvents(filters: Filter[]): boolean {
  // A batch segment's path column is only its first pageview's path; every
  // other filterable column is the same for all of a segment's events.
  return filters.some((f) => f.dim === 'path');
}

/**
 * One site's stored rows across tables, either row level (cheap: a segment
 * is one row carrying its pageview count) or pageview level (each pageview
 * its own row). Both have the same columns — rawRows' — so everything below
 * is written once. Returns the SQL and its bindings, one site id per table.
 *
 * The site predicate is applied per table before anything else, so another
 * site's batch JSON is never opened.
 */
export function siteRows(tables: string[], siteId: number, level: 'rows' | 'pageviews'): { sql: string; binds: number[] } {
  const per = (table: string): string =>
    level === 'rows'
      ? rawRows(table, 'site_id = ?')
      : `SELECT site_id, ts, visitor, uid, ref, country, browser, os, device, screen,
                utm_source, utm_medium, utm_campaign, app_version, name,
                1 AS views, ts AS fts, ts AS lts, path, path AS exit_path
         FROM (${rawEvents(table, 'e.site_id = ?')}) WHERE name = 'pageview'`;
  return { sql: unionAll(tables.map(per)), binds: tables.map(() => siteId) };
}

/** One site's events across tables, segments opened up. */
export function siteEvents(tables: string[], siteId: number): { sql: string; binds: number[] } {
  return { sql: unionAll(tables.map((t) => rawEvents(t, 'e.site_id = ?'))), binds: tables.map(() => siteId) };
}

/**
 * Today's rows at visit level for one site: today_visits' merged entries for
 * the hours folded so far, plus the raw rows of every hour after them.
 *
 * Answers exactly what siteRows(tables, siteId, 'rows') would (see
 * VISIT_STATE_FIELDS in db.ts), at a fraction of the rows: a visitor's whole
 * day so far is one entry per profile, however many segments it sent. Falls
 * back to the raw rows when there is no usable state, and under a path
 * filter, which must see each pageview.
 */
async function todayVisitRows(
  db: D1Database,
  siteId: number,
  tables: string[],
  filters: Filter[],
): Promise<{ sql: string; binds: (number | string)[]; tables: string[] }> {
  if (needsEvents(filters)) return { ...siteRows(tables, siteId, 'pageviews'), tables };
  const day = tables.length > 0 ? hourOf(tables[0]!).slice(0, 10) : '';
  const state = day
    ? await db
        .prepare('SELECT through FROM today_visits WHERE site_id = ? AND day = ? AND visits IS NOT NULL')
        .bind(siteId, day)
        .first<{ through: string }>()
    : null;
  if (!state) return { ...siteRows(tables, siteId, 'rows'), tables };
  const rest = tables.filter((t) => hourOf(t) > state.through);
  return {
    sql: unionAll([visitStateRows('v.site_id = ? AND v.day = ?'), ...rest.map((t) => rawRows(t, 'site_id = ?'))]),
    binds: [siteId, day, ...rest.map(() => siteId)],
    tables: rest,
  };
}

/**
 * Rows ranked so each visit's first and last pageview is known.
 *
 * The ranking runs over *every* pageview the visitor made today, before any
 * filter is applied, so "entrances" keeps meaning "visits that started here"
 * rather than "the first matching row" — the same rule the cube is built with.
 */
function ranked(source: string): string {
  return `SELECT x.*,
            ROW_NUMBER() OVER (PARTITION BY visitor ORDER BY fts, ts) AS rn_first,
            ROW_NUMBER() OVER (PARTITION BY visitor ORDER BY lts DESC, ts DESC) AS rn_last,
            SUM(views) OVER (PARTITION BY visitor) AS visit_views,
            MAX(lts) OVER (PARTITION BY visitor) - MIN(fts) OVER (PARTITION BY visitor) AS visit_span
          FROM (${source}) x WHERE views > 0`;
}

/** The four component sums, in the order every reader below expects them. */
const RAW_COMPONENTS = `SUM(views) AS views,
   SUM(CASE WHEN rn_first = 1 THEN 1 ELSE 0 END) AS visits,
   SUM(CASE WHEN rn_first = 1 AND visit_views = 1 THEN 1 ELSE 0 END) AS bounces,
   SUM(CASE WHEN rn_first = 1 THEN visit_span ELSE 0 END) AS duration`;

const CUBE_COMPONENTS = `COALESCE(SUM(pageviews), 0) AS views,
   COALESCE(SUM(entrances), 0) AS visits,
   COALESCE(SUM(bounces), 0) AS bounces,
   COALESCE(SUM(duration), 0) AS duration`;

interface ComponentRow extends Components {
  label: string;
}

function add(into: Map<string, Bucket>, label: string, values: Components): void {
  const existing = into.get(label);
  if (existing) {
    existing.views += values.views;
    existing.visits += values.visits;
    existing.bounces += values.bounces;
    existing.duration += values.duration;
  } else {
    into.set(label, { label, views: values.views, visits: values.visits, bounces: values.bounces, duration: values.duration });
  }
}

/** The first day stats_cube2 holds, or null before the first rollup that wrote it. */
async function cubeCutoff(db: D1Database): Promise<string | null> {
  return getSetting(db, SETTING_CUBE2_FROM);
}

/**
 * `'a', 'b', …` from `from` to `to` inclusive, for an IN list that SQLite turns
 * into one primary-key probe per key. Inlined rather than bound: D1 caps bound
 * parameters at 100 and a 12-month range has 365 days. Safe to inline because
 * every value is generated here from a validated date, never taken from input.
 * The longest range allowed (MAX_RANGE_DAYS) makes about 51 KB of SQL, inside
 * D1's 100 KB statement limit.
 */
function keyList(from: string, to: string, next: (key: string) => string): string {
  const keys: string[] = [];
  for (let key = from; key <= to && keys.length <= MAX_RANGE_DAYS; key = next(key)) {
    if (!/^[0-9T-]+$/.test(key)) throw new Error(`bad key ${key}`);
    keys.push(`'${key}'`);
  }
  return keys.length > 0 ? keys.join(', ') : "''";
}

function hourList(day: string): string {
  return keyList(`${day}T00`, `${day}T23`, (h) => `${day}T${String(Number(h.slice(11)) + 1).padStart(2, '0')}`);
}

/** A raw table can be dropped by the rollup between listing and reading. */
function isGone(error: unknown): boolean {
  return /no such table/i.test(String(error));
}

/**
 * Per-day components for a range, from whichever store can answer.
 *
 * Days are the unit even for a 12-month range: 365 rows is a cheap read, and
 * folding them into weeks or months afterwards costs nothing, whereas asking
 * SQLite to bucket dates means date arithmetic in every query.
 */
async function dailyComponents(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  filters: Filter[],
  now: Date,
): Promise<Map<string, Bucket>> {
  // Days before the fold's cutover come from the older rollups; from it on,
  // from day_state and blocks (src/reads.ts).
  const split = await splitRange(db, from, to);
  const buckets = split.legacy
    ? await legacyDailyComponents(db, siteId, split.legacy.from, split.legacy.to, filters, now)
    : new Map<string, Bucket>();
  if (split.fresh) {
    for (const [day, values] of await freshComponents(db, siteId, split.fresh.from, split.fresh.to, filters, now)) {
      add(buckets, day, values);
    }
  }
  return buckets;
}

async function legacyDailyComponents(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  filters: Filter[],
  now: Date,
): Promise<Map<string, Bucket>> {
  const today = partsFor(now).day;
  const buckets = new Map<string, Bucket>();
  const historyTo = to < today ? to : shiftDay(today, -1);
  const { sql: where, binds } = filterClause(filters);

  if (from <= historyTo) {
    let results: ComponentRow[];
    if (filters.length > 0) {
      const cube = cubeSource(await cubeCutoff(db), siteId, from, historyTo, 'pageview');
      ({ results } = await db
        .prepare(`SELECT day AS label, ${CUBE_COMPONENTS} FROM (${cube.sql}) WHERE 1 = 1${where} GROUP BY day`)
        .bind(...cube.binds, ...binds)
        .all<ComponentRow>());
    } else {
      // One primary-key probe per day rather than a range scan: the key is
      // (site_id, day, dim, val), so `day BETWEEN` would walk — and D1 would
      // bill — every dimension's rows of every day just to find `_total`.
      ({ results } = await db
        .prepare(
          `SELECT day AS label, pageviews AS views, visitors AS visits, bounces, duration
           FROM stats_daily
           WHERE site_id = ? AND day IN (${keyList(from, historyTo, (d) => shiftDay(d, 1))})
             AND dim = '_total' AND val = ''`,
        )
        .bind(siteId)
        .all<ComponentRow>());
    }
    for (const row of results) add(buckets, row.label, row);
  }

  if (to >= today && from <= today) {
    for (const row of await todayComponents(db, siteId, filters, now, 'day')) {
      add(buckets, row.label, row);
    }
  }

  return buckets;
}

/**
 * Today, always straight from raw rows.
 *
 * A visit is a visitor's whole day, so today's visits cannot be summed out of
 * hourly rollups without counting a returning visitor once per hour. The raw
 * rows answer it exactly, and at row level that is one walk of today's stored
 * rows: a batch segment is one row however many events it carries.
 */
async function todayComponents(
  db: D1Database,
  siteId: number,
  filters: Filter[],
  now: Date,
  by: 'day' | 'hour',
): Promise<ComponentRow[]> {
  const today = partsFor(now).day;
  const tables = await rawTablesForDay(db, today);
  if (tables.length === 0) return [];

  const { sql: where, binds } = filterClause(filters);
  // By hour, a visitor's entry spans hours, so only the raw rows can say
  // which hour each pageview fell in.
  const source =
    by === 'hour'
      ? { ...siteRows(tables, siteId, needsEvents(filters) ? 'pageviews' : 'rows'), tables }
      : await todayVisitRows(db, siteId, tables, filters);
  const label = by === 'hour' ? `strftime('%Y-%m-%dT%H', fts, 'unixepoch')` : `'${today}'`;

  // Unfiltered, a visit is simply a visitor's day, so grouping by visitor
  // answers it in one sort — the ranked form below needs four window passes,
  // which D1 bills as reading every row four more times. The ranking is only
  // needed when a filter must be applied to rows *after* deciding which of a
  // visitor's rows was the first.
  const sql =
    filters.length === 0
      ? `WITH g AS MATERIALIZED (
           SELECT visitor, ${label} AS label, SUM(views) AS views, MIN(fts) AS f, MAX(lts) AS l
           FROM (${source.sql}) WHERE views > 0 GROUP BY visitor, label
         ),
         v AS (
           SELECT MIN(label) AS label, SUM(views) AS views, MAX(l) - MIN(f) AS span FROM g GROUP BY visitor
         )
         SELECT label, SUM(views) AS views, SUM(visits) AS visits, SUM(bounces) AS bounces, SUM(duration) AS duration
         FROM (
           SELECT label, views, 0 AS visits, 0 AS bounces, 0 AS duration FROM g
           UNION ALL
           SELECT label, 0, 1, CASE WHEN views = 1 THEN 1 ELSE 0 END, span FROM v
         )
         GROUP BY label`
      : `SELECT ${label} AS label, ${RAW_COMPONENTS}
         FROM (${ranked(source.sql)})
         WHERE 1 = 1${where}
         GROUP BY label`;

  try {
    const { results } = await withCurrentRawTables(db, source.tables, () =>
      db
        .prepare(sql)
        .bind(...source.binds, ...binds)
        .all<ComponentRow>(),
    );
    return results;
  } catch (error) {
    if (isGone(error)) return [];
    throw error;
  }
}

/** Monday of the ISO week containing `day`. */
export function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const shift = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - shift);
  return partsFor(date).day;
}

export function bucketLabelOf(day: string, granularity: Granularity): string {
  return bucketLabel(day, granularity);
}

function bucketLabel(day: string, granularity: Granularity): string {
  if (granularity === 'week') return weekStart(day);
  if (granularity === 'month') return day.slice(0, 7);
  return day;
}

/**
 * Every label a range should show, including the quiet ones.
 *
 * Days with no traffic have no rollup row at all; without padding them back in,
 * a slow week renders as one lonely bar instead of a seven-day chart.
 */
function labelsFor(range: Range, now: Date): string[] {
  if (range.granularity === 'hour') {
    const today = partsFor(now).day;
    const last = range.from === today ? now.getUTCHours() : 23;
    return Array.from({ length: last + 1 }, (_, h) => `${range.from}T${String(h).padStart(2, '0')}`);
  }

  const labels: string[] = [];
  const seen = new Set<string>();
  for (let day = range.from; day <= range.to; day = shiftDay(day, 1)) {
    const label = bucketLabel(day, range.granularity);
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels;
}

/** The series for one window, already folded to the range's granularity. */
export async function loadSeries(
  db: D1Database,
  siteId: number,
  range: Range,
  from: string,
  to: string,
  filters: Filter[],
  now: Date,
  sameTime = false,
): Promise<Bucket[]> {
  const folded = new Map<string, Bucket>();

  if (range.granularity === 'hour') {
    const today = partsFor(now).day;
    const cut = await blocksFrom(db);
    const fresh = cut !== null && from >= cut;
    if (fresh && filters.length === 0) {
      // A fold day's hours: today from its state and tail; a finished day from
      // its level-0 block, cut at this time of day when it is the comparison
      // for today (src/reads.ts).
      const through = sameTime && from !== today ? bucketOf(now) : undefined;
      for (const row of await freshHours(db, siteId, from, now, through)) add(folded, row.label, row);
    } else if (fresh && from === today) {
      // Today under a filter, by hour: from the state's hourly tuples.
      for (const row of await freshFilteredHours(db, siteId, filters, now)) add(folded, row.label, row);
    } else if (from === today) {
      // Today under a filter, by hour: the cube keeps no hours, so read raw.
      for (const row of await todayComponents(db, siteId, filters, now, 'hour')) {
        add(folded, row.label, row);
      }
    } else if (!fresh) {
      for (const row of await pastHours(db, siteId, from, filters)) add(folded, row.label, row);
    }
  } else {
    for (const [day, values] of await dailyComponents(db, siteId, from, to, filters, now)) {
      add(folded, bucketLabel(day, range.granularity), values);
    }
  }

  const labels = from === range.from ? labelsFor(range, now) : labelsFor({ ...range, from, to }, now);
  return labels.map((label) => folded.get(label) ?? { label, ...EMPTY });
}

/**
 * A finished day at hour resolution.
 *
 * Only reachable through the compare series of `range=today`, and only while
 * the hourly rollups still reach back that far; a filtered comparison has no
 * raw tables left to read, so it comes back empty rather than wrong.
 */
/** The ten-minute bucket of the day `now` is in (0–143). */
export function bucketOf(now: Date): number {
  return Math.floor((Math.floor(now.getTime() / 1000) % 86_400) / 600);
}

async function pastHours(db: D1Database, siteId: number, day: string, filters: Filter[]): Promise<ComponentRow[]> {
  if (filters.length > 0) return [];
  try {
    return await pastHoursFromRollup(db, siteId, day);
  } catch (error) {
    // stats_hourly is dropped once every day it held is past its retention.
    if (isGone(error)) return [];
    throw error;
  }
}

async function pastHoursFromRollup(db: D1Database, siteId: number, day: string): Promise<ComponentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT hour AS label, pageviews AS views, visitors AS visits, bounces, duration
       FROM stats_hourly
       WHERE site_id = ? AND hour IN (${hourList(day)}) AND dim = '_total' AND val = ''`,
    )
    .bind(siteId)
    .all<ComponentRow>();
  return results;
}

/**
 * Totals for a window, from a series already in hand.
 *
 * Every bucketing folds the same underlying days, so the sum over buckets is
 * the sum over the window whatever the granularity — which means the headline
 * numbers cost nothing once the chart has been drawn, instead of a second pass
 * over the same rows.
 */
export function totalsFrom(buckets: Bucket[]): Components {
  const totals = { ...EMPTY };
  for (const bucket of buckets) {
    totals.views += bucket.views;
    totals.visits += bucket.visits;
    totals.bounces += bucket.bounces;
    totals.duration += bucket.duration;
  }
  return totals;
}

/** Totals for a window. Visits are summed per day, so a weekly regular counts once a day. */
export async function loadTotals(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  filters: Filter[],
  now: Date,
): Promise<Components> {
  return totalsFrom([...(await dailyComponents(db, siteId, from, to, filters, now)).values()]);
}

export function metricValue(metric: Metric, c: Components): number {
  switch (metric) {
    case 'views':
      return c.views;
    case 'visitors':
      return c.visits;
    case 'vpv':
      return c.visits === 0 ? 0 : Math.round((c.views / c.visits) * 100) / 100;
    case 'bounce':
      return c.visits === 0 ? 0 : Math.round((c.bounces / c.visits) * 1000) / 10;
    case 'time':
      return c.visits === 0 ? 0 : Math.round(c.duration / c.visits);
  }
}

/* ------------------------------------------------------------ breakdowns -- */

/** Dimensions that are one column of a stored row (everything but path and event). */
function isProfileDim(dim: BreakdownDim): boolean {
  return dim !== 'path' && dim !== 'event' && dim !== 'entry' && dim !== 'exit';
}

type Ranked = Map<string, BreakdownRow[]>;

/**
 * Fold one grouped result into per-dimension rankings.
 *
 * Each query below groups by every column the request needs at once — one
 * walk instead of one per panel — so a dimension's ranking is its column
 * summed over the combinations.
 */
function foldRows(
  results: Record<string, string | number | null>[],
  dims: BreakdownDim[],
  measure: (dim: BreakdownDim) => { name: string; value: string; visits: string },
): Ranked {
  const out: Ranked = new Map();
  for (const dim of dims) {
    const m = measure(dim);
    const merged = new Map<string, BreakdownRow>();
    for (const row of results) {
      const value = Number(row[m.value] ?? 0);
      if (value === 0) continue;
      const name = String(row[m.name] ?? '');
      const visits = Number(row[m.visits] ?? 0);
      const existing = merged.get(name);
      if (existing) {
        existing.value += value;
        existing.visits += visits;
      } else {
        merged.set(name, { name, value, visits });
      }
    }
    out.set(dim, [...merged.values()]);
  }
  return out;
}

/**
 * Rankings from raw tables: profile dimensions and entry/exit at row level
 * (or pageview level under a path filter), path and event name at event
 * level. At most two walks of the tables, whatever was asked for.
 */
async function rawBreakdowns(
  db: D1Database,
  siteId: number,
  tables: string[],
  filters: Filter[],
  dims: BreakdownDim[],
  wholeDay = false,
): Promise<Ranked> {
  const out: Ranked = new Map();
  if (tables.length === 0 || dims.length === 0) return out;
  const { sql: where, binds } = filterClause(filters);

  try {
    const visitDims = dims.filter((d) => isProfileDim(d) || d === 'entry' || d === 'exit');
    if (visitDims.length > 0) {
      const columns = [
        ...new Set(
          visitDims.map((d) => (d === 'entry' ? 'path' : d === 'exit' ? 'exit_path' : FILTER_COLUMNS[d]!)),
        ),
      ];
      // `wholeDay`: these are all of today's tables, so the merged state of
      // the folded hours can stand in for their rows.
      const source = wholeDay
        ? await todayVisitRows(db, siteId, tables, filters)
        : { ...siteRows(tables, siteId, needsEvents(filters) ? 'pageviews' : 'rows'), tables };
      const { results } = await withCurrentRawTables(db, source.tables, () =>
        db
          .prepare(
            `SELECT ${columns.join(', ')}, SUM(views) AS views,
                    SUM(CASE WHEN rn_first = 1 THEN 1 ELSE 0 END) AS entrances,
                    SUM(CASE WHEN rn_last = 1 THEN 1 ELSE 0 END) AS exits
             FROM (${ranked(source.sql)})
             WHERE 1 = 1${where}
             GROUP BY ${columns.join(', ')}`,
          )
          .bind(...source.binds, ...binds)
          .all<Record<string, string | number | null>>(),
      );
      for (const [dim, rows] of foldRows(results, visitDims, (d) =>
        d === 'entry'
          ? { name: 'path', value: 'entrances', visits: 'entrances' }
          : d === 'exit'
            ? { name: 'exit_path', value: 'exits', visits: 'exits' }
            : { name: FILTER_COLUMNS[d]!, value: 'views', visits: 'entrances' },
      )) {
        out.set(dim, rows);
      }
    }

    const eventDims = dims.filter((d) => d === 'path' || d === 'event');
    if (eventDims.length > 0) {
      const source = siteEvents(tables, siteId);
      const only =
        eventDims.length === 2 ? '' : eventDims[0] === 'path' ? " AND name = 'pageview'" : " AND name <> 'pageview'";
      const { results } = await withCurrentRawTables(db, tables, () =>
        db
          .prepare(
            `SELECT CASE WHEN name = 'pageview' THEN 'path' ELSE 'event' END AS kind,
                    CASE WHEN name = 'pageview' THEN path ELSE name END AS val,
                    COUNT(*) AS n, COUNT(DISTINCT visitor) AS v
             FROM (${source.sql})
             WHERE 1 = 1${only}${where}
             GROUP BY kind, val`,
          )
          .bind(...source.binds, ...binds)
          .all<{ kind: string; val: string; n: number; v: number }>(),
      );
      for (const dim of eventDims) {
        out.set(
          dim,
          results.filter((r) => r.kind === dim).map((r) => ({ name: r.val, value: r.n, visits: r.v })),
        );
      }
    }
  } catch (error) {
    if (!isGone(error)) throw error;
  }
  return out;
}

/**
 * Rankings for finished days under a filter, from the cube.
 *
 * Grouped by every needed column at once, for the same reason as the raw
 * path: stats_cube2 is packed, so each pass walks every tuple of the range,
 * and one pass per panel would multiply that by six.
 */
async function cubeBreakdowns(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  filters: Filter[],
  dims: BreakdownDim[],
): Promise<Ranked> {
  const out: Ranked = new Map();
  const { sql: where, binds } = filterClause(filters);
  const cutoff = await cubeCutoff(db);

  const pageDims = dims.filter((d) => d !== 'event');
  if (pageDims.length > 0) {
    const columns = [...new Set(pageDims.map((d) => (d === 'entry' || d === 'exit' ? 'path' : FILTER_COLUMNS[d]!)))];
    const cube = cubeSource(cutoff, siteId, from, to, 'pageview');
    const { results } = await db
      .prepare(
        `SELECT ${columns.join(', ')}, SUM(pageviews) AS views, SUM(entrances) AS entrances, SUM(exits) AS exits
         FROM (${cube.sql}) WHERE 1 = 1${where}
         GROUP BY ${columns.join(', ')}`,
      )
      .bind(...cube.binds, ...binds)
      .all<Record<string, string | number | null>>();
    for (const [dim, rows] of foldRows(results, pageDims, (d) =>
      d === 'entry'
        ? { name: 'path', value: 'entrances', visits: 'entrances' }
        : d === 'exit'
          ? { name: 'path', value: 'exits', visits: 'exits' }
          : { name: FILTER_COLUMNS[d]!, value: 'views', visits: 'entrances' },
    )) {
      out.set(dim, rows);
    }
  }

  if (dims.includes('event')) {
    const cube = cubeSource(cutoff, siteId, from, to, 'events');
    const { results } = await db
      .prepare(
        `SELECT name, SUM(pageviews) AS value, SUM(visitors) AS visits
         FROM (${cube.sql}) WHERE 1 = 1${where}
         GROUP BY name HAVING SUM(pageviews) > 0`,
      )
      .bind(...cube.binds, ...binds)
      .all<BreakdownRow>();
    out.set('event', results);
  }
  return out;
}

/**
 * Every requested ranking over finished days, in one pass.
 *
 * `dim` sits third in the primary key, after the day, so `day BETWEEN` would
 * walk every dimension's rows of every day. Listing the days instead lets
 * SQLite seek each (day, dim) pair and read only the dimensions asked for
 * (one call for all of them still beats one per dimension: one statement, one
 * set of seeks). `_total` rides along because direct traffic is reconstructed
 * from it.
 */
async function breakdownsFromDaily(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  dims: BreakdownDim[],
): Promise<{ rows: (BreakdownRow & { dim: string })[]; totalViews: number }> {
  const wanted = [...dims, '_total'];
  const { results } = await db
    .prepare(
      `SELECT dim, val AS name, SUM(pageviews) AS value, SUM(visitors) AS visits
       FROM stats_daily
       WHERE site_id = ? AND day IN (${keyList(from, to, (d) => shiftDay(d, 1))})
         AND dim IN (${wanted.map(() => '?').join(', ')})
       GROUP BY dim, val`,
    )
    .bind(siteId, ...wanted)
    .all<BreakdownRow & { dim: string }>();

  return {
    rows: results.filter((row) => row.dim !== '_total'),
    totalViews: results.find((row) => row.dim === '_total')?.value ?? 0,
  };
}

/**
 * Today's folded hours, from their packed stats_hourly rows.
 *
 * Only the hours whose raw table has been renamed `ef_` are read here — the
 * rename and the packed row are written in one batch, so the two always
 * agree — and every other hour of today is read raw. That split is what makes
 * an unfiltered dashboard cheap: the folded hours are a few hundred packed
 * entries instead of every event of the day.
 */
async function breakdownsFromHours(
  db: D1Database,
  siteId: number,
  hours: string[],
  dims: BreakdownDim[],
): Promise<{ rows: (BreakdownRow & { dim: string })[]; totalViews: number }> {
  const wanted = dims.filter((d) => d !== 'entry' && d !== 'exit');
  if (hours.length === 0) return { rows: [], totalViews: 0 };

  const marks = hours.map(() => '?').join(', ');
  const where = `site_id = ? AND hour IN (${marks})`;
  const total = await db
    .prepare(`SELECT COALESCE(SUM(pageviews), 0) AS v FROM stats_hourly WHERE dim = '_total' AND ${where}`)
    .bind(siteId, ...hours)
    .first<{ v: number }>();
  if (wanted.length === 0) return { rows: [], totalViews: total?.v ?? 0 };

  const { results } = await db
    .prepare(
      `SELECT dim, val AS name, SUM(pageviews) AS value, SUM(visitors) AS visits
       FROM (${hourlyDimRows(where)})
       WHERE dim IN (${wanted.map(() => '?').join(', ')})
       GROUP BY dim, val`,
    )
    .bind(siteId, ...hours, siteId, ...hours, ...wanted)
    .all<BreakdownRow & { dim: string }>();
  return { rows: results, totalViews: total?.v ?? 0 };
}

function hourOf(table: string): string {
  const s = tableSuffix(table);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}`;
}

function mergeRows(...lists: BreakdownRow[][]): Map<string, BreakdownRow> {
  const merged = new Map<string, BreakdownRow>();
  for (const list of lists) {
    for (const row of list) {
      const existing = merged.get(row.name);
      if (existing) {
        existing.value += row.value;
        existing.visits += row.visits;
      } else {
        merged.set(row.name, { ...row });
      }
    }
  }
  return merged;
}

const DIRECT = 'Direct / none';

/**
 * Rank several dimensions over a range.
 *
 * Empty values are dropped everywhere except `referrer`, where the absence of a
 * referrer is the answer. Where it comes from differs by store: the cube and
 * the raw tables keep the empty string, while the per-dimension rollups drop
 * it to avoid storing an entry per empty field — so for those days and hours
 * it is the gap between total pageviews and the ones that named a source.
 * Both are counted once, over the days each is responsible for.
 */
export async function loadBreakdowns(
  db: D1Database,
  siteId: number,
  range: { from: string; to: string },
  filters: Filter[],
  dims: BreakdownDim[],
  limit: number,
  now: Date,
): Promise<Record<string, BreakdownRow[]>> {
  return (await loadRankings(db, siteId, range, filters, dims, limit, now)).breakdowns;
}

/**
 * loadBreakdowns, and whether any part of the answer was cut short (a block
 * keeps 500 values per dimension and 100 events): `approx`.
 */
export async function loadRankings(
  db: D1Database,
  siteId: number,
  range: { from: string; to: string },
  filters: Filter[],
  dims: BreakdownDim[],
  limit: number,
  now: Date,
): Promise<{ breakdowns: Record<string, BreakdownRow[]>; approx: boolean }> {
  const split = await splitRange(db, range.from, range.to);
  const extra: Map<string, BreakdownRow[][]> = new Map();
  let approx = false;
  if (split.fresh) {
    const fresh = await freshRankings(db, siteId, split.fresh.from, split.fresh.to, filters, dims, now);
    approx = fresh.approx;
    for (const [dim, table] of fresh.rows) {
      extra.set(dim, [[...table].map(([name, [value, visits]]) => ({ name, value, visits }))]);
    }
  }
  const breakdowns = await legacyBreakdowns(db, siteId, split.legacy, filters, dims, limit, now, extra);
  return { breakdowns, approx };
}

async function legacyBreakdowns(
  db: D1Database,
  siteId: number,
  legacyRange: { from: string; to: string } | null,
  filters: Filter[],
  dims: BreakdownDim[],
  limit: number,
  now: Date,
  extra: Map<string, BreakdownRow[][]>,
): Promise<Record<string, BreakdownRow[]>> {
  const range = legacyRange ?? { from: '9999-12-31', to: '0000-01-01' };
  const today = partsFor(now).day;
  const historyTo = range.to < today ? range.to : shiftDay(today, -1);
  const collected = new Map<string, BreakdownRow[][]>();
  const push = (dim: string, rows: BreakdownRow[]): void => {
    const lists = collected.get(dim);
    if (lists) lists.push(rows);
    else collected.set(dim, [rows]);
  };
  const pushAll = (ranked: Ranked): void => {
    for (const [dim, rows] of ranked) push(dim, rows);
  };
  for (const [dim, lists] of extra) for (const rows of lists) push(dim, rows);

  let reconstructedDirect = 0;
  const reconstruct = (rows: (BreakdownRow & { dim: string })[], totalViews: number): void => {
    for (const dim of dims) {
      push(
        dim,
        rows.filter((row) => row.dim === dim).map(({ name, value, visits }) => ({ name, value, visits })),
      );
    }
    if (dims.includes('referrer')) {
      const attributed = rows.filter((row) => row.dim === 'referrer').reduce((sum, row) => sum + row.value, 0);
      reconstructedDirect += Math.max(0, totalViews - attributed);
    }
  };

  if (range.from <= historyTo) {
    if (filters.length > 0) {
      pushAll(await cubeBreakdowns(db, siteId, range.from, historyTo, filters, dims));
    } else {
      const { rows, totalViews } = await breakdownsFromDaily(db, siteId, range.from, historyTo, dims);
      reconstruct(rows, totalViews);
    }
  }

  if (range.to >= today && range.from <= today) {
    const tables = await rawTablesForDay(db, today);
    if (filters.length > 0) {
      pushAll(await rawBreakdowns(db, siteId, tables, filters, dims, true));
    } else {
      const folded = tables.filter(isFolded);
      const { rows, totalViews } = await breakdownsFromHours(db, siteId, folded.map(hourOf), dims);
      reconstruct(rows, totalViews);
      // Unfolded hours are read raw; entry and exit need the whole day, since
      // a visit's first page may sit in a folded hour and its last in this one.
      pushAll(await rawBreakdowns(db, siteId, tables.filter((t) => !isFolded(t)), [], dims.filter((d) => d !== 'entry' && d !== 'exit')));
      pushAll(await rawBreakdowns(db, siteId, tables, [], dims.filter((d) => d === 'entry' || d === 'exit'), true));
    }
  }

  const out: Record<string, BreakdownRow[]> = {};
  for (const dim of dims) {
    const merged = mergeRows(...(collected.get(dim) ?? []));

    if (dim === 'referrer') {
      const empty = merged.get('');
      const direct = reconstructedDirect + (empty?.value ?? 0);
      if (direct > 0) {
        merged.set(DIRECT, { name: DIRECT, value: direct, visits: empty?.visits ?? 0 });
      }
    }
    merged.delete('');

    out[dim] = [...merged.values()]
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
  return out;
}

/** Single-dimension convenience, kept for the documented `?dim=path` form. */
export async function loadBreakdown(
  db: D1Database,
  siteId: number,
  range: { from: string; to: string },
  filters: Filter[],
  dim: BreakdownDim,
  limit: number,
  now: Date,
): Promise<BreakdownRow[]> {
  return (await loadBreakdowns(db, siteId, range, filters, [dim], limit, now))[dim] ?? [];
}

/* ---------------------------------------------------------- event series -- */

export interface EventSeries {
  granularity: Granularity;
  labels: string[];
  /** How many times the event fired in each bucket. */
  count: number[];
  /**
   * Distinct users (daily visitors) who fired it: per hour on an hourly
   * series; per day, summed over the days of a week or month bucket,
   * otherwise. The same upper bounds as `/api/events` apply: today
   * unfiltered is summed over its hours, and filtered finished days come
   * from the cube, where a user is distinct per dimension tuple.
   */
  users: number[];
}

/**
 * One custom event over a range, bucketed like the dashboard's series.
 *
 * Finished days cost one primary-key probe each unfiltered (stats_daily keeps
 * the event as its own `dim = 'event'` row, with users recounted exactly by
 * the nightly rollup), or one walk of the range's event tuples in the cube
 * filtered. Today's folded hours read only this event's entry of each packed
 * hourly row (json_extract is one row read, not one per entry); only the
 * hours not yet folded, or today under a filter, are read from raw events.
 */
export async function loadEventSeries(
  db: D1Database,
  siteId: number,
  range: Range,
  event: string,
  filters: Filter[],
  now: Date,
): Promise<EventSeries> {
  const split = await splitRange(db, range.from, range.to);
  if (!split.fresh) return legacyEventSeries(db, siteId, range, event, filters, now);
  const byHour = range.granularity === 'hour';
  const count = new Map<string, number>();
  const users = new Map<string, number>();
  const bump = (label: string, n: number, u: number): void => {
    count.set(label, (count.get(label) ?? 0) + n);
    users.set(label, (users.get(label) ?? 0) + u);
  };
  if (split.legacy) {
    const older = await legacyEventSeries(db, siteId, { ...range, from: split.legacy.from, to: split.legacy.to }, event, filters, now);
    older.labels.forEach((label, i) => bump(label, older.count[i] ?? 0, older.users[i] ?? 0));
  }
  for (const [label, [n, u]] of await freshEventSeries(db, siteId, split.fresh.from, split.fresh.to, event, filters, byHour, now)) {
    bump(byHour ? label : bucketLabel(label, range.granularity), n, u);
  }
  const labels = labelsFor(range, now);
  return {
    granularity: range.granularity,
    labels,
    count: labels.map((l) => count.get(l) ?? 0),
    users: labels.map((l) => users.get(l) ?? 0),
  };
}

async function legacyEventSeries(
  db: D1Database,
  siteId: number,
  range: Range,
  event: string,
  filters: Filter[],
  now: Date,
): Promise<EventSeries> {
  const today = partsFor(now).day;
  const byHour = range.granularity === 'hour';
  const count = new Map<string, number>();
  const users = new Map<string, number>();
  const bump = (label: string, n: number, u: number): void => {
    count.set(label, (count.get(label) ?? 0) + Number(n ?? 0));
    users.set(label, (users.get(label) ?? 0) + Number(u ?? 0));
  };
  const { sql: where, binds } = filterClause(filters);
  const path = `'$.event.' || json_quote(?)`;

  const hourly = async (day: string): Promise<void> => {
    // Every packed hour of one day (today's folded hours, or a finished day
    // while its hourly rows are kept): this event's entry only.
    const { results } = await db
      .prepare(
        `SELECT hour, json_extract(dims, ${path} || '[0]') AS n, json_extract(dims, ${path} || '[1]') AS u
         FROM stats_hourly
         WHERE site_id = ? AND hour IN (${hourList(day)}) AND dim = '_total' AND val = '' AND dims <> ''`,
      )
      .bind(event, event, siteId)
      .all<{ hour: string; n: number | null; u: number | null }>();
    for (const row of results) {
      if (row.n !== null) bump(byHour ? row.hour : bucketLabel(day, range.granularity), row.n, row.u ?? 0);
    }
  };

  if (byHour && filters.length === 0) {
    await hourly(range.from);
  } else if (!byHour) {
    const historyTo = range.to < today ? range.to : shiftDay(today, -1);
    if (range.from <= historyTo) {
      let results: { day: string; n: number; u: number }[];
      if (filters.length === 0) {
        ({ results } = await db
          .prepare(
            `SELECT day, pageviews AS n, visitors AS u FROM stats_daily
             WHERE site_id = ? AND day IN (${keyList(range.from, historyTo, (d) => shiftDay(d, 1))})
               AND dim = 'event' AND val = ?`,
          )
          .bind(siteId, event)
          .all<{ day: string; n: number; u: number }>());
      } else {
        const cube = cubeSource(await cubeCutoff(db), siteId, range.from, historyTo, 'events');
        ({ results } = await db
          .prepare(
            `SELECT day, SUM(pageviews) AS n, SUM(visitors) AS u FROM (${cube.sql})
             WHERE name = ?${where} GROUP BY day`,
          )
          .bind(...cube.binds, event, ...binds)
          .all<{ day: string; n: number; u: number }>());
      }
      for (const row of results) bump(bucketLabel(row.day, range.granularity), row.n, row.u);
    }
  }
  // A finished day at hour resolution under a filter has no source left (its
  // raw tables are gone, its hourly rows carry no tuples), so it comes back
  // empty rather than wrong — the same rule as the summary's past hours.

  if (range.from <= today && range.to >= today) {
    const all = await rawTablesForDay(db, today);
    // Unfiltered, today's folded hours come from their packed rows and its
    // users are summed over hours — the same upper bound /api/events gives
    // for today. Filtered, the packed rows cannot narrow, so all of today is
    // read raw and its users are exact.
    if (!byHour && filters.length === 0) await hourly(today);
    const tables = filters.length === 0 ? all.filter((t) => !isFolded(t)) : all;
    if (tables.length > 0) {
      const source = siteEvents(tables, siteId);
      // Grouped by hour unfiltered, so users sum per hour like the packed rows.
      const label = byHour || filters.length === 0 ? `strftime('%Y-%m-%dT%H', ts, 'unixepoch')` : `'${today}'`;
      try {
        const { results } = await withCurrentRawTables(db, tables, () =>
          db
            .prepare(
              `SELECT ${label} AS label, COUNT(*) AS n, COUNT(DISTINCT visitor) AS u
               FROM (${source.sql}) WHERE name = ?${where} GROUP BY label`,
            )
            .bind(...source.binds, event, ...binds)
            .all<{ label: string; n: number; u: number }>(),
        );
        for (const row of results) bump(byHour ? row.label : bucketLabel(today, range.granularity), row.n, row.u);
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    }
  }

  const labels = labelsFor(range, now);
  return {
    granularity: range.granularity,
    labels,
    count: labels.map((l) => count.get(l) ?? 0),
    users: labels.map((l) => users.get(l) ?? 0),
  };
}

/* -------------------------------------------------------------- realtime -- */

export interface Realtime {
  /** Visitors online now: a web visitor for 300 s after their last request, an app for 600 s after its last screen view. */
  online: number;
  /** The web window behind `online`, in seconds (apps: 600). */
  online_window_s: number;
  /**
   * Views per minute by event time over the last 30 minutes. With `since`,
   * only the views that arrived after it: the client adds them to what it has.
   */
  minutes: { label: string; cur: number }[];
  /** Epoch seconds of minutes[0]; minute i starts at first_minute + 60·i (for merging polls). */
  first_minute: number;
  /** The latest views (newest first), only those after `since` when it is given. */
  recent: { ts: number; path: string; country: string }[];
  /** Pass back as `since` on the next poll. */
  cursor: string;
  /** True when this answer is the whole window (no `since`, or one too old): replace, do not merge. */
  full: boolean;
}

const REALTIME_WINDOW = 30 * 60;

/**
 * Per isolate, per site: who may be online as of the last answer's cursor
 * (short visitor hash -> online until). Never leaves the isolate; a poll that
 * lands on another isolate reads the day_state's arrivals instead.
 */
const liveCache = new Map<number, { cursor: [number, string]; arrived: Map<string, number> }>();
const REALTIME_SETTLE = 5;

/** `since=<ts>.<k>` as a cursor, or null when malformed. */
export function parseRealtimeCursor(raw: string | undefined | null): [number, string] | null {
  if (!raw) return null;
  const m = /^(\d{1,12})\.(-?\d{1,20})$/.exec(raw);
  if (!m) return null;
  try {
    BigInt(m[2]!);
  } catch {
    return null;
  }
  return [Number(m[1]), m[2]!];
}

type LiveRow = Pick<FoldRow, 'ts' | 'k' | 'visitor' | 'name' | 'path' | 'country' | 'batch'> & { ts1: number };

/**
 * The live panel. Without `since` it reads the last half hour; with it, only
 * the rows that arrived after it, plus whatever the online count needs: the
 * site's day_state keeps who arrived in the 15 minutes before its cursor
 * (core.a, one json_extract), so only the rows after the state's cursor are
 * read for it — at most ten minutes of them, normally a few. The tables are
 * addressed by name, keyed by (site_id, ts), so every read is a seek; no
 * visitor id leaves this function.
 */
export async function loadRealtime(db: D1Database, siteId: number, now: Date, since?: string | null): Promise<Realtime> {
  const nowS = Math.floor(now.getTime() / 1000);
  const until = nowS - REALTIME_SETTLE;
  const windowStart = nowS - REALTIME_WINDOW;
  const asked = parseRealtimeCursor(since);
  const incremental = asked !== null && asked[0] >= windowStart && asked[0] <= nowS;
  const after: [number, string] = incremental ? asked : [windowStart - 1, MAX_K];

  let onlineFrom: [number, string] = [nowS - 901, MAX_K];
  let arrived = new Map<string, number>();
  const kept = liveCache.get(siteId);
  if (incremental && kept && kept.cursor[0] === asked[0] && kept.cursor[1] === asked[1]) {
    // The same isolate answered the previous poll: it still holds who was
    // online then, so only the rows after `since` are read.
    arrived = new Map(kept.arrived);
    onlineFrom = asked;
  } else if (incremental) {
    const head = await db
      .prepare(
        `SELECT cur_ts, cur_k, CASE WHEN fmt < 512 THEN json_extract(core, '$.a') END AS a
         FROM day_state WHERE site_id = ?`,
      )
      .bind(siteId * 16)
      .first<{ cur_ts: number; cur_k: string; a: string | null }>()
      .catch((error: unknown) => {
        if (isGone(error)) return null;
        throw error;
      });
    if (head && head.a !== null && head.cur_ts >= nowS - 900) {
      for (const [key, [, until]] of Object.entries(JSON.parse(head.a) as Record<string, [number, number]>)) arrived.set(key, until);
      onlineFrom = [head.cur_ts, String(head.cur_k)];
    }
  }
  const from = compareCursor(onlineFrom, after) < 0 ? onlineFrom : after;

  const rows: LiveRow[] = [];
  for (let hour = Math.floor(Math.max(from[0], 0) / 3600); hour <= Math.floor(until / 3600); hour += 1) {
    const table = rawTable(partsFor(new Date(hour * 3_600_000)).suffix);
    try {
      const { results } = await db
        .prepare(
          `SELECT ts, CAST(k AS TEXT) AS k, visitor, name, path, country, batch, ts1 FROM ${table}
           WHERE site_id = ? AND ts >= ? AND ts <= ? AND (ts > ? OR k > CAST(? AS INTEGER))
           ORDER BY ${table}.ts, ${table}.k LIMIT 20000`,
        )
        .bind(siteId, from[0], until, from[0], from[1])
        .all<LiveRow>();
      rows.push(...results);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  const currentMinute = Math.floor(nowS / 60);
  const minutes = Array.from({ length: 30 }, (_, i) => ({ label: `${30 - i}m`, at: currentMinute - (29 - i) }));
  const counts = new Map<number, number>();
  const views: { ts: number; path: string; country: string }[] = [];
  let cursor: [number, string] = incremental ? asked : [until, MAX_K];
  if (!incremental) cursor = [Math.min(until, windowStart + REALTIME_WINDOW), MAX_K];
  let last: [number, string] | null = null;
  for (const row of rows) {
    const k = String(row.k);
    if (row.ts >= nowS - 900) {
      const until = row.batch && row.ts1 > 0 ? row.ts1 + 600 : row.ts + 300;
      const key = row.visitor.slice(0, 12);
      if (until > (arrived.get(key) ?? 0)) arrived.set(key, until);
    }
    if (compareCursor([row.ts, k], after) <= 0) continue;
    last = [row.ts, k];
    let events: [number, string, string][] = [];
    if (!row.batch) events = [[row.ts, row.name, row.path]];
    else {
      try {
        events = (JSON.parse(row.batch) as unknown[][]).map((e) => [Number(e[0]) || row.ts, String(e[1] ?? ''), String(e[2] ?? '')]);
      } catch {
        events = [];
      }
    }
    for (const [t, name, path] of events) {
      if (name !== 'pageview') continue;
      const minute = Math.floor(t / 60);
      counts.set(minute, (counts.get(minute) ?? 0) + 1);
      views.push({ ts: t, path, country: row.country ?? '' });
    }
  }
  if (last) cursor = last;
  let online = 0;
  for (const [key, until] of arrived) {
    if (until >= nowS) online += 1;
    else arrived.delete(key);
  }
  liveCache.set(siteId, { cursor, arrived });
  while (liveCache.size > 32) liveCache.delete(liveCache.keys().next().value as number);
  views.sort((a, b) => b.ts - a.ts);
  return {
    online,
    online_window_s: 300,
    minutes: minutes.map((m) => ({ label: m.label, cur: counts.get(m.at) ?? 0 })),
    first_minute: minutes[0]!.at * 60,
    recent: views.slice(0, 8),
    cursor: `${cursor[0]}.${cursor[1]}`,
    full: !incremental,
  };
}
