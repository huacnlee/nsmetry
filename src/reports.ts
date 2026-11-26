/**
 * The analytics reports behind both the HTTP API and the MCP tools.
 *
 * Each report used to live inside its /api route handler. The MCP server
 * (src/mcp.ts) answers the same questions for AI agents, and two copies of
 * "resolve the range, catch up today, load the series" would drift — an agent
 * and the app must never disagree about a number. So the handlers and the
 * tools both call these, and only translate their own input and output.
 *
 * Failures are thrown as ReportError rather than returned, so a caller cannot
 * forget to check: the HTTP app maps them to `{ error }` with their status in
 * its onError hook, and the MCP server turns them into a tool error the model
 * can read and correct.
 */

import { BREAKDOWN_DIMS, type BreakdownDim, isBreakdownDim } from './dimensions';
import {
  METRICS,
  type Bucket,
  type Components,
  type Metric,
  type Filter,
  type Range,
  bucketLabelOf,
  bucketOf,
  loadRankings,
  loadRealtime,
  loadSeries,
  loadTotals,
  filterSpanError,
  metricValue,
  parseFilters,
  resolveRange,
  totalsFrom,
} from './query';
import { catchUpToday } from './rollup';
import { cutDay } from './reads';
import { blocksFrom } from './state';
import { partsFor } from './time';
import type { SiteRow } from './stats';
import { type UserRow, accessibleSites, isOwner } from './users';

export class ReportError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'ReportError';
  }
}

/* ------------------------------------------------------------------ sites -- */

/**
 * The site a caller is asking about, checked against what this user may read.
 *
 * `ref` is a site id, a site's domain or name, or undefined. With no ref the
 * first readable site is the answer when `defaultFirst` is set — the app opens
 * on "whatever you have" — and an error otherwise, because an agent that forgot
 * to say which site must not silently get numbers about a different one.
 *
 * Authorisation is the accessible-site list itself, read from the grant table,
 * so a crafted id or name cannot reach a site the user was not given. An id the
 * administrator asks for that does not exist is a 404; for a viewer every
 * unreadable site is a 403, whether or not it exists, so a viewer cannot probe
 * which sites are on the instance.
 */
export async function findSite(
  db: D1Database,
  user: UserRow,
  ref: number | string | undefined,
  defaultFirst: boolean,
): Promise<SiteRow> {
  const sites = await accessibleSites(db, user);
  if (sites.length === 0) throw new ReportError(404, 'no sites available');

  if (ref === undefined || ref === '') {
    if (defaultFirst) return sites[0]!;
    throw new ReportError(400, 'say which site: its id or its name (see list_sites)');
  }

  const key = typeof ref === 'number' ? ref : ref.trim().toLowerCase();
  const site =
    typeof key === 'number' || /^\d+$/.test(key)
      ? sites.find((s) => s.id === Number(key))
      : sites.find((s) => s.domain === key);
  if (site) return site;
  throw isOwner(user) ? new ReportError(404, 'no such site') : new ReportError(403, 'forbidden');
}

/* ---------------------------------------------------------------- reports -- */

/** The query every report shares: a preset range or a from/to pair, filters, compare. */
export interface ReportQuery {
  range?: string;
  from?: string;
  to?: string;
  /** `dim:value,dim:value`, values percent-encoded, as in the HTTP API's `f`. */
  f?: string;
  compare?: boolean;
}

function rangeFor(query: ReportQuery, now: Date): Range {
  const range = resolveRange(query.range, query.from, query.to, now);
  if (!range) throw new ReportError(400, 'invalid range');
  return range;
}

/** 400 for a filter stack over a window too long to read affordably (see MAX_FILTERED_DAYS). */
function checkFilterSpan(range: Range, filters: Filter[]): void {
  const error = filterSpanError(range.from, range.to, filters);
  if (error) throw new ReportError(400, error);
}

function summarize(components: Components): Record<Metric, number> {
  return Object.fromEntries(METRICS.map((m) => [m, metricValue(m, components)])) as Record<
    Metric,
    number
  >;
}

/**
 * GET /api/summary: the totals and per-bucket series for all five metrics.
 *
 * The series is returned for every metric rather than just one, because the
 * app's metric rail draws a sparkline for each and the numbers are already in
 * hand — splitting them across five requests would cost five times the
 * database work to show the same screen.
 */
