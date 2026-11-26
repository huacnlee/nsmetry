/**
 * Rollups.
 *
 * Two crons:
 *   :05 every hour — fold every finished hour of today into stats_hourly and
 *                    rename its table from `ev_` to `ef_` (see db.ts), then
 *                    refresh today's exact visitor count.
 *   00:20 daily    — fold every finished day into stats_daily, the filter cube
 *                    and app_daily, then DROP its raw tables. Dropping is what
 *                    keeps the write budget small.
 *
 * Both are idempotent and self-healing: a missed run is repaired by the next
 * one, because the daily pass folds whatever hours are still unfolded rather
 * than trusting that the hourly pass ran, and the hourly pass picks up any
 * finished day the daily pass left behind.
 *
 * Cost model. D1 bills every row a statement *walks* — table rows, json_each
 * entries, sorter rows — so what matters is how many times each event is
 * walked, and the answer here is "a handful". Questions about the device
 * profile (country, browser, os, device, screen, referrer, utm, app version)
 * are answered at row level: a batch segment is one row however many events it
 * holds, and its profile is the same for all of them. Only the questions that
 * vary per event — which path, which event name, which properties — open the
 * JSON. And the work is per table, never per site, so a site that sent nothing
 * costs nothing.
 *
 * Visits are derived here rather than tracked. A visit is one visitor's
 * pageviews inside the bucket being rolled up, which is the only definition
 * available to a system that stores no session id — and it is why bounce rate
 * and time on site cost nothing extra: they ride along on rows we were already
 * writing.
 */

import {
  CUBE_TUPLE_COLUMNS,
  SETTING_CUBE2_FROM,
  VISIT_STATE_FIELDS,
  alterRawTable,
  dropTables,
  foldedTable,
  hourlyDimRows,
  isFolded,
  listRawTables,
  rawEvents,
  rawRows,
  rawTable,
  rawTablesForDay,
  tableSuffix,
  unionAll,
} from './db';
import { RETENTION_HORIZON_DAYS, addToSketch, encodeSketch, newSketch } from './app-analytics';
import { DIMENSIONS } from './dimensions';
import { shiftDay, weekStart } from './query';
import { dayOffset, partsFor } from './time';
import { pruneSalts } from './visitor';
import { SETTING_BLOCKS_FROM } from './db';
import { epochDay } from './fold';
import { blocksFrom, blocksFromDayNumber, foldUnit, resetBlocksFromCache } from './state';

const HOURLY_UPSERT = `ON CONFLICT(site_id, hour, dim, val) DO UPDATE SET
   pageviews = excluded.pageviews, visitors = excluded.visitors`;

const DAILY_UPSERT = `ON CONFLICT(site_id, day, dim, val) DO UPDATE SET
   pageviews = excluded.pageviews, visitors = excluded.visitors`;

const TOTALS_UPSERT = `${DAILY_UPSERT},
   sessions = excluded.sessions, bounces = excluded.bounces, duration = excluded.duration`;

const HOURLY_TOTALS_UPSERT = `${HOURLY_UPSERT},
   sessions = excluded.sessions, bounces = excluded.bounces, duration = excluded.duration`;

/** Every stored row of a set of tables, at row level. */
function unionRows(tables: string[]): string {
  return unionAll(tables.map((t) => rawRows(t)));
}

/** Every event of a set of tables, segments opened up. */
function unionEvents(tables: string[]): string {
  return unionAll(tables.map((t) => rawEvents(t)));
}

/**
 * One row per visit: how many pages it read and how long it lasted.
 *
 * `span` is the last pageview minus the first, so a single-page visit is zero
 * seconds. That is the honest number — with no unload beacon there is nothing
 * to measure after the last event — and it is why average time is reported
 * over visits that had a second pageview. Read at row level: a segment already
 * knows its pageview count and its first and last pageview times.
 */
function visitsFrom(rows: string): string {
  return `SELECT site_id, visitor, SUM(views) AS views, MAX(lts) - MIN(fts) AS span
          FROM (${rows}) WHERE views > 0
          GROUP BY site_id, visitor`;
}


/** The device-profile dimensions: everything that is one column of a stored row. */
const PROFILE_DIMS = DIMENSIONS.filter((d) => d.dim !== 'path');

/**
 * The statement that folds one raw hour table into stats_hourly: one row per
 * site, the `_total` row, with every dimension's counts packed into `dims`
 * (see hourlyDimRows in db.ts for the shape and why).
 *
 * Path and event name are the two things that differ per event, and each
 * event is exactly one of them, so one pass over the opened segments answers
 * both. Every profile dimension is answered at row level, unpivoted against a
 * constant list and counted by each row's pageview count.
 */
