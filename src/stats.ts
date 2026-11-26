/**
 * The original console's `/api/stats` payload, and the site row type.
 *
 * Kept for anything still calling /api/stats; the numbers come from
 * src/query.ts, the one read model every endpoint shares.
 */

import { rawRows, rawTable } from './db';
import { type Range, loadBreakdowns, loadSeries, totalsFrom } from './query';
import { partsFor } from './time';

export interface Bucket {
  value: string;
  pageviews: number;
  visitors: number;
}

export interface SeriesPoint {
  label: string;
  pageviews: number;
  visitors: number;
}

export interface StatsPayload {
  from: string;
  to: string;
  granularity: 'hour' | 'day';
  totals: { pageviews: number; visitors: number };
  series: SeriesPoint[];
  breakdowns: Record<string, Bucket[]>;
  live: { pageviews: number; visitors: number };
}

export const BREAKDOWN_DIMENSIONS = [
  'path',
  'referrer',
  'country',
  'browser',
  'os',
  'device',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'event',
] as const;

const TOP_N = 12;

export interface SiteRow {
  id: number;
  domain: string;
  created_at: number;
}

export async function listSites(db: D1Database): Promise<SiteRow[]> {
  const { results } = await db
    .prepare('SELECT id, domain, created_at FROM sites ORDER BY domain')
    .all<SiteRow>();
  return results;
}

/**
 * The live hour: the raw table currently being written to, at row level.
 *
 * Reported separately because the old console labelled it; the totals and
 * rankings below already include it.
 */
async function liveCounts(db: D1Database, siteId: number, now: Date): Promise<{ pageviews: number; visitors: number }> {
  const table = rawTable(partsFor(now).suffix);
  try {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(views), 0) AS pageviews,
                COUNT(DISTINCT CASE WHEN views > 0 THEN visitor END) AS visitors
         FROM (${rawRows(table, 'site_id = ?')})`,
      )
      .bind(siteId)
      .first<{ pageviews: number; visitors: number }>();
    return { pageviews: row?.pageviews ?? 0, visitors: row?.visitors ?? 0 };
  } catch (error) {
    // No traffic yet this hour means the table does not exist. That is normal.
    if (/no such table|no such column/i.test(String(error))) return { pageviews: 0, visitors: 0 };
    throw error;
  }
}

/**
 * `GET /api/stats`, the console's original payload, answered by the same read
 * model as /api/summary and /api/breakdown (src/query.ts), so the two can
 * never disagree about a number.
 */
export async function getStats(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  now: Date,
): Promise<StatsPayload> {
  const granularity = from === to ? 'hour' : 'day';
  const range: Range = {
    id: 'custom',
    from,
    to,
    prevFrom: from,
    prevTo: to,
    granularity,
    prevLabel: '',
  };

  const [series, rankings, live] = await Promise.all([
    loadSeries(db, siteId, range, from, to, [], now),
    loadBreakdowns(db, siteId, { from, to }, [], [...BREAKDOWN_DIMENSIONS], TOP_N, now),
    to >= partsFor(now).day ? liveCounts(db, siteId, now) : Promise.resolve({ pageviews: 0, visitors: 0 }),
  ]);
  const totals = totalsFrom(series);

  const breakdowns: Record<string, Bucket[]> = {};
  for (const dim of BREAKDOWN_DIMENSIONS) {
    breakdowns[dim] = (rankings[dim] ?? []).map((row) => ({ value: row.name, pageviews: row.value, visitors: row.visits }));
  }

  return {
    from,
    to,
    granularity,
    totals: { pageviews: totals.views, visitors: totals.visits },
    series: series.map((b) => ({ label: b.label, pageviews: b.views, visitors: b.visits })),
    breakdowns,
    live,
  };
}
