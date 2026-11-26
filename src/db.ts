/**
 * Schema and storage helpers.
 *
 * The storage layout is shaped by two hard D1 free-tier limits: 100k rows
 * written per day, where an UPDATE/DELETE costs as much as an INSERT and every
 * secondary index adds another write per row.
 *
 * So:
 *  - Raw events go into a per-hour table with no primary key and no indexes.
 *    One pageview costs exactly one row written.
 *  - Those tables are never DELETEd from. They are rolled up and then DROPped,
 *    and DDL costs no rows written at all. Expiry is free.
 *  - The rollup tables are WITHOUT ROWID, so the primary key *is* the table and
 *    a rollup row costs one write instead of two.
 *
 * Net effect: ~1.2 rows written per pageview end to end, versus ~4 for the
 * obvious "one events table plus a nightly DELETE" design.
 */

import { hourSuffixesForDay } from './time';

/** Raw-event table suffixes are always generated internally, never from input. */
const SUFFIX_PATTERN = /^\d{10}$/;

/**
 * Raw hours come in two states, told apart by the table name alone.
 *
 * `ev_YYYYMMDDHH` is an hour that has not been folded into stats_hourly yet;
 * `ef_YYYYMMDDHH` is one that has. The hourly fold renames the table once it
 * is done, and a rename is DDL — it costs no rows written — so "which hours
 * still have to be read raw" is answered by the schema itself, with no marker
 * rows to write or keep in step. Both kinds stay until the daily rollup drops
 * them, because the day-level numbers (exact visitors, entries, the cube)
 * still need every event of the day.
 *
 * If a straggling insert lands after the rename, `ev_` is simply created again
 * and that one event is read raw until the next fold. Nothing is lost.
 */
export function rawTable(suffix: string): string {
  if (!SUFFIX_PATTERN.test(suffix)) {
    throw new Error(`refusing to build a table name from ${JSON.stringify(suffix)}`);
  }
  return `ev_${suffix}`;
}

export function foldedTable(suffix: string): string {
  return `ef_${rawTable(suffix).slice(3)}`;
}

const TABLE_PATTERN = /^e[vf]_\d{10}$/;

export function isFolded(table: string): boolean {
  return table.startsWith('ef_');
}

/** `YYYYMMDDHH` of a raw table of either kind. */
export function tableSuffix(table: string): string {
  if (!TABLE_PATTERN.test(table)) throw new Error(`not a raw table: ${JSON.stringify(table)}`);
  return table.slice(3);
}

/**
 * D1 rejects a compound SELECT with more than five terms.
 *
 * A day is 24 raw hour tables, and both the rollup and every filtered query
 * need to see all of them at once, so wide unions are nested into a tree of
 * five-term compounds instead of one flat list. Term order is preserved, which
 * matters because callers bind parameters per term.
 */
const MAX_COMPOUND_TERMS = 5;

export function unionAll(selects: string[]): string {
  if (selects.length === 0) throw new Error('refusing to build an empty union');

  let level = selects;
  while (level.length > MAX_COMPOUND_TERMS) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += MAX_COMPOUND_TERMS) {
      next.push(`SELECT * FROM (${level.slice(i, i + MAX_COMPOUND_TERMS).join(' UNION ALL ')})`);
    }
    level = next;
  }
  return level.join(' UNION ALL ');
}

export const RAW_COLUMNS =
  'site_id, ts, visitor, name, path, ref, country, browser, os, device, screen, utm_source, utm_medium, utm_campaign';

/**
 * Columns added for app analytics and for batched ingest.
 *
 * A raw row is either one event (`batch = ''`, the web beacon's case, exactly
 * as before) or one *segment* of a batch: the events of one batch request that
 * share a visitor and a device profile. A segment is one row however many
 * events it carries, because rows written is the free plan's hardest limit and
 * an app flushing ten events at a time would otherwise cost ten. Its per-event
 * part — `[ts, name, path, props]` — sits in `batch` as a JSON array, and the
 * columns summarise it so row-level questions never have to open the JSON:
 *
 *   pv        pageviews (screen views) in the segment
 *   ts0, ts1  first and last of those pageviews' timestamps
 *   path      the first pageview's path, exit_path the last one's
 *   ts        when the segment arrived, so a time window of rows is a time
 *             window of arrivals (see the key below)
 *
 * uid is the per-site hash of the app's user_id ('' when none was sent),
 * app_version is as sent, and props is the cleaned JSON object of a single
 * event's properties ('' when none).
 */
export const RAW_APP_COLUMNS = 'uid, app_version, props, batch, pv, ts0, ts1, exit_path';

/** Everything an insert names, in bind order. */
export const RAW_INSERT_COLUMNS = `${RAW_COLUMNS}, ${RAW_APP_COLUMNS}`;