function hourStatement(db: D1Database, table: string, hour: string): D1PreparedStatement {
  // Each row's non-empty profile values as one JSON object, {dim: value}.
  // Unpivoting against the full dimension list instead would walk (and sort)
  // one entry per dimension per row, and for an app most of them — referrer,
  // screen, the three utm fields — are empty on every row. D1 bills each
  // walked entry, so skipping them roughly halves this statement.
  const pairs = `'{' || substr(${PROFILE_DIMS.map(
    (p) => `CASE WHEN r.${p.column} <> '' THEN ',"${p.dim}":' || json_quote(r.${p.column}) ELSE '' END`,
  ).join(' || ')}, 2) || '}'`;

  return db
    .prepare(
      `WITH r AS (${rawRows(table)}),
            visits AS (${visitsFrom('SELECT * FROM r')}),
            totals AS (
              SELECT site_id, SUM(views) AS views, COUNT(*) AS visits,
                     SUM(CASE WHEN views = 1 THEN 1 ELSE 0 END) AS bounces, SUM(span) AS duration
              FROM visits GROUP BY site_id
            ),
            -- Rows sharing a whole device profile, collapsed before the
            -- unpivot: each walked entry is a row read, and an hour of an
            -- app's traffic has far fewer distinct profiles than rows. A
            -- visitor counts once per profile, so one who came back with a
            -- different referrer within the hour counts in both — an upper
            -- bound, like every per-dimension visitor count summed over time.
            profiles AS (
              SELECT site_id, ${PROFILE_DIMS.map((p) => p.column).join(', ')},
                     SUM(views) AS views, COUNT(DISTINCT visitor) AS visitors
              FROM r WHERE views > 0
              GROUP BY site_id, ${PROFILE_DIMS.map((p) => p.column).join(', ')}
            ),
            counted AS (
              SELECT site_id,
                     CASE WHEN name = 'pageview' THEN 'path' ELSE 'event' END AS dim,
                     CASE WHEN name = 'pageview' THEN path ELSE name END AS val,
                     COUNT(*) AS n, COUNT(DISTINCT visitor) AS v
              FROM (${rawEvents(table)})
              WHERE val <> ''
              GROUP BY site_id, dim, val
              UNION ALL
              SELECT r.site_id, d.key AS dim, d.value AS val, SUM(r.views), SUM(r.visitors)
              FROM profiles r, json_each(${pairs}) d
              GROUP BY r.site_id, d.key, d.value
            ),
            per_dim AS (
              SELECT site_id, dim, json_group_object(val, json_array(n, v)) AS o
              FROM counted GROUP BY site_id, dim
            ),
            packed AS (
              SELECT site_id, json_group_object(dim, json(o)) AS dims FROM per_dim GROUP BY site_id
            )
       INSERT INTO stats_hourly (site_id, hour, dim, val, pageviews, visitors, sessions, bounces, duration, dims, props)
       SELECT p.site_id, ?, '_total', '', COALESCE(t.views, 0), COALESCE(t.visits, 0), COALESCE(t.visits, 0),
              COALESCE(t.bounces, 0), COALESCE(t.duration, 0), p.dims, '{}'
       FROM packed p LEFT JOIN totals t ON t.site_id = p.site_id
       WHERE true
       ${HOURLY_TOTALS_UPSERT}, dims = excluded.dims, props = excluded.props`,
    )
    .bind(hour);
}

/**
 * The hour's event property counts onto its `_total` rows (written just
 * before by hourStatement, with `props` '{}'): {event: {key: {value:
 * [events, users]}}}, the shape of app_daily.props,
 * each key's values capped like the daily ones. Today's property reads take
 * the folded hours from here — this event's subtree of a few packed rows —
 * instead of opening every event of the day. Only rows that can hold
 * properties are opened, as in propsStatement.
 */
function hourPropsStatement(db: D1Database, table: string, hour: string): D1PreparedStatement {
  const withProps = "(e.batch = '' AND e.props <> '') OR (e.batch <> '' AND instr(e.batch, '{') > 0)";
  return db
    .prepare(
      `WITH counted AS (
         SELECT e.site_id, e.name, k.key AS key, k.value AS val, COUNT(*) AS n, COUNT(DISTINCT e.visitor) AS v
         FROM (${rawEvents(table, withProps)}) e, json_each(CASE WHEN e.props = '' THEN '{}' ELSE e.props END) k
         WHERE e.props <> ''
         GROUP BY e.site_id, e.name, k.key, k.value
       ),
       capped AS (
         SELECT site_id, name, key, CASE WHEN rn <= ${PROP_VALUES_PER_KEY} THEN val ELSE '${OTHER_VALUE}' END AS val,
                SUM(n) AS n, SUM(v) AS v
         FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY site_id, name, key ORDER BY n DESC, val) AS rn FROM counted)
         GROUP BY site_id, name, key, 4
       ),
       by_key AS (SELECT site_id, name, key, json_group_object(val, json_array(n, v)) AS o FROM capped GROUP BY site_id, name, key),
       by_event AS (SELECT site_id, name, json_group_object(key, json(o)) AS o FROM by_key GROUP BY site_id, name),
       packed AS (SELECT site_id, json_group_object(name, json(o)) AS props FROM by_event GROUP BY site_id)
       UPDATE stats_hourly SET props = packed.props
       FROM packed
       WHERE stats_hourly.site_id = packed.site_id AND stats_hourly.hour = ?
         AND stats_hourly.dim = '_total' AND stats_hourly.val = ''`,
    )
    .bind(hour);
}

const STATE_KEY = 'site_id, visitor, uid, ref, country, browser, os, device, screen, utm_source, utm_medium, utm_campaign, app_version';

/**
 * Merge one hour's rows into today_visits (see db.ts), for the sites that
 * have rows in it.
 *
 * A site's state is carried on only from a state of the same day; a site
 * without one starts fresh only if this is its first folded hour today —
 * otherwise its earlier hours would be missing, so it is stored NULL and its
 * readers keep reading raw rows for the rest of the day. One statement for
 * every site of the hour: per site, the work is its stored entries plus its
 * rows of the hour, each read once and grouped once.
 */