export async function summaryReport(db: D1Database, site: SiteRow, query: ReportQuery, now: Date) {
  const range = rangeFor(query, now);
  const filters = parseFilters(query.f);
  checkFilterSpan(range, filters);

  await catchUpToday(db, now);

  const today = partsFor(now).day;
  // A range that ends today is compared at the same time of day: the
  // comparison's last day (the one lined up with today) is cut at the current
  // ten-minute bucket, on days the fold owns (src/reads.ts cutDay). Older days
  // keep the whole-day comparison.
  const cutover = await blocksFrom(db);
  const sameTime = range.to === today && cutover !== null && range.prevTo >= cutover && filters.length === 0;
  const [series, previousSeries] = await Promise.all([
    loadSeries(db, site.id, range, range.from, range.to, filters, now),
    query.compare
      ? loadSeries(db, site.id, range, range.prevFrom, range.prevTo, filters, now, sameTime)
      : Promise.resolve(null),
  ]);
  if (previousSeries && sameTime && range.granularity !== 'hour') {
    const [full, cut] = await Promise.all([
      loadTotals(db, site.id, range.prevTo, range.prevTo, filters, now),
      cutDay(db, site.id, range.prevTo, bucketOf(now), now),
    ]);
    if (cut) {
      const label = bucketLabelOf(range.prevTo, range.granularity);
      const bucket = previousSeries.find((b) => b.label === label);
      if (bucket) {
        bucket.views += cut.views - full.views;
        bucket.visits += cut.visits - full.visits;
        bucket.bounces += cut.bounces - full.bounces;
        bucket.duration += cut.duration - full.duration;
      }
    }
  }

  // An hourly series of a finished day (the comparison window of
  // range=today) comes from stats_hourly, where a visit is a visitor-hour:
  // summed, a visitor active in three hours would count three times, bounce
  // rate would sit near 100% and time near zero. Its totals are taken instead
  // from that day's exact daily rollup — all of that day, which docs/api.md
  // states. Today's own hourly series is read from raw rows and sums exactly.
  const exactTotals = (buckets: Bucket[], from: string, to: string): Promise<Components> | Components =>
    range.granularity === 'hour' && from !== today && !(sameTime || (cutover !== null && from >= cutover && filters.length === 0))
      ? loadTotals(db, site.id, from, to, filters, now)
      : totalsFrom(buckets);
  const [totals, previousTotals] = await Promise.all([
    exactTotals(series, range.from, range.to),
    previousSeries ? exactTotals(previousSeries, range.prevFrom, range.prevTo) : null,
  ]);

  const per = (buckets: typeof series | null): Record<Metric, number[]> | null =>
    buckets &&
    (Object.fromEntries(
      METRICS.map((m) => [m, buckets.map((b) => metricValue(m, b))]),
    ) as Record<Metric, number[]>);

  return {
    site,
    range,
    filters,
    totals: summarize(totals),
    previous: previousTotals ? summarize(previousTotals) : null,
    series: {
      labels: series.map((b) => b.label),
      cur: per(series),
      // Trimmed to the current window's length so the two line up point for
      // point; a partial "today" must not be compared against a whole day.
      prev: previousSeries ? per(previousSeries.slice(0, series.length)) : null,
    },
    // Whether the comparison stops at this time of day ('same_time') or runs
    // the whole of its last day ('whole_day').
    comparison: sameTime ? ('same_time' as const) : ('whole_day' as const),
    // Under a path filter, visits are the ones that *started* on that path —
    // the cube cannot know which other visits passed through it later.
    visitsBasis: filters.some((f) => f.dim === 'path') ? ('entrances' as const) : ('exact' as const),
  };
}

export function isMetric(value: string): value is Metric {
  return (METRICS as readonly string[]).includes(value);
}

/** GET /api/timeseries: one metric, point by point, with the previous window alongside. */
export async function timeseriesReport(
  db: D1Database,
  site: SiteRow,
  query: ReportQuery & { metric?: string },
  now: Date,
) {
  const range = rangeFor(query, now);
  const requested = query.metric ?? 'visitors';
  if (!isMetric(requested)) throw new ReportError(400, 'unknown metric');
  const filters = parseFilters(query.f);
  checkFilterSpan(range, filters);

  await catchUpToday(db, now);

  const series = await loadSeries(db, site.id, range, range.from, range.to, filters, now);
  const previous = query.compare
    ? await loadSeries(db, site.id, range, range.prevFrom, range.prevTo, filters, now)
    : [];

  return {
    granularity: range.granularity,
    points: series.map((bucket, i) => ({
      label: bucket.label,
      cur: metricValue(requested, bucket),
      prev: previous[i] ? metricValue(requested, previous[i]!) : null,
    })),
  };
}

export const MAX_BREAKDOWN_LIMIT = 50;

/**
 * GET /api/breakdown: rank one or more dimensions. Several in one call is what
 * the app does — six panels, one request.
 */
export async function breakdownReport(
  db: D1Database,
  site: SiteRow,
  query: ReportQuery & { dims: readonly string[]; limit?: number },
  now: Date,
) {
  const range = rangeFor(query, now);
  const dims = query.dims.map((d) => d.trim()).filter(isBreakdownDim);
  if (dims.length === 0) {
    throw new ReportError(400, `unknown dimension; use one of ${BREAKDOWN_DIMS.join(', ')}`);
  }
  const limit =
    query.limit !== undefined && Number.isInteger(query.limit)
      ? Math.min(Math.max(query.limit, 1), MAX_BREAKDOWN_LIMIT)
      : 10;
  const filters = parseFilters(query.f);
  checkFilterSpan(range, filters);

  await catchUpToday(db, now);

  const { breakdowns, approx } = await loadRankings(db, site.id, range, filters, dims as BreakdownDim[], limit, now);
  return { breakdowns, rows: dims.length === 1 ? breakdowns[dims[0]!] : undefined, ...(approx ? { approx: true } : {}) };
}

/** GET /api/realtime: who is here in the last half hour; `since` (a previous answer's cursor) asks only what is new. */
export function realtimeReport(db: D1Database, site: SiteRow, now: Date, since?: string | null) {
  return loadRealtime(db, site.id, now, since);
}