/**
 * The raw table's DDL.
 *
 * Clustered on (site_id, ts): every reader asks about one site, and most about
 * a window of time, and without an index each of those questions walks every
 * site's rows of the hour — a fleet of a hundred sites would pay for all of
 * them on every dashboard load and every realtime poll. A secondary index
 * would fix the reads but cost a second row written per insert; a WITHOUT
 * ROWID table keyed by the columns themselves fixes them for free, since the
 * row *is* the index entry. `k` is a random tie-breaker so two events of one
 * site in one second never collide; nothing reads it.
 *
 * Tables an older build created stay rowid tables. They are read the same way,
 * only less cheaply, and are gone with the next daily rollup.
 */
export function createRawTableSql(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
    site_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    visitor TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    browser TEXT NOT NULL DEFAULT '',
    os TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    screen TEXT NOT NULL DEFAULT '',
    utm_source TEXT NOT NULL DEFAULT '',
    utm_medium TEXT NOT NULL DEFAULT '',
    utm_campaign TEXT NOT NULL DEFAULT '',
    uid TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    props TEXT NOT NULL DEFAULT '',
    batch TEXT NOT NULL DEFAULT '',
    pv INTEGER NOT NULL DEFAULT 0,
    ts0 INTEGER NOT NULL DEFAULT 0,
    ts1 INTEGER NOT NULL DEFAULT 0,
    exit_path TEXT NOT NULL DEFAULT '',
    k INTEGER NOT NULL DEFAULT (random()),
    PRIMARY KEY (site_id, ts, k)
  ) WITHOUT ROWID`;
}

/*
 * ---- raw helpers -----------------------------------------------------------
 *
 * Every reader goes through one of these two views of a raw table rather than
 * selecting columns by hand, so a single event and a batch segment can never
 * be told apart by accident. Both take an optional row-level predicate that
 * is applied *before* any JSON is opened: D1 bills every element json_each
 * walks as a row read, so filtering on site_id first is what keeps one site's
 * question from paying for every other site's events.
 */

/** Row level: one row per stored row. Cheap — nothing is expanded. */
export function rawRows(table: string, where = ''): string {
  tableSuffix(table);
  return `SELECT site_id, ts, visitor, uid, ref, country, browser, os, device, screen,
            utm_source, utm_medium, utm_campaign, app_version,
            CASE WHEN batch = '' THEN name ELSE '' END AS name,
            CASE WHEN batch = '' THEN (name = 'pageview') ELSE pv END AS views,
            CASE WHEN batch = '' THEN ts ELSE ts0 END AS fts,
            CASE WHEN batch = '' THEN ts ELSE ts1 END AS lts,
            path,
            CASE WHEN batch = '' THEN path ELSE exit_path END AS exit_path
          FROM ${table}${where ? ` WHERE ${where}` : ''}`;
}

/**
 * The fields of one today_visits entry, in array order.
 *
 * An entry is a visitor's rows that share every profile column, merged the
 * way a batch segment merges its events: pageview count, first and last
 * pageview time, first and last path. Every visit-level reader (visits,
 * bounces, time, entry and exit, profile rankings under a profile filter)
 * reads rows at exactly that level, so an entry stands in for the raw rows it
 * merged without changing any answer.
 */
export const VISIT_STATE_FIELDS = [
  'visitor', 'uid', 'ref', 'country', 'browser', 'os', 'device', 'screen',
  'utm_source', 'utm_medium', 'utm_campaign', 'app_version',
  'views', 'fts', 'lts', 'path', 'exit_path',
] as const;

/** today_visits entries as rawRows-shaped rows (`ts` is the first pageview). */
export function visitStateRows(where: string): string {
  const field = (name: (typeof VISIT_STATE_FIELDS)[number]): string =>
    `json_extract(j.value, '$[${VISIT_STATE_FIELDS.indexOf(name)}]')`;
  return `SELECT v.site_id, ${field('fts')} AS ts, ${field('visitor')} AS visitor, ${field('uid')} AS uid,
            ${field('ref')} AS ref, ${field('country')} AS country, ${field('browser')} AS browser,
            ${field('os')} AS os, ${field('device')} AS device, ${field('screen')} AS screen,
            ${field('utm_source')} AS utm_source, ${field('utm_medium')} AS utm_medium,
            ${field('utm_campaign')} AS utm_campaign, ${field('app_version')} AS app_version,
            '' AS name, ${field('views')} AS views, ${field('fts')} AS fts, ${field('lts')} AS lts,
            ${field('path')} AS path, ${field('exit_path')} AS exit_path
          FROM today_visits v, json_each(v.visits) j
          WHERE v.visits IS NOT NULL AND ${where}`;
}

/**
 * Event level: one row per event, segments opened up.
 *
 * A single event walks a one-element array so both kinds share one scan of
 * the table; a UNION of "singles" and "segments" would read every row twice.
 */
export function rawEvents(table: string, where = ''): string {
  tableSuffix(table);
  const pick = (column: string, index: number): string =>
    `CASE WHEN e.batch = '' THEN e.${column} ELSE json_extract(j.value, '$[${index}]') END`;
  return `SELECT e.site_id, ${pick('ts', 0)} AS ts, e.ts AS arrived, e.visitor, e.uid,
            ${pick('name', 1)} AS name, ${pick('path', 2)} AS path,
            e.ref, e.country, e.browser, e.os, e.device, e.screen,
            e.utm_source, e.utm_medium, e.utm_campaign, e.app_version,
            CASE WHEN e.batch = '' THEN e.props ELSE COALESCE(json_extract(j.value, '$[3]'), '') END AS props
          FROM ${table} e, json_each(CASE WHEN e.batch = '' THEN '[0]' ELSE e.batch END) j${
            where ? ` WHERE ${where}` : ''
          }`;
}

/**
 * The dimension columns that make up a stats_cube key, in key order.
 *
 * `name` leads so pageview rows and custom-event rows can never collide.
 */
export const CUBE_DIMENSION_COLUMNS = [
  'name',
  'path',
  'ref',
  'country',
  'browser',
  'os',
  'device',
  'screen',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'app_version',
] as const;

/** The tuple columns of a stats_cube2 entry, i.e. the key past `name`. */
export const CUBE_TUPLE_COLUMNS = CUBE_DIMENSION_COLUMNS.slice(1);

/** Measures stored after the tuple in a stats_cube2 entry, in order. */
export const CUBE_MEASURES = ['pageviews', 'visitors', 'entrances', 'exits', 'bounces', 'duration'] as const;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Settings key holding the first day written to stats_cube2. Set once, never moved. */
export const SETTING_CUBE2_FROM = 'cube2_from';

/**
 * Every cube row for one site and day range, from both cube generations.
 *
 * stats_cube's primary key is the whole dimension tuple, and a WITHOUT ROWID
 * table cannot widen its key in place, so app_version could not simply be
 * added to it. Its successor, stats_cube2, also changes shape for the write
 * budget: one row per (site, day, event name) whose `tuples` column is a JSON
 * array of `[...tuple, ...measures]` entries. An app produces thousands of
 * distinct tuples a day, and the free plan bills writes per row, not per byte;
 * reads are unchanged, since json_each bills each entry it walks exactly as a
 * row would have been billed.
 *
 * The switch-over day is recorded once (SETTING_CUBE2_FROM) by the first
 * rollup that writes stats_cube2. Days before it are read from the old table
 * (with app_version as ''), days from it on from the new one, so no day is
 * ever counted twice and nothing has to be copied or deleted. Returns SQL with
 * named columns plus its bindings: site, from, to for each branch used.
 */
export function cubeSource(
  cutoff: string | null,
  siteId: number,
  from: string,
  to: string,
  names: 'pageview' | 'events' | 'all' = 'all',
): { sql: string; binds: (string | number)[] } {
  if (cutoff !== null && !DAY_PATTERN.test(cutoff)) throw new Error('bad cube cutoff');
  const nameClause =
    names === 'pageview' ? " AND name = 'pageview'" : names === 'events' ? " AND name <> 'pageview'" : '';
  const parts: string[] = [];
  const binds: (string | number)[] = [];

  if (cutoff === null || from < cutoff) {
    const oldTo = cutoff === null || to < cutoff ? to : null;
    parts.push(
      `SELECT site_id, day, ${CUBE_DIMENSION_COLUMNS.slice(0, -1).join(', ')}, '' AS app_version,
              ${CUBE_MEASURES.join(', ')}
       FROM stats_cube
       WHERE site_id = ? AND day >= ? AND day ${oldTo === null ? `< '${cutoff}'` : '<= ?'}${nameClause}`,
    );
    binds.push(siteId, from);
    if (oldTo !== null) binds.push(oldTo);
  }

  if (cutoff !== null && to >= cutoff) {
    const tuple = CUBE_TUPLE_COLUMNS.map((c, i) => `json_extract(j.value, '$[${i}]') AS ${c}`);
    const measures = CUBE_MEASURES.map(
      (m, i) => `json_extract(j.value, '$[${CUBE_TUPLE_COLUMNS.length + i}]') AS ${m}`,
    );
    parts.push(
      `SELECT c.site_id, c.day, c.name, ${tuple.join(', ')}, ${measures.join(', ')}
       FROM stats_cube2 c, json_each(c.tuples) j
       WHERE c.site_id = ? AND c.day >= ? AND c.day <= ?${nameClause.replaceAll('name', 'c.name')}`,
    );
    binds.push(siteId, from < cutoff ? cutoff : from, to);
  }

  return { sql: parts.join(' UNION ALL '), binds };
}

/**
 * Per-dimension hourly counts, from both generations of stats_hourly.
 *
 * An hour used to be one stats_hourly row per (dimension, value): around ten
 * rows written for a lone pageview on a quiet site, which across a fleet of
 * mostly idle sites was the single largest line in the write budget. Now the
 * hourly fold writes one row per site-hour — the `_total` row it always wrote
 * — and packs the per-dimension counts into its `dims` column as
 * `{dim: {value: [pageviews, visitors]}}`. Reading it walks each packed entry
 * once, which D1 bills exactly as it billed the old rows.
 *
 * Rows of the old shape are still read for site-hours that have no packed row
 * (an hour folded before the upgrade, until stats_hourly's retention prunes
 * it), so the switch needs no backfill. `where` is a predicate on `site_id`
 * and `hour`, applied in both branches: bind its parameters twice.
 */
export function hourlyDimRows(where: string): string {
  return `SELECT h.site_id, h.hour, d.key AS dim, v.key AS val,
            json_extract(v.value, '$[0]') AS pageviews, json_extract(v.value, '$[1]') AS visitors
          FROM (SELECT site_id, hour, dims FROM stats_hourly
                WHERE dim = '_total' AND dims <> '' AND ${where}) h,
               json_each(h.dims) d, json_each(d.value) v
          UNION ALL
          SELECT s.site_id, s.hour, s.dim, s.val, s.pageviews, s.visitors
          FROM stats_hourly s
          WHERE s.dim <> '_total' AND ${where.replaceAll(/\b(site_id|hour)\b/g, 's.$1')}
            AND NOT EXISTS (SELECT 1 FROM stats_hourly t
                            WHERE t.site_id = s.site_id AND t.hour = s.hour AND t.dim = '_total'
                              AND t.val = '' AND t.dims <> '')`;
}

/**
 * Columns that were added to the raw table after v2 shipped. A table created by
 * an older build is still being written to when the upgrade lands, so every
 * reader has to be able to bring it up to date. `ALTER TABLE ADD COLUMN` is DDL
 * and costs no row writes, which is what makes doing it unconditionally cheap.
 */
export const RAW_ADDED_COLUMNS: ReadonlyArray<{ name: string; sql: string }> = [
  { name: 'screen', sql: "ADD COLUMN screen TEXT NOT NULL DEFAULT ''" },
  { name: 'uid', sql: "ADD COLUMN uid TEXT NOT NULL DEFAULT ''" },
  { name: 'app_version', sql: "ADD COLUMN app_version TEXT NOT NULL DEFAULT ''" },
  { name: 'props', sql: "ADD COLUMN props TEXT NOT NULL DEFAULT ''" },
  { name: 'batch', sql: "ADD COLUMN batch TEXT NOT NULL DEFAULT ''" },
  { name: 'pv', sql: 'ADD COLUMN pv INTEGER NOT NULL DEFAULT 0' },
  { name: 'ts0', sql: 'ADD COLUMN ts0 INTEGER NOT NULL DEFAULT 0' },
  { name: 'ts1', sql: 'ADD COLUMN ts1 INTEGER NOT NULL DEFAULT 0' },
  // Last on purpose: legacyRawTables() treats a table that has it as current.
  { name: 'exit_path', sql: "ADD COLUMN exit_path TEXT NOT NULL DEFAULT ''" },
];

/**
 * Run a read over raw tables, widening any that an older build created.
 *
 * ensureSchema widens every legacy table an isolate can see when it starts,
 * but during a deploy an isolate still running the old build can create the
 * next hour's table in the old shape. Inserts recover on their own (see
 * insertRows); this is the same recovery for readers: on "no such column",
 * bring the tables up to date — DDL, no rows written — and ask once more.
 */
export async function withCurrentRawTables<T>(db: D1Database, tables: string[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!/no such column/i.test(String(error))) throw error;
    for (const table of tables) await alterRawTable(db, table);
    return run();
  }
}

/** True when the error is SQLite complaining that a column is already there. */
export function isDuplicateColumn(error: unknown): boolean {
  return /duplicate column name/i.test(String(error));
}

export async function alterRawTable(db: D1Database, table: string): Promise<void> {
  tableSuffix(table);
  // One read of the schema first: on every table this build created, and every
  // table already brought up to date, there is nothing to do.
  const current = await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .bind(table)
    .first<{ sql: string }>();
  if (!current || current.sql.includes('exit_path')) return;

  for (const column of RAW_ADDED_COLUMNS) {
    try {
      await db.prepare(`ALTER TABLE ${table} ${column.sql}`).run();
    } catch (error) {
      if (!isDuplicateColumn(error) && !/no such table/i.test(String(error))) throw error;
    }
  }
}

// Bumped once for the app-analytics + email-sign-in rework. Parallel work on
// this file must not change it again; every table below is CREATE IF NOT EXISTS.
export const SCHEMA_VERSION = 6;

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS sites (
     id INTEGER PRIMARY KEY,
     domain TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   )`,

  // An owner administers the instance and implicitly sees every site. A viewer
  // sees only what site_access grants them — that is what lets you hand a client
  // a login without exposing your other properties.
  //
  // The role column and the password columns are history: the role is derived
  // from ADMIN_EMAIL on every request (src/users.ts withRole) and nobody signs
  // in with a password any more (src/auth.ts). They stay because SQLite cannot
  // drop a NOT NULL column without rebuilding the table, and new rows write ''.
  // token_version only stamps OAuth codes and grants (src/oauth.ts); bearer
  // sessions are revoked by deleting their rows instead.
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     password_salt TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'viewer')),
     token_version INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS site_access (
     user_id INTEGER NOT NULL,
     site_id INTEGER NOT NULL,
     PRIMARY KEY (user_id, site_id)
   ) WITHOUT ROWID`,

  // Hourly rollups. Kept for HOURLY_RETENTION_DAYS so the dashboard can draw
  // an hour-resolution chart for recent ranges without touching raw events.
  `CREATE TABLE IF NOT EXISTS stats_hourly (
     site_id INTEGER NOT NULL,
     hour TEXT NOT NULL,
     dim TEXT NOT NULL,
     val TEXT NOT NULL,
     pageviews INTEGER NOT NULL,
     visitors INTEGER NOT NULL,
     PRIMARY KEY (site_id, hour, dim, val)
   ) WITHOUT ROWID`,

  // Daily rollups. These are the permanent record — never pruned.
  `CREATE TABLE IF NOT EXISTS stats_daily (
     site_id INTEGER NOT NULL,
     day TEXT NOT NULL,
     dim TEXT NOT NULL,
     val TEXT NOT NULL,
     pageviews INTEGER NOT NULL,
     visitors INTEGER NOT NULL,
     PRIMARY KEY (site_id, day, dim, val)
   ) WITHOUT ROWID`,

  // The filter cube: one row per distinct combination of dimensions per day.
  //
  // The per-dimension rollups above cannot answer "pages, but only in Germany"
  // — summing them has already thrown the combination away. This table keeps
  // the whole tuple, so any stack of filters can be answered from it.
  //
  // The cost is bounded by *variety*, not by traffic: a site that serves the
  // same 40 routes to the same 30 countries writes the same handful of rows
  // whether it gets a thousand pageviews a day or a million. Set FILTERS=off
  // to skip it entirely and give up filtering.
  `CREATE TABLE IF NOT EXISTS stats_cube (
     site_id INTEGER NOT NULL,
     day TEXT NOT NULL,
     name TEXT NOT NULL,
     path TEXT NOT NULL,
     ref TEXT NOT NULL,
     country TEXT NOT NULL,
     browser TEXT NOT NULL,
     os TEXT NOT NULL,
     device TEXT NOT NULL,
     screen TEXT NOT NULL,
     utm_source TEXT NOT NULL,
     utm_medium TEXT NOT NULL,
     utm_campaign TEXT NOT NULL,
     pageviews INTEGER NOT NULL,
     visitors INTEGER NOT NULL,
     entrances INTEGER NOT NULL DEFAULT 0,
     exits INTEGER NOT NULL DEFAULT 0,
     bounces INTEGER NOT NULL DEFAULT 0,
     duration INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (site_id, day, name, path, ref, country, browser, os, device,
                  screen, utm_source, utm_medium, utm_campaign)
   ) WITHOUT ROWID`,

  // ---- analytics-track tables: app analytics (props, active users, retention) go here ----

  // Today's visits so far, one row per site: every visitor's rows of the
  // folded hours merged into one entry per distinct row profile (see
  // VISIT_STATE_FIELDS), packed as a JSON array. The hourly fold merges each
  // hour in, so a read of today opens this one row plus the hour not folded
  // yet instead of every raw row of the day. `through` is the last hour
  // merged; `visits` NULL means the day's state could not be kept exact (an
  // hour folded twice, or folded before this table existed) and readers fall
  // back to the raw rows. Deleted by the nightly rollup with the raw tables.
  `CREATE TABLE IF NOT EXISTS today_visits (
     site_id INTEGER PRIMARY KEY,
     day TEXT NOT NULL,
     through TEXT NOT NULL,
     visits TEXT
   )`,

  // The filter cube's second generation; see cubeSource() for why it is
  // packed one row per (site, day, event name) and how readers span both.
  `CREATE TABLE IF NOT EXISTS stats_cube2 (
     site_id INTEGER NOT NULL,
     day TEXT NOT NULL,
     name TEXT NOT NULL,
     tuples TEXT NOT NULL,
     PRIMARY KEY (site_id, day, name)
   ) WITHOUT ROWID`,

  // App analytics, one row per site per day, written by the daily rollup.
  //
  //   active  JSON array of the uids active that day
  //   new     JSON array of the uids whose first day this was (app_users
  //           decides), so cohort sizes and members are one row per period
  //   props   {event: {key: {value: [events, visitors]}}}, the day's event
  //           property counts, capped per key (see rollup.ts)
  //   ret     {first_day: [active, week_new]}: of the users active that day,
  //           how many were first seen on each earlier day (the last 210
  //           days), and how many of those were not already active earlier
  //           in the same Monday-based week. Retention is read from this
  //           alone, one row per day, instead of joining member lists.
  //   hll     a HyperLogLog sketch of the active uids (src/app-analytics.ts),
  //           so distinct users over a week, a month or any range are merged
  //           from one row per day instead of walking every list
  //
  // Packed rather than a row per user or per value because rows written is
  // the free plan's binding limit: six apps with a few thousand daily users
  // would otherwise spend more on this one table than on every raw event.
  // Reads are no dearer — json_each bills each entry as a row, the same as
  // the unpacked rows would have been.
  `CREATE TABLE IF NOT EXISTS app_daily (
     site_id INTEGER NOT NULL,
     day TEXT NOT NULL,
     active TEXT NOT NULL DEFAULT '[]',
     new TEXT NOT NULL DEFAULT '[]',
     props TEXT NOT NULL DEFAULT '{}',
     ret TEXT NOT NULL DEFAULT '{}',
     hll TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (site_id, day)
   ) WITHOUT ROWID`,

  // First seen: one row per app user (uid) per site, ever.
  //
  // This is the one per-user table, and it is affordable because it is only
  // written when a uid is *new*: the daily rollup inserts every active uid
  // with ON CONFLICT DO NOTHING, which D1 bills as a primary-key probe (no
  // row read, no row written) for everyone it already knows. Deciding who is
  // new is the same probe, so the cost tracks new users, not the app's
  // lifetime user count — scanning every earlier `new` list would grow
  // forever.
  `CREATE TABLE IF NOT EXISTS app_users (
     site_id INTEGER NOT NULL,
     uid TEXT NOT NULL,
     first_day TEXT NOT NULL,
     PRIMARY KEY (site_id, uid)
   ) WITHOUT ROWID`,

  // ---- access-track tables: sign-in codes, bearer sessions, OAuth ----

  // One pending emailed sign-in code per address (see src/auth.ts). Only the
  // SHA-256 of email:code is kept. A new code replaces the old row, so the
  // table never holds more rows than there are people signing in right now,
  // and a spent code is deleted rather than flagged.
  `CREATE TABLE IF NOT EXISTS auth_codes (
     email TEXT PRIMARY KEY,
     hash TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   ) WITHOUT ROWID`,

  // Sign-in rate limits (src/auth.ts), one counter row per key such as
  // "fail-ip:<ip>:<day>". A row of its own, bumped by an atomic UPSERT, so
  // concurrent requests cannot lose each other's increments the way a
  // read-modify-write of a JSON setting would. Rows past expires_at are swept
  // whenever a counter is bumped, so the table stays a handful of rows.
  `CREATE TABLE IF NOT EXISTS auth_limits (
     key TEXT PRIMARY KEY,
     n INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   ) WITHOUT ROWID`,

  // Bearer sessions (see src/sessions.ts), keyed by the token's SHA-256.
  // WITHOUT ROWID and no secondary index: a sign-in is one row written, and
  // the per-request lookup is by primary key. Revoking a user's sessions
  // scans by user_id, which is fine for a table of a few dozen rows and
  // cheaper than an index paid on every sign-in.
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     ua TEXT NOT NULL DEFAULT ''
   ) WITHOUT ROWID`,

  // OAuth, for AI agents connecting over MCP. See src/oauth.ts.
  //
  // There is deliberately no clients table: a dynamically registered client's
  // id is its own signed registration, so the unauthenticated registration
  // endpoint costs no row writes and cannot be used to burn the write budget.
  //
  // A one-time authorization code, kept for the ten minutes between consent
  // and the token exchange. Only its SHA-256 is stored. Redemption is a
  // DELETE ... RETURNING, which is what makes a code single-use under a race.
  `CREATE TABLE IF NOT EXISTS oauth_codes (
     code_hash TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     client_name TEXT NOT NULL,
     redirect_uri TEXT NOT NULL,
     user_id INTEGER NOT NULL,
     token_version INTEGER NOT NULL,
     code_challenge TEXT NOT NULL,
     scope TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   ) WITHOUT ROWID`,

  // One row per authorization a user has approved. The current access token
  // and refresh token live on the row as hashes, so issuing, refreshing and
  // revoking are each a single row write, and both tokens carry the grant id
  // so they are looked up by primary key — no secondary index to pay for on
  // every rotation. token_version is the user's at approval time; removing
  // the user deletes the grants outright (users.ts deleteUser).
  `CREATE TABLE IF NOT EXISTS oauth_grants (
     id TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL,
     client_id TEXT NOT NULL,
     client_name TEXT NOT NULL,
     scope TEXT NOT NULL,
     token_version INTEGER NOT NULL,
     access_hash TEXT NOT NULL,
     access_expires_at INTEGER NOT NULL,
     refresh_hash TEXT NOT NULL,
     refresh_expires_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER NOT NULL
   ) WITHOUT ROWID`,

  // ---- the cursor fold (src/fold.ts, src/state.ts, src/blocks.ts) ----

  // Today, per site, folded: the day's totals and vectors (core), every
  // visitor's record (visitors), the users seen and their first day (users,
  // binary: sorted 8-byte uid hashes each followed by a 2-byte first-day
  // offset), the filter cube (cube) and event property counts (props). Raw
  // rows after (cur_ts, cur_k) are the unfolded tail. Keyed site_id * 16 +
  // shard: a state over 1.8 MB continues in shards 1..15. Created here rather
  // than by a version bump: IF NOT EXISTS is a no-op on every later start.
  `CREATE TABLE IF NOT EXISTS day_state (
     site_id INTEGER PRIMARY KEY,
     day INTEGER NOT NULL,
     cur_ts INTEGER NOT NULL,
     cur_k TEXT NOT NULL,
     fmt INTEGER NOT NULL,
     core TEXT NOT NULL DEFAULT '',
     visitors TEXT NOT NULL DEFAULT '',
     users BLOB,
     cube TEXT NOT NULL DEFAULT '',
     props TEXT NOT NULL DEFAULT ''
   )`,

  // Finished days, and dyadic runs of them (src/blocks.ts): `start` is an
  // epoch day, a multiple of 2^level, and the row covers 2^level days.
  `CREATE TABLE IF NOT EXISTS blocks (
     site_id INTEGER NOT NULL,
     level INTEGER NOT NULL,
     start INTEGER NOT NULL,
     fmt INTEGER NOT NULL,
     core TEXT NOT NULL,
     users BLOB,
     pairs TEXT NOT NULL DEFAULT '',
     cube TEXT NOT NULL DEFAULT '',
     props TEXT NOT NULL DEFAULT '{}',
     ret TEXT NOT NULL DEFAULT '{}',
     PRIMARY KEY (site_id, level, start)
   ) WITHOUT ROWID`,
];