function visitStateStatement(db: D1Database, table: string, hour: string): D1PreparedStatement {
  const day = hour.slice(0, 10);
  const entry = VISIT_STATE_FIELDS.join(', ');
  return db
    .prepare(
      `WITH h AS (SELECT ${STATE_KEY}, views, fts, lts, path, exit_path FROM (${rawRows(table)}) WHERE views > 0),
            st AS MATERIALIZED (
              SELECT s.site_id,
                     CASE
                       WHEN v.day = ? THEN v.visits IS NOT NULL
                       ELSE NOT EXISTS (SELECT 1 FROM stats_hourly x
                                        WHERE x.site_id = s.site_id AND x.hour >= ? AND x.hour < ?
                                          AND x.dim = '_total' AND x.val = '')
                     END AS ok,
                     CASE WHEN v.day = ? THEN v.visits END AS visits
              FROM (SELECT DISTINCT site_id FROM h) s LEFT JOIN today_visits v ON v.site_id = s.site_id
            ),
            prev AS (
              SELECT site_id, ${VISIT_STATE_FIELDS.map((f, i) => `json_extract(j.value, '$[${i}]') AS ${f}`).join(', ')}
              FROM st, json_each(st.visits) j WHERE st.ok AND st.visits IS NOT NULL
            ),
            merged AS (
              SELECT ${STATE_KEY}, SUM(views) AS views, MIN(fts) AS fts, MAX(lts) AS lts,
                     substr(MIN(printf('%012d', fts) || path), 13) AS path,
                     substr(MAX(printf('%012d', lts) || exit_path), 13) AS exit_path
              FROM (SELECT ${STATE_KEY}, views, fts, lts, path, exit_path FROM prev
                    UNION ALL
                    SELECT ${STATE_KEY}, views, fts, lts, path, exit_path FROM h
                    WHERE site_id IN (SELECT site_id FROM st WHERE ok))
              GROUP BY ${STATE_KEY}
            ),
            packed AS (SELECT site_id, json_group_array(json_array(${entry})) AS visits FROM merged GROUP BY site_id)
       INSERT INTO today_visits (site_id, day, through, visits)
       SELECT st.site_id, ?, ?, CASE WHEN st.ok THEN p.visits END
       FROM st LEFT JOIN packed p ON p.site_id = st.site_id
       WHERE true
       ON CONFLICT(site_id) DO UPDATE SET day = excluded.day, through = excluded.through, visits = excluded.visits`,
    )
    .bind(day, `${day}T00`, hour, day, day, hour);
}

/**
 * An hour folded a second time would be merged twice: give up on today's
 * state for every site in it, so their readers go back to the raw rows.
 */