/**
 * The first UTC day the fold owns (YYYY-MM-DD). Days before it are read from
 * the older rollups (stats_daily, stats_cube2, app_daily, stats_hourly); from
 * it on, from day_state and blocks, and the older rollups are no longer
 * written. Set once, by the first scheduled run, to the next day, so the
 * switch happens at a clean midnight.
 */
export const SETTING_BLOCKS_FROM = 'blocks_from';
/** Bumped when a site is deleted, so isolates drop their site caches. */
export const SETTING_SITES_GEN = 'sites_gen';
/** The per-install secret that authenticates POST /internal/fold. */
export const SETTING_FOLD_SECRET = 'fold_secret';
/** Set once the backfill has turned every older day into blocks. */
export const SETTING_BACKFILL_DONE = 'backfill_done';
/** The newest older day the backfill has not yet turned into a block. */
export const SETTING_BACKFILL_NEXT = 'backfill_next';

/**
 * Columns added to the rollup tables after v2.
 *
 * They only carry a value on the `_total` row, where they describe the day's
 * visits rather than its pageviews. Storing them as columns rather than as more
 * rows is what makes bounce rate and time on site free: the row is written
 * either way, so widening it costs nothing against the write budget.
 */
const ADDED_COLUMNS: ReadonlyArray<string> = [
  'ALTER TABLE stats_hourly ADD COLUMN sessions INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE stats_hourly ADD COLUMN bounces INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE stats_hourly ADD COLUMN duration INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE stats_daily ADD COLUMN sessions INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE stats_daily ADD COLUMN bounces INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE stats_daily ADD COLUMN duration INTEGER NOT NULL DEFAULT 0',
  // The hour's per-dimension counts, packed onto its `_total` row; see
  // HOURLY_DIMS below.
  "ALTER TABLE stats_hourly ADD COLUMN dims TEXT NOT NULL DEFAULT ''",
  // The hour's event property counts, on the same row; '' on hours folded
  // before it existed, which readers then take from the raw rows.
  "ALTER TABLE stats_hourly ADD COLUMN props TEXT NOT NULL DEFAULT ''",
  // Precomputed retention and distinct-user sketches; see app_daily.
  "ALTER TABLE app_daily ADD COLUMN ret TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE app_daily ADD COLUMN hll TEXT NOT NULL DEFAULT ''",
];