function breakStateStatement(db: D1Database, table: string, day: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE today_visits SET visits = NULL
       WHERE day = ? AND visits IS NOT NULL AND site_id IN (SELECT DISTINCT site_id FROM ${table})`,
    )
    .bind(day);
}

function hourOfTable(table: string): string {
  const suffix = tableSuffix(table);
  return `${suffix.slice(0, 4)}-${suffix.slice(4, 6)}-${suffix.slice(6, 8)}T${suffix.slice(8, 10)}`;
}

function dayOfTable(table: string): string {
  return hourOfTable(table).slice(0, 10);
}

/**
 * Fold one hour and mark it folded.
 *
 * Folding an `ev_` table writes its stats_hourly rows and renames it to `ef_`.
 * If an `ef_` already exists — a straggling insert recreated `ev_` after the
 * hour was folded — the stragglers are moved into it and the whole hour is
 * folded again, because the upserts *replace* an hour's numbers rather than
 * adding to them. That keeps every fold idempotent.
 */
export async function rollupHour(db: D1Database, table: string): Promise<string> {
  try {
    return await foldHour(db, table);
  } catch (error) {
    // Two dashboard requests, or a request and the :05 cron, can fold the same
    // hour at once: the app loads several reports in parallel at the top of
    // every hour. The loser finds its source table already renamed or dropped
    // by the winner. Every fold is idempotent and the winner's is complete, so
    // "no such table" on the source means the work is done, not that a read
    // should fail.
    if (!isFolded(table) && new RegExp(`no such table: ${table}\\b`, 'i').test(String(error))) {
      return foldedTable(tableSuffix(table));
    }
    throw error;
  }
}

async function foldHour(db: D1Database, table: string): Promise<string> {
  await alterRawTable(db, table);
  const suffix = tableSuffix(table);
  const folded = foldedTable(suffix);
  const hour = hourOfTable(table);

  if (isFolded(table)) {
    await db.batch([
      breakStateStatement(db, table, hour.slice(0, 10)),
      hourStatement(db, table, hour),
      hourPropsStatement(db, table, hour),
    ]);
    return table;
  }

  const existing = await db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .bind(folded)
    .first<{ present: number }>();

  if (existing) {
    await alterRawTable(db, folded);
    await db.batch([
      breakStateStatement(db, table, hour.slice(0, 10)),
      db.prepare(`INSERT INTO ${folded} SELECT * FROM ${table}`),
      db.prepare(`DROP TABLE ${table}`),
    ]);
    await db.batch([hourStatement(db, folded, hour), hourPropsStatement(db, folded, hour)]);
    return folded;
  }

  await db.batch([
    hourStatement(db, table, hour),
    hourPropsStatement(db, table, hour),
    visitStateStatement(db, table, hour),
    db.prepare(`ALTER TABLE ${table} RENAME TO ${folded}`),
  ]);
  return folded;
}

/**
 * The day's visit-level numbers in stats_daily: the exact `_total` row and
 * the entry and exit page rankings, in one statement.
 *
 * None of these can be summed out of the hourly rollups — a visitor who reads
 * two pages an hour apart is distinct in each hour, and a visit from 09:58 to
 * 10:03 would contribute an entry *and* an exit to both hours — so they are
 * computed from the day's raw rows while those still exist. Row level (a
 * segment knows its first and last pageview path and time), and one ranked
 * pass shared by all three: as three statements, each would walk the day's
 * rows and sort them again, and D1 bills every one of those rows.
 */
function visitStatement(db: D1Database, day: string, tables: string[]): D1PreparedStatement {
  return db
    .prepare(
      `WITH v AS MATERIALIZED (${visitEdges(unionRows(tables), 'path', 'exit_path')})
       INSERT INTO stats_daily (site_id, day, dim, val, pageviews, visitors, sessions, bounces, duration)
       SELECT site_id, ?, dim, val, SUM(pv), SUM(n), SUM(n), SUM(b), SUM(d)
       FROM (
         SELECT site_id, '_total' AS dim, '' AS val, views AS pv, 1 AS n,
                CASE WHEN views = 1 THEN 1 ELSE 0 END AS b, span AS d
         FROM v
         UNION ALL
         SELECT site_id, 'entry', first, 1, 1, 0, 0 FROM v WHERE first <> ''
         UNION ALL
         SELECT site_id, 'exit', last, 1, 1, 0, 0 FROM v WHERE last <> ''
       )
       GROUP BY site_id, dim, val
       ${TOTALS_UPSERT}`,
    )
    .bind(day);
}

/**
 * The day's custom events with exact distinct users, over the `event` rows the
 * hourly sum just wrote.
 *
 * Summed from the hours, a user who fires an event in three hours counts three
 * times; an event's "users" must be people, so the event dimension is
 * recounted from raw once a day. Only rows that can hold a custom event are
 * opened — a single event that is not a pageview, or a batch segment — so a
 * website's day of plain pageviews is skipped before any json_each walk. It is
 * a walk of an app's day of events all the same (measured in
 * test/budget.test.ts); folding it into propsStatement's walk was tried and
 * cost more, because D1 bills the reads of a materialized CTE as well.
 */
function eventUsersStatement(db: D1Database, day: string, tables: string[]): D1PreparedStatement {
  const events = unionAll(tables.map((t) => rawEvents(t, "e.batch <> '' OR e.name <> 'pageview'")));
  return db
    .prepare(
      `INSERT INTO stats_daily (site_id, day, dim, val, pageviews, visitors)
       SELECT site_id, ?, 'event', name, COUNT(*), COUNT(DISTINCT visitor)
       FROM (${events})
       WHERE name <> 'pageview' AND name <> ''
       GROUP BY site_id, name
       ${DAILY_UPSERT}`,
    )
    .bind(day);
}

/**
 * One row per visit (a visitor's day): its pageviews, its length, and an
 * expression evaluated on its first row and on its last.
 *
 * Window functions would answer "first" and "last" too, but each distinct
 * window ordering is another full sort of the day's rows, and D1 bills every
 * sorted row as read. Prefixing each value with its zero-padded timestamp
 * and taking MIN / MAX gets both out of the one GROUP BY sort that the visit
 * totals need anyway. Ties on the same second resolve by value, which is as
 * good as any other order for events that arrived together.
 */
function visitEdges(rows: string, firstExpr: string, lastExpr: string): string {
  return `SELECT site_id, SUM(views) AS views, MAX(lts) - MIN(fts) AS span,
                 substr(MIN(printf('%012d', fts) || (${firstExpr})), 13) AS first,
                 substr(MAX(printf('%012d', lts) || (${lastExpr})), 13) AS last
          FROM (${rows}) WHERE views > 0
          GROUP BY site_id, visitor`;
}

/**
 * Write the day into the filter cube (stats_cube2): one entry per distinct
 * dimension tuple, packed one row per (site, event name).
 *
 * Two passes, merged per tuple:
 *   - event level: how many pageviews or events each tuple saw, and by how
 *     many visitors;
 *   - row level: visit numbers, attributed to the tuple of the visit's *first*
 *     pageview (entrances, bounces, time) and of its last (exits). Filtering by
 *     country then gives that country's visits, and filtering by path gives the
 *     visits that started there — which is what "entrances" means on the page
 *     detail screen.
 *
 * The packing is what keeps an app affordable: a few thousand tuples a day
 * would be a few thousand rows written, and is instead a dozen.
 */
function cubeStatement(db: D1Database, day: string, tables: string[]): D1PreparedStatement {
  const profile = CUBE_TUPLE_COLUMNS.filter((c) => c !== 'path');
  const tuple = CUBE_TUPLE_COLUMNS.join(', ');
  // A visit's first and last row, each as the JSON array of its tuple.
  const edge = (pathColumn: string): string => `json_array(${[pathColumn, ...profile].join(', ')})`;
  const unpack = (column: string): string =>
    CUBE_TUPLE_COLUMNS.map((_, i) => `json_extract(${column}, '$[${i}]')`).join(', ');

  return db
    .prepare(
      `WITH v AS MATERIALIZED (${visitEdges(unionRows(tables), edge('path'), edge('exit_path'))}),
            measured AS (
              SELECT site_id, name, ${tuple},
                     COUNT(*) AS pageviews, COUNT(DISTINCT visitor) AS visitors,
                     0 AS entrances, 0 AS exits, 0 AS bounces, 0 AS duration
              FROM (${unionEvents(tables)})
              GROUP BY site_id, name, ${tuple}
              UNION ALL
              SELECT site_id, 'pageview', ${unpack('first')},
                     0, 0, 1, 0, CASE WHEN views = 1 THEN 1 ELSE 0 END, span
              FROM v
              UNION ALL
              SELECT site_id, 'pageview', ${unpack('last')}, 0, 0, 0, 1, 0, 0
              FROM v
            ),
            tuples AS (
              SELECT site_id, name, json_array(${tuple},
                       SUM(pageviews), SUM(visitors), SUM(entrances), SUM(exits), SUM(bounces), SUM(duration)) AS entry
              FROM measured
              GROUP BY site_id, name, ${tuple}
            )
       INSERT INTO stats_cube2 (site_id, day, name, tuples)
       SELECT site_id, ?, name, json_group_array(json(entry))
       FROM tuples
       GROUP BY site_id, name
       ON CONFLICT(site_id, day, name) DO UPDATE SET tuples = excluded.tuples`,
    )
    .bind(day);
}

/**
 * Active and first-seen users for the day, one app_daily row per site.
 *
 * "New" is decided against app_users, the first-seen table, by primary-key
 * probes: a uid is new today unless app_users already records an *earlier*
 * first day for it. Comparing against earlier days rather than "is it in
 * app_users at all" is what keeps a re-run of the same day idempotent — the
 * first run has already inserted today's new uids by then.
 *
 * Returns each site's lists so the caller can record the new uids in
 * app_users and sketch the active ones without reading app_daily back.
 */
function activeStatement(db: D1Database, day: string, tables: string[]): D1PreparedStatement {
  return db
    .prepare(
      `WITH active AS (
         SELECT DISTINCT site_id, uid FROM (${unionRows(tables)}) WHERE uid <> ''
       )
       INSERT INTO app_daily (site_id, day, active, new)
       SELECT a.site_id, ?, json_group_array(a.uid),
              COALESCE(json_group_array(a.uid) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM app_users u WHERE u.site_id = a.site_id AND u.uid = a.uid AND u.first_day < ?
              )), '[]')
       FROM active a
       GROUP BY a.site_id
       ON CONFLICT(site_id, day) DO UPDATE SET active = excluded.active, new = excluded.new
       RETURNING site_id, active, new`,
    )
    .bind(day, day);
}

/**
 * Record a day's new uids as first seen that day.
 *
 * ON CONFLICT only moves a first day *earlier*, so a day rolled up late (the
 * daily cron missed, the hourly job caught up out of order) still ends with
 * every uid at its true first day, and a uid already known costs a probe and
 * no row written.
 */
function firstSeenStatement(db: D1Database, siteId: number, day: string, uids: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO app_users (site_id, uid, first_day)
       SELECT ?, value, ? FROM json_each(?) WHERE true
       ON CONFLICT(site_id, uid) DO UPDATE SET first_day = excluded.first_day
       WHERE excluded.first_day < app_users.first_day`,
    )
    .bind(siteId, day, uids);
}