/**
 * Applied once per isolate. This caches a global invariant (the schema exists),
 * not request state, so it is safe to hold at module scope. Every statement is
 * IF NOT EXISTS, so concurrent isolates racing here is harmless.
 */
let schemaReady: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  schemaReady ??= applySchema(db).catch((err: unknown) => {
    // Don't cache a failure — the next request should retry.
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

async function applySchema(db: D1Database): Promise<void> {
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  await addMissingColumns(db);
  await migrateLegacyAdmin(db);
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value`,
    )
    // The WHERE makes every cold start after the first a no-op: an isolate
    // starts many times a day, and an unconditional upsert is a row written
    // each time for a value that never changes.
    .bind(String(SCHEMA_VERSION))
    .run();
}

/**
 * Widen the rollup tables, and any raw table an older build already created.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so "already there" is the expected
 * outcome on every run but the first and is swallowed rather than tested for.
 * The raw pass matters because the hour currently being written to was created
 * by the previous version, and both the rollup and the live-hour query select
 * the new column by name.
 */
async function addMissingColumns(db: D1Database): Promise<void> {
  const statements = [...ADDED_COLUMNS];
  for (const table of await legacyRawTables(db)) {
    for (const column of RAW_ADDED_COLUMNS) statements.push(`ALTER TABLE ${table} ${column.sql}`);
  }

  // One at a time, not batched: a batch is a transaction, so the first
  // "already exists" would roll back the alters that did apply.
  for (const sql of statements) {
    try {
      await db.prepare(sql).run();
    } catch (error) {
      if (!isDuplicateColumn(error) && !/no such table/i.test(String(error))) throw error;
    }
  }
}

/**
 * Carry a pre-user-model instance forward.
 *
 * Version 1 stored a single admin password in `settings`. Those installs get
 * that password moved into a real account row. Since sign-in became an
 * emailed code the row is inert — `admin` is not an address a code can be
 * sent to — and the administrator is whoever ADMIN_EMAIL names, whose own row
 * is created on their first sign-in. The migration stays so the old password
 * hash does not linger in `settings`.
 */
export async function migrateLegacyAdmin(db: D1Database): Promise<void> {
  const legacyHash = await getSetting(db, 'admin_hash');
  const legacySalt = await getSetting(db, 'admin_salt');
  if (!legacyHash || !legacySalt) return;

  await db
    .prepare(
      `INSERT INTO users (email, password_hash, password_salt, role, created_at)
       SELECT 'admin', ?, ?, 'owner', ?
       WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .bind(legacyHash, legacySalt, Math.floor(Date.now() / 1000))
    .run();

  // The credentials now live on the account; leaving copies in settings would
  // be a second place to forget to revoke.
  await db.prepare("DELETE FROM settings WHERE key IN ('admin_hash', 'admin_salt')").run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
}

/**
 * Raw-event tables that currently exist, of both kinds, oldest hour first
 * (and for one hour, the folded table before a straggler's fresh `ev_`).
 */
export async function listRawTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND (name LIKE 'ev\\_%' ESCAPE '\\' OR name LIKE 'ef\\_%' ESCAPE '\\')`,
    )
    .all<{ name: string }>();
  return results
    .map((r) => r.name)
    .filter((name) => TABLE_PATTERN.test(name))
    .sort((a, b) => a.slice(3).localeCompare(b.slice(3)) || b.localeCompare(a));
}

/**
 * Raw tables an older build created, which lack the newest column.
 *
 * Only these need ALTERing. Asking SQLite for them is one read of the schema,
 * whereas altering every table on every cold start was a few hundred
 * statements on an instance with a full day of hours on disk.
 */
async function legacyRawTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND (name LIKE 'ev\\_%' ESCAPE '\\' OR name LIKE 'ef\\_%' ESCAPE '\\')
         AND sql NOT LIKE '%exit\\_path%' ESCAPE '\\'`,
    )
    .all<{ name: string }>();
  return results.map((r) => r.name).filter((name) => TABLE_PATTERN.test(name));
}

/** Existing raw tables belonging to a given UTC day. */
export async function rawTablesForDay(db: D1Database, day: string): Promise<string[]> {
  const wanted = new Set(hourSuffixesForDay(day));
  const existing = await listRawTables(db);
  return existing.filter((name) => wanted.has(name.slice(3)));
}

export async function dropTables(db: D1Database, tables: string[]): Promise<void> {
  if (tables.length === 0) return;
  await db.batch(
    tables.map((t) => {
      tableSuffix(t);
      return db.prepare(`DROP TABLE IF EXISTS ${t}`);
    }),
  );
}