/**
 * The day's retention counts and distinct-user sketch, for one site.
 *
 * `ret` groups the day's active users by first day (looked up in app_users
 * by primary key, after this day's new users were recorded): for each first
 * day in the last RETENTION_HORIZON_DAYS, how many were active today, and how
 * many of those had not already been active earlier this Monday-based week.
 * The second number is what lets a weekly retention cell be a sum of daily
 * counts and still count each user once.
 *
 * The cost is a walk of today's list and of this week's earlier lists — a
 * few days of one app's users, once a day — so that every retention question
 * afterwards reads one row per day instead of joining member lists.
 */
function retentionStatement(db: D1Database, siteId: number, day: string, hll: string): D1PreparedStatement {
  return db
    .prepare(
      `WITH act AS (
         SELECT j.value AS uid FROM app_daily d, json_each(d.active) j WHERE d.site_id = ?1 AND d.day = ?2
       ),
       wk AS MATERIALIZED (
         SELECT DISTINCT j.value AS uid FROM app_daily d, json_each(d.active) j
         WHERE d.site_id = ?1 AND d.day >= ?3 AND d.day < ?2
       ),
       counted AS (
         SELECT u.first_day AS first_day, COUNT(*) AS n,
                SUM(CASE WHEN a.uid IN (SELECT uid FROM wk) THEN 0 ELSE 1 END) AS w
         FROM act a JOIN app_users u ON u.site_id = ?1 AND u.uid = a.uid
         WHERE u.first_day >= ?4
         GROUP BY u.first_day
       )
       INSERT INTO app_daily (site_id, day, ret, hll)
       SELECT ?1, ?2, COALESCE((SELECT json_group_object(first_day, json_array(n, w)) FROM counted), '{}'), ?5
       WHERE true
       ON CONFLICT(site_id, day) DO UPDATE SET ret = excluded.ret, hll = excluded.hll`,
    )
    .bind(siteId, day, weekStart(day), shiftDay(day, -RETENTION_HORIZON_DAYS), hll);
}

/**
 * Values kept per event property key per day; the rest are summed as
 * "(other)". A property is a label to group by, and a key with thousands of
 * distinct values (an id, a timestamp) is a mistake the budget should not pay
 * for every day.
 */
export const PROP_VALUES_PER_KEY = 50;
export const OTHER_VALUE = '(other)';

/**
 * The day's event property counts, packed per site into app_daily.props.
 *
 * Only rows that can hold properties are opened: a single event whose props
 * column is set, or a segment whose JSON has an object in it at all. Every
 * other row is skipped before json_each walks anything, which is what keeps
 * a day of property-less pageviews from paying for this statement.
 */
function propsStatement(db: D1Database, day: string, tables: string[], fromHours: boolean): D1PreparedStatement {
  const withProps = "(batch = '' AND props <> '') OR (batch <> '' AND instr(batch, '{') > 0)";
  // From the hours' packed counts when every hour of the day has them: a few
  // hundred packed entries instead of every event. Users are then summed
  // over hours (someone who used a value in two hours counts twice), the
  // same upper bound as every per-dimension visitor count summed over time.
  const counted = fromHours
    ? `SELECT h.site_id, e.key AS name, k.key AS key, v.key AS val,
              SUM(json_extract(v.value, '$[0]')) AS n, SUM(json_extract(v.value, '$[1]')) AS v
       FROM stats_hourly h, json_each(h.props) e, json_each(e.value) k, json_each(k.value) v
       WHERE h.hour >= '${day}T00' AND h.hour <= '${day}T23' AND h.dim = '_total' AND h.val = '' AND h.props <> '{}'
       GROUP BY h.site_id, e.key, k.key, v.key`
    : `SELECT e.site_id, e.name, k.key AS key, k.value AS val, COUNT(*) AS n, COUNT(DISTINCT e.visitor) AS v
       FROM (${unionAll(tables.map((t) => rawEvents(t, withProps.replaceAll(/\b(batch|props)\b/g, 'e.$1'))))}) e,
            json_each(CASE WHEN e.props = '' THEN '{}' ELSE e.props END) k
       WHERE e.props <> ''
       GROUP BY e.site_id, e.name, k.key, k.value`;
  return db
    .prepare(
      `WITH counted AS (${counted}),
       ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY site_id, name, key ORDER BY n DESC, val) AS rn
         FROM counted
       ),
       capped AS (
         SELECT site_id, name, key, CASE WHEN rn <= ${PROP_VALUES_PER_KEY} THEN val ELSE '${OTHER_VALUE}' END AS val,
                SUM(n) AS n, SUM(v) AS v
         FROM ranked GROUP BY site_id, name, key, 4
       ),
       by_key AS (
         SELECT site_id, name, key, json_group_object(val, json_array(n, v)) AS o
         FROM capped GROUP BY site_id, name, key
       ),
       by_event AS (
         SELECT site_id, name, json_group_object(key, json(o)) AS o FROM by_key GROUP BY site_id, name
       )
       INSERT INTO app_daily (site_id, day, props)
       SELECT site_id, ?, json_group_object(name, json(o)) FROM by_event GROUP BY site_id
       ON CONFLICT(site_id, day) DO UPDATE SET props = excluded.props`,
    )
    .bind(day);
}

async function rollupApps(db: D1Database, day: string, tables: string[]): Promise<void> {
  const { results } = await activeStatement(db, day, tables).all<{ site_id: number; active: string; new: string }>();
  // First days must be recorded before the retention counts look them up; a
  // batch runs in order, in one transaction.
  const statements = results
    .filter((row) => row.new !== '[]')
    .map((row) => firstSeenStatement(db, row.site_id, day, row.new));
  for (const row of results) {
    const sketch = newSketch();
    addToSketch(sketch, JSON.parse(row.active) as string[]);
    statements.push(retentionStatement(db, row.site_id, day, encodeSketch(sketch)));
  }
  if (statements.length > 0) await db.batch(statements);
  // An hour folded before the packed counts existed has props '' and sends
  // the whole day back to the raw events.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day ${day}`);
  const legacy = await db
    .prepare(`SELECT 1 AS x FROM stats_hourly WHERE hour >= ? AND hour <= ? AND dim = '_total' AND val = '' AND props = '' LIMIT 1`)
    .bind(`${day}T00`, `${day}T23`)
    .first();
  await propsStatement(db, day, tables, legacy === null).run();
}

/**
 * Fold one finished day into stats_daily, the cube and app_daily.
 *
 * Per-dimension visitor counts are summed from the hourly rollups and are
 * therefore an upper bound, exactly as in Plausible and GoatCounter. The
 * headline totals row is exact. The dashboard labels which is which.
 */
export async function rollupDay(db: D1Database, day: string, cube = true): Promise<void> {
  // Fold every hour still unfolded, so a missed hourly cron cannot leave a
  // gap in the permanent record.
  for (const table of await rawTablesForDay(db, day)) {
    if (!isFolded(table)) await rollupHour(db, table);
  }
  const tables = await rawTablesForDay(db, day);

  // Summed from the hours rather than recomputed from raw: the packed hourly
  // entries are a few thousand rows to walk where the day's events are a
  // hundred thousand. Per-dimension visitors are therefore an upper bound —
  // someone active in three hours counts three times — exactly as in
  // Plausible and GoatCounter; the `_total` row below is exact.
  await db
    .prepare(
      `INSERT INTO stats_daily (site_id, day, dim, val, pageviews, visitors)
       SELECT site_id, ?, dim, val, SUM(pageviews), SUM(visitors)
       FROM (${hourlyDimRows('hour >= ? AND hour <= ?')})
       GROUP BY site_id, dim, val
       ${DAILY_UPSERT}`,
    )
    .bind(day, `${day}T00`, `${day}T23`, `${day}T00`, `${day}T23`)
    .run();

  if (tables.length > 0) {
    await visitStatement(db, day, tables).run();
    await eventUsersStatement(db, day, tables).run();
    if (cube) {
      // Recorded before the first write, so a reader never sees stats_cube2
      // rows for a day it would still look up in the old table.
      await db
        .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
        .bind(SETTING_CUBE2_FROM, day)
        .run();
      await cubeStatement(db, day, tables).run();
    }
    await rollupApps(db, day, tables);
  }

  await dropTables(db, tables);
  // Its visitor hashes go with the raw rows they were merged from.
  await db.prepare('DELETE FROM today_visits WHERE day <= ?').bind(day).run();
}

/** Days that still have raw tables on disk, excluding today. */
async function finishedDaysWithRawData(db: D1Database, today: string, before?: string): Promise<string[]> {
  const days = new Set<string>();
  const limit = before !== undefined && before < today ? before : today;
  for (const table of await listRawTables(db)) {
    const day = dayOfTable(table);
    if (day < limit) days.add(day);
  }
  return [...days].sort();
}

/**
 * Fold today's finished-but-unfolded hours.
 *
 * Returns whether anything was folded. The hour currently being written to is
 * left alone — readers add it live — and so is every folded hour, so a run
 * with nothing new to do costs one read of the schema, and a site that sent
 * nothing costs nothing at all: the work is per table, never per site.
 *
 * Today's exact totals are not refreshed here. Every reader of today computes
 * them from the raw rows it is reading anyway, and rewriting a `_total` row
 * per site every hour was a hundred rows written a day for a number nobody
 * read until the daily rollup writes it for good.
 */
async function foldToday(db: D1Database, now: Date): Promise<boolean> {
  const { day: today, suffix } = partsFor(now);
  const liveTable = rawTable(suffix);
  const pending = (await rawTablesForDay(db, today)).filter((t) => !isFolded(t) && t !== liveTable);
  if (pending.length === 0) return false;

  for (const table of pending) await rollupHour(db, table);
  return true;
}

export async function hourlyJob(db: D1Database, now: Date, cube = true, before?: string): Promise<void> {
  if (before === undefined || partsFor(now).day < before) await foldToday(db, now);

  // A finished day still on disk is rolled up by the first hourly run after
  // midnight (00:05), not left to the 00:20 daily cron: readers take finished
  // days only from the daily rollups, so until it runs yesterday reads as
  // zero. It also covers a daily cron that did not run at all. Once a day is
  // rolled up its raw tables are gone, so the 00:20 run finds nothing to do.
  for (const day of await finishedDaysWithRawData(db, partsFor(now).day, before)) {
    await rollupDay(db, day, cube);
  }
}

/**
 * Fold in any completed hour of today the cron has not picked up yet.
 *
 * Called on dashboard reads. Between :00 and :05 the hour that just ended is
 * neither folded nor the live hour, so without this the dashboard would read
 * it raw — correct, but at full price. It also means a failed or delayed cron
 * self-repairs on the next page load — and that local development, where
 * crons never fire at all, behaves the same as production.
 */
export async function catchUpToday(db: D1Database, now: Date): Promise<void> {
  // From the fold's cutover on, readers fold the tail themselves (src/reads.ts).
  const cut = await blocksFrom(db);
  if (cut !== null && partsFor(now).day >= cut) return;
  await foldToday(db, now);
}

export async function dailyJob(
  db: D1Database,
  now: Date,
  hourlyRetentionDays: number,
  cube = true,
  before?: string,
): Promise<void> {
  const today = partsFor(now).day;

  for (const day of await finishedDaysWithRawData(db, today, before)) {
    await rollupDay(db, day, cube);
  }

  const hourlyCutoff = dayOffset(now, -Math.max(1, hourlyRetentionDays));
  await db.prepare('DELETE FROM stats_hourly WHERE hour < ?').bind(`${hourlyCutoff}T00`).run();

  // Two days back: once a salt is gone, that day's hashes can never be recomputed.
  await pruneSalts(db, dayOffset(now, -2));
}

/* ================================================================== fold ==
 *
 * From the first day in SETTING_BLOCKS_FROM on, the hourly and daily rollups
 * above stop writing (stats_hourly, today_visits, stats_daily, stats_cube*,
 * app_daily) and the cursor fold takes over (src/fold.ts, src/state.ts,
 * src/blocks.ts). One cron, every ten minutes:
 *
 *   1. plan: a skip-scan of the current hour table (and the previous one in
 *      the first quarter hour) finds each site with rows, one seek per site,
 *      joined to its day_state cursor; in hour 0 also every state still on an
 *      earlier day. Sites are packed into units of about 300 raw rows each,
 *      estimated from each site's rate so far today.
 *   2. dispatch: each unit is one POST /internal/fold through the SELF
 *      service binding, so each gets its own CPU budget (at most 45 a run).
 *      Without the binding, or if it fails, one unit is folded inline.
 *   3. a unit folds each of its sites (state.ts foldSite): an earlier day is
 *      finished first, and only once its cursor reaches the day's end; the
 *      level-0 block and any higher level ending that day are written in the
 *      same batch as the state.
 *   4. nightly (the run in 00:20–00:30, and the 00:25 backstop): DROP raw
 *      tables older than 25 hours that every state has moved past, prune
 *      salts, and drop stats_hourly once no day it holds is still read.
 */

export const MAX_UNITS = 45;

export interface FoldOptions {
  retentionDays: number;
  cube: boolean;
  /** Sends a unit to POST /internal/fold; throws when it cannot. Absent: fold one unit inline. */
  dispatch?: (sites: number[]) => Promise<void>;
  /** The 00:25 backstop: run the nightly part whatever the minute. */
  nightly?: boolean;
}

interface PlanRow {
  id: number;
  last: number | null;
  day: number | null;
  cur_ts: number | null;
  r: number | null;
}

/** Sites with rows after their cursor (or a day to finish), packed into units. */
export async function planFold(db: D1Database, nowSeconds: number): Promise<number[][]> {
  const today = epochDay(nowSeconds);
  const hours = [Math.floor(nowSeconds / 3600)];
  if (nowSeconds % 3600 < 900) hours.unshift(hours[0]! - 1);
  const found = new Map<number, PlanRow>();
  for (const hour of hours) {
    const table = rawTable(partsFor(new Date(hour * 3_600_000)).suffix);
    try {
      const { results } = await db
        .prepare(
          `WITH RECURSIVE s(id) AS (
             SELECT (SELECT site_id FROM ${table} ORDER BY site_id LIMIT 1)
             UNION ALL
             SELECT (SELECT site_id FROM ${table} WHERE site_id > s.id ORDER BY site_id LIMIT 1) FROM s WHERE s.id IS NOT NULL
           )
           SELECT s.id AS id,
                  (SELECT ts FROM ${table} t WHERE t.site_id = s.id ORDER BY ts DESC LIMIT 1) AS last,
                  d.day AS day, d.cur_ts AS cur_ts, CASE WHEN d.fmt < 512 THEN json_extract(d.core, '$.r') END AS r
           FROM s LEFT JOIN day_state d ON d.site_id = s.id * 16
           WHERE s.id IS NOT NULL`,
        )
        .all<PlanRow>();
      for (const row of results) {
        const seen = found.get(row.id);
        if (!seen || (row.last ?? 0) > (seen.last ?? 0)) found.set(row.id, row);
      }
    } catch (error) {
      if (!/no such table/i.test(String(error))) throw error;
    }
  }
  const pending = [...found.values()].filter(
    (r) => r.day === null || r.cur_ts === null || r.day < today || (r.last ?? 0) > r.cur_ts,
  );
  if (nowSeconds - today * 86_400 < 3600) {
    // Hour 0: states still on an earlier day, though their site sent nothing since.
    const { results } = await db
      .prepare(
        `SELECT site_id / 16 AS id, NULL AS last, day, cur_ts, CASE WHEN fmt < 512 THEN json_extract(core, '$.r') END AS r
         FROM day_state WHERE day < ? AND fmt > 0`,
      )
      .bind(today)
      .all<PlanRow>();
    for (const row of results) if (!found.has(row.id)) pending.push(row);
  }
  const slots = Math.max(1, Math.floor((nowSeconds - today * 86_400) / 600));
  const estimate = (r: PlanRow): number =>
    r.day === today && r.r !== null ? Math.min(300, Math.max(1, Math.ceil(r.r / slots))) : 50;
  const sized = pending.map((r) => ({ id: r.id, n: estimate(r) })).sort((a, b) => b.n - a.n || a.id - b.id);
  const units: { sites: number[]; n: number }[] = [];
  for (const site of sized) {
    const unit = units.find((u) => u.n + site.n <= 300);
    if (unit) {
      unit.sites.push(site.id);
      unit.n += site.n;
    } else if (units.length < MAX_UNITS) units.push({ sites: [site.id], n: site.n });
  }
  return units.map((u) => u.sites);
}

/** Fold the units of one plan: dispatched, or the first one inline. Returns how many units ran. */
export async function runFold(db: D1Database, now: Date, options: Pick<FoldOptions, 'dispatch'>): Promise<number> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const from = blocksFromDayNumber(await blocksFrom(db));
  const units = await planFold(db, nowSeconds);
  if (units.length === 0) return 0;
  if (options.dispatch) {
    const settled = await Promise.allSettled(units.map((u) => options.dispatch!(u)));
    if (settled.every((s) => s.status === 'fulfilled')) return units.length;
    console.error(JSON.stringify({ level: 'error', job: 'fold', message: 'dispatch failed; folding one unit inline' }));
  }
  await foldUnit(db, units[0]!, nowSeconds, from);
  return 1;
}

/** Raw tables of fold days that every state has moved past and that ended over 25 hours ago. */
async function dropFoldedTables(db: D1Database, nowSeconds: number, from: string): Promise<void> {
  const oldest = await db
    .prepare('SELECT MIN(day) AS day FROM day_state WHERE fmt > 0')
    .first<{ day: number | null }>();
  const settledDay = oldest?.day ?? epochDay(nowSeconds);
  const tables = (await listRawTables(db)).filter((t) => {
    const day = dayOfTable(t);
    if (day < from) return false;
    const suffix = tableSuffix(t);
    const end = Date.parse(`${day}T${suffix.slice(8, 10)}:00:00Z`) / 1000 + 3600;
    return end < nowSeconds - 25 * 3600 && Math.floor(end / 86_400) <= settledDay;
  });
  await dropTables(db, tables);
}

/**
 * The scheduled run (every ten minutes). Before the cutover day, it runs the
 * older rollups on their old schedule (:00–:10 hourly, 00:20–00:30 daily).
 */
export async function scheduledRun(db: D1Database, now: Date, options: FoldOptions): Promise<void> {
  const today = partsFor(now).day;
  let from = await blocksFrom(db);
  if (from === null) {
    await db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .bind(SETTING_BLOCKS_FROM, dayOffset(now, 1))
      .run();
    resetBlocksFromCache();
    from = (await blocksFrom(db)) ?? dayOffset(now, 1);
  }
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const nightly = options.nightly === true || (hour === 0 && minute >= 20 && minute < 30);

  if (today < from) {
    if (minute < 10) await hourlyJob(db, now, options.cube, from);
    if (nightly) await dailyJob(db, now, options.retentionDays, options.cube, from);
    return;
  }

  if (hour === 0 && minute < 30) {
    // The last older day (the cutover's eve) is rolled up the older way.
    if (shiftDay(today, -1) < from || nightly) {
      for (const day of await finishedDaysWithRawData(db, today, from)) await rollupDay(db, day, options.cube);
    }
  }

  await runFold(db, now, options);

  if (nightly) {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    await dropFoldedTables(db, nowSeconds, from);
    // Nothing older than the cutover is written to stats_hourly any more; once
    // its last day is past the retention it is dropped whole (DELETE would bill
    // a row written per row).
    if (shiftDay(from, Math.max(1, options.retentionDays)) <= today) {
      await db.prepare('DROP TABLE IF EXISTS stats_hourly').run();
    } else {
      const cutoff = dayOffset(now, -Math.max(1, options.retentionDays));
      try {
        await db.prepare('DELETE FROM stats_hourly WHERE hour < ?').bind(`${cutoff}T00`).run();
      } catch (error) {
        if (!/no such table/i.test(String(error))) throw error;
      }
    }
    await pruneSalts(db, dayOffset(now, -2));
  }
}
