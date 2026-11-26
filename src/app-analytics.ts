/**
 * App analytics: active users, retention, custom events and their properties.
 *
 * Everything here reads what the daily rollup leaves behind for sites that
 * send a `user_id` (see src/rollup.ts and app_daily / app_users in db.ts):
 *
 *   app_daily.active / new  uid lists per day  -> DAU and new users (lengths)
 *   app_daily.hll           a sketch per day   -> WAU, MAU, distinct per range
 *   app_daily.ret           counts per cohort  -> retention
 *   app_daily.props         property counts    -> event-properties
 *
 * plus today's raw rows, because today has not been rolled up yet and a
 * developer who just shipped the SDK is watching today's number. A uid is the
 * site-keyed hash from src/visitor.ts; no raw user id exists anywhere to read.
 *
 * Cost. D1 bills every json_each entry walked as a row read, so anything that
 * walked the per-day uid lists would cost (days x users) per question — for
 * a 2,000-DAU app, 60,000 rows for one MAU and over 100,000 for eight weeks of
 * retention. Instead every question here reads one row per day and finishes
 * the arithmetic in the Worker: list lengths for DAU and new users, sketches
 * merged for distinct users, and retention counts the rollup already grouped.
 * Today's part is one seek over this site's raw rows plus a primary-key probe
 * per user active today.
 *
 * Exactness. DAU, new users and retention are exact. Distinct users over more
 * than one day (WAU, MAU, a range's total) come from HyperLogLog sketches with
 * 4,096 registers: about 1.6% standard error, and exact in practice for the
 * small counts where an error would be noticed (below a few thousand the
 * estimate is linear counting, off by well under one user per hundred).
 *
 * The HTTP routes (src/index.ts) and the MCP tools share these loaders, so an
 * agent and the app always see the same numbers.
 */

import { isFolded, tableSuffix, withCurrentRawTables } from './db';
import { loadBreakdowns, type Filter, shiftDay, siteEvents, siteRows, todayTables, weekStart } from './query';
import { partsFor } from './time';
import { type UserSet, countUsers, unionUsers } from './blocks';
import { freshActiveIds, freshProps, freshRet, freshUsers, splitRange, today as liveToday } from './reads';
import { dayNumber, dayString } from './fold';

/* ------------------------------------------------------------ sketch ----- */

/** log2 of the register count: 4,096 registers, one byte each. */
const HLL_BITS = 12;
const HLL_SIZE = 1 << HLL_BITS;

/**
 * Add uids to a HyperLogLog register array.
 *
 * A uid is already 96 bits of SHA-256 output (see uidFor in visitor.ts), so
 * its hex digits are used directly as the hash: the first three pick the
 * register, the next thirteen (52 bits) give the run of leading zeros.
 */
export function addToSketch(registers: Uint8Array, uids: Iterable<string>): void {
  for (const uid of uids) {
    if (uid.length < 16) continue;
    const index = Number.parseInt(uid.slice(0, 3), 16);
    const high = Number.parseInt(uid.slice(3, 8), 16); // 20 bits
    const low = Number.parseInt(uid.slice(8, 16), 16); // 32 bits
    if (!Number.isFinite(index) || !Number.isFinite(high) || !Number.isFinite(low)) continue;
    const rank = high !== 0 ? Math.clz32(high) - 11 : low !== 0 ? 21 + Math.clz32(low) : 53;
    if (rank > registers[index]!) registers[index] = rank;
  }
}

export function newSketch(): Uint8Array {
  return new Uint8Array(HLL_SIZE);
}

/** Stored form: the registers, base64. */
export function encodeSketch(registers: Uint8Array): string {
  let binary = '';
  for (const byte of registers) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Merge a stored sketch into `into` (register-wise max). Bad input is ignored. */
export function mergeSketch(into: Uint8Array, stored: string): void {
  if (stored === '') return;
  let binary: string;
  try {
    binary = atob(stored);
  } catch {
    return;
  }
  if (binary.length !== HLL_SIZE) return;
  for (let i = 0; i < HLL_SIZE; i += 1) {
    const value = binary.charCodeAt(i);
    if (value > into[i]!) into[i] = value;
  }
}

/** The HyperLogLog estimate, with the small-range (linear counting) correction. */
export function estimateSketch(registers: Uint8Array): number {
  let sum = 0;
  let zeros = 0;
  for (const value of registers) {
    sum += 2 ** -value;
    if (value === 0) zeros += 1;
  }
  const alpha = 0.7213 / (1 + 1.079 / HLL_SIZE);
  const raw = (alpha * HLL_SIZE * HLL_SIZE) / sum;
  if (raw <= 2.5 * HLL_SIZE && zeros > 0) return Math.round(HLL_SIZE * Math.log(HLL_SIZE / zeros));
  return Math.round(raw);
}

/* ------------------------------------------------------------- today ----- */

interface TodayUsers {
  /** Every uid active today. */
  active: string[];
  /** Each active uid's recorded first day; absent for a uid first seen today. */
  first: Map<string, string>;
}

const NOBODY: TodayUsers = { active: [], first: new Map() };

/**
 * Today's app users for a site, from the raw tables, with each one's first
 * day as app_users records it (one primary-key probe per user).
 *
 * "New" uses the same rule as the daily rollup — no first day on record
 * before today — so today's new count agrees with what the rollup will store
 * tonight.
 */
async function todayUsers(db: D1Database, siteId: number, now: Date): Promise<TodayUsers> {
  const tables = await todayTables(db, now);
  if (tables.length === 0) return NOBODY;

  const source = siteRows(tables, siteId, 'rows');
  try {
    const { results } = await withCurrentRawTables(db, tables, () =>
      db
        .prepare(
          `SELECT t.uid AS uid,
                  (SELECT first_day FROM app_users u WHERE u.site_id = ? AND u.uid = t.uid AND u.first_day < ?) AS first
           FROM (SELECT DISTINCT uid FROM (${source.sql}) WHERE uid <> '') t`,
        )
        .bind(siteId, partsFor(now).day, ...source.binds)
        .all<{ uid: string; first: string | null }>(),
    );
    const first = new Map<string, string>();
    for (const row of results) if (row.first) first.set(row.uid, row.first);
    return { active: results.map((r) => r.uid), first };
  } catch (error) {
    if (/no such table/i.test(String(error))) return NOBODY;
    throw error;
  }
}

/** Whether a site has ever reported a user_id: one primary-key probe. */
async function everTracked(db: D1Database, siteId: number): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS hit FROM app_users WHERE site_id = ? LIMIT 1').bind(siteId).first();
  return row !== null;
}

function daysFrom(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) days.push(day);
  return days;
}

/* ------------------------------------------------------- active users ---- */

export interface ActiveUsers {
  tracked: boolean;
  labels: string[];
  dau: number[];
  new: number[];
  totals: { active: number; new: number };
  wau: number;
  mau: number;
}

interface DayRow {
  day: string;
  dau: number;
  fresh: number;
  hll: string;
  /** The day's uid list, only when it has no sketch (rolled up by an older build). */
  active: string;
}

/**
 * Daily active and new users over a range, distinct users over the range, and
 * WAU/MAU for the 7 and 30 days ending on the range's last day.
 *
 * The series is always daily: a user is a daily notion here (the visitor hash
 * resets every day, and "active" is "sent anything that day"), and 365 points
 * are still one row each.
 */
export async function loadActiveUsers(
  db: D1Database,
  siteId: number,
  range: { from: string; to: string },
  now: Date,
): Promise<ActiveUsers> {
  const today = partsFor(now).day;
  const labels = daysFrom(range.from, range.to);
  const monthFrom = shiftDay(range.to, -29);
  const weekFrom = shiftDay(range.to, -6);
  const readFrom = range.from < monthFrom ? range.from : monthFrom;
  const split = await splitRange(db, readFrom, range.to);

  // Each window's distinct users: an exact union of uid sets where the fold's
  // blocks answer, a sketch as soon as any older day (app_daily) is in it.
  const windows = [range, { from: weekFrom, to: range.to }, { from: monthFrom, to: range.to }].map((w) => ({
    ...w,
    sketch: newSketch(),
    older: false,
    sets: [] as UserSet[],
  }));
  const dau = new Map<string, number>();
  const fresh = new Map<string, number>();
  let tracked = false;

  if (split.legacy) {
    const historyTo = split.legacy.to < today ? split.legacy.to : shiftDay(today, -1);
    const rows: DayRow[] = [];
    if (split.legacy.from <= historyTo) {
      const { results } = await db
        .prepare(
          `SELECT day, json_array_length(active) AS dau, json_array_length(new) AS fresh, hll,
                  CASE WHEN hll = '' THEN active ELSE '' END AS active
           FROM app_daily WHERE site_id = ? AND day BETWEEN ? AND ?`,
        )
        .bind(siteId, split.legacy.from, historyTo)
        .all<DayRow>();
      rows.push(...results);
    }
    for (const row of rows) {
      if (row.dau > 0) tracked = true;
      dau.set(row.day, row.dau);
      fresh.set(row.day, row.fresh);
      const uids = row.hll === '' ? (JSON.parse(row.active || '[]') as string[]) : [];
      for (const w of windows) {
        if (row.day < w.from || row.day > w.to) continue;
        w.older = true;
        if (row.hll === '') addToSketch(w.sketch, uids);
        else mergeSketch(w.sketch, row.hll);
      }
    }
    if (split.legacy.to >= today) {
      const live = await todayUsers(db, siteId, now);
      if (live.active.length > 0) tracked = true;
      dau.set(today, live.active.length);
      fresh.set(today, live.active.length - live.first.size);
      for (const w of windows) {
        if (today < w.from || today > w.to) continue;
        w.older = true;
        addToSketch(w.sketch, live.active);
      }
    }
  }

  if (split.fresh) {
    for (const [i, w] of windows.entries()) {
      const from = w.from > split.fresh.from ? w.from : split.fresh.from;
      if (from > w.to) continue;
      const part = await freshUsers(db, siteId, from, w.to, now);
      if (part.any) tracked = true;
      w.sets.push(part.users);
      if (i === 0 || i === 2) {
        for (const [day, n] of part.dau) dau.set(day, n);
        for (const [day, n] of part.fresh) fresh.set(day, n);
      }
    }
  }

  const distinct = (w: (typeof windows)[number]): number => {
    if (!w.older) return countUsers(unionUsers(w.sets));
    for (const set of w.sets) {
      if (set.kind === 'set') addToSketch(w.sketch, set.ids);
      else for (let i = 0; i < w.sketch.length; i += 1) if (set.registers[i]! > w.sketch[i]!) w.sketch[i] = set.registers[i]!;
    }
    return estimateSketch(w.sketch);
  };

  const dauSeries = labels.map((day) => dau.get(day) ?? 0);
  const newSeries = labels.map((day) => fresh.get(day) ?? 0);
  // One day with users is a list length, so keep it exact.
  const singleDay = labels.length === 1 ? dauSeries[0] : undefined;

  return {
    tracked: tracked || (await everTracked(db, siteId)),
    labels,
    dau: dauSeries,
    new: newSeries,
    totals: { active: singleDay ?? distinct(windows[0]!), new: newSeries.reduce((a, b) => a + b, 0) },
    wau: distinct(windows[1]!),
    mau: distinct(windows[2]!),
  };
}

/* ---------------------------------------------------------- retention ---- */

export type Cohort = 'day' | 'week';

export interface Retention {
  tracked: boolean;
  cohorts: { label: string; size: number; retained: number[] }[];
}

export const MAX_RETENTION_PERIODS = 30;

/** How far back app_daily.ret records first days: 30 weeks. */
export const RETENTION_HORIZON_DAYS = 7 * MAX_RETENTION_PERIODS;

/**
 * Cohort retention: users grouped by the day or week they were first seen,
 * and how many of each group were active 0, 1, 2… periods later.
 *
 * Covers the last `periods` periods up to and including the current one, so
 * the newest cohort has one number and the oldest has `periods`. Finished
 * days are read from app_daily.ret, which the rollup filled with "active
 * today, first seen on day X" counts — one row per day, no member lists. A
 * weekly cell sums each day's count of users *new to that week*, which is what
 * makes it a count of distinct users rather than of user-days.
 *
 * Today comes from the raw rows: each of today's users' first day is probed
 * in app_users, and for weekly cohorts the earlier days of this week are read
 * (at most six rows) to tell who is already counted this week.
 */
export async function loadRetention(
  db: D1Database,
  siteId: number,
  cohort: Cohort,
  periods: number,
  now: Date,
): Promise<Retention> {
  const n = Math.min(Math.max(Math.trunc(periods) || 8, 1), MAX_RETENTION_PERIODS);
  const today = partsFor(now).day;
  const step = cohort === 'week' ? 7 : 1;
  const current = cohort === 'week' ? weekStart(today) : today;
  const labels = Array.from({ length: n }, (_, i) => shiftDay(current, -step * (n - 1 - i)));
  const first = labels[0]!;
  const yesterday = shiftDay(today, -1);
  const periodOf = (day: string): string => (cohort === 'week' ? weekStart(day) : day);
  const index = new Map(labels.map((label, i) => [label, i]));

  const cohorts = labels.map((label, i) => ({ label, size: 0, retained: new Array<number>(n - i).fill(0) }));
  const count = (firstDay: string, activeDay: string, value: number): void => {
    const c = index.get(periodOf(firstDay));
    const p = index.get(periodOf(activeDay));
    if (c === undefined || p === undefined || p < c || value === 0) return;
    cohorts[c]!.retained[p - c]! += value;
  };

  let tracked = false;
  const split = await splitRange(db, first, today);
  const apply = (day: string, ret: Record<string, [number, number]>): void => {
    tracked = true;
    for (const [firstDay, [active, weekNew]] of Object.entries(ret)) {
      if (firstDay >= first) count(firstDay, day, cohort === 'week' ? weekNew : active);
    }
  };
  const legacyTo = split.legacy && split.legacy.to < yesterday ? split.legacy.to : yesterday;
  if (split.legacy && first <= legacyTo) {
    const { results } = await db
      .prepare('SELECT day, ret FROM app_daily WHERE site_id = ? AND day BETWEEN ? AND ?')
      .bind(siteId, first, legacyTo)
      .all<{ day: string; ret: string }>();
    for (const row of results) {
      try {
        apply(row.day, JSON.parse(row.ret) as Record<string, [number, number]>);
      } catch {
        continue;
      }
    }
  }

  if (split.fresh) {
    // Fold days: each level-0 block keeps the same {first_day: [active,
    // week_new]} counts app_daily.ret did; today comes from its state, whose
    // users already carry their first day.
    if (split.fresh.from <= yesterday) {
      for (const row of await freshRet(db, siteId, split.fresh.from, yesterday)) apply(row.day, row.ret);
    }
    const state = await liveToday(db, siteId, now);
    if (state.users.size > 0) {
      tracked = true;
      const monday = weekStart(today);
      const seen =
        cohort === 'week' && monday < today
          ? await freshActiveIds(db, siteId, monday > split.fresh.from ? monday : split.fresh.from, yesterday)
          : new Set<string>();
      for (const [uid, firstDay] of state.users) {
        if (seen.has(uid)) continue;
        count(firstDay < 0 ? today : dayString(firstDay), today, 1);
      }
    }
    for (const entry of cohorts) entry.size = entry.retained[0] ?? 0;
    return { tracked: tracked || (await everTracked(db, siteId)), cohorts };
  }

  const live = await todayUsers(db, siteId, now);
  if (live.active.length > 0) {
    tracked = true;
    let seenThisWeek = new Set<string>();
    const monday = weekStart(today);
    if (cohort === 'week' && monday < today) {
      const { results } = await db
        .prepare('SELECT active FROM app_daily WHERE site_id = ? AND day BETWEEN ? AND ?')
        .bind(siteId, monday, yesterday)
        .all<{ active: string }>();
      seenThisWeek = new Set(results.flatMap((r) => JSON.parse(r.active) as string[]));
    }
    for (const uid of live.active) {
      if (seenThisWeek.has(uid)) continue;
      count(live.first.get(uid) ?? today, today, 1);
    }
  }

  for (const entry of cohorts) entry.size = entry.retained[0] ?? 0;
  return { tracked: tracked || (await everTracked(db, siteId)), cohorts };
}

/* ------------------------------------------------------------- events ---- */

export interface EventRow {
  name: string;
  count: number;
  /**
   * Unfiltered: distinct users per day, summed over the range (a user active
   * on two days counts twice) — exact for every day, finished days from the
   * daily rollup's recount and today from raw rows. Filtered: finished days
   * come from the cube, where users are distinct per dimension tuple and then
   * summed, so the number is an upper bound (one user on three screens counts
   * three times). docs/api.md says the same.
   */
  users: number;
}

/**
 * Custom events over a range: everything except page and screen views.
 *
 * Read through the same breakdown path as the dashboard's `event` panel, so a
 * filter stack narrows it the same way (from the cube for finished days, raw
 * rows for today).
 */
export async function loadEvents(
  db: D1Database,
  siteId: number,
  range: { from: string; to: string },
  filters: Filter[],
  now: Date,
): Promise<{ events: EventRow[] }> {
  const rows = (await loadBreakdowns(db, siteId, range, filters, ['event'], 100, now)).event ?? [];
  return { events: rows.map((r) => ({ name: r.name, count: r.value, users: r.visits })) };
}

/* --------------------------------------------------- event properties ---- */

export const MAX_PROPERTY_VALUES = 50;

export type EventProperties = { keys: { key: string; count: number }[] } | { values: { name: string; value: number }[] };

/**
 * An event's property keys (how many events carried each), or one key's
 * values (how many events carried each value).
 *
 * Finished days come from app_daily.props, where each key keeps its top
 * values and folds the rest into "(other)"; today comes from the raw events.
 * Only the asked-for event's entry is opened on each day.
 */
export async function loadEventProperties(
  db: D1Database,
  siteId: number,
  range: { from: string; to: string },
  event: string,
  key: string | undefined,
  limit: number,
  now: Date,
): Promise<EventProperties> {
  const counts = new Map<string, number>();
  const bump = (name: string, value: number): void => {
    counts.set(name, (counts.get(name) ?? 0) + value);
  };
  const split = await splitRange(db, range.from, range.to);
  if (split.fresh) {
    // Fold days: each block keeps event -> key -> value -> count (top 50
    // values per key, the rest as "(other)"), today's state the same.
    const props = (await freshProps(db, siteId, split.fresh.from, split.fresh.to, now))[event] ?? {};
    if (key === undefined) {
      for (const [k, values] of Object.entries(props)) bump(k, Object.values(values).reduce((a, b) => a + b, 0));
    } else {
      for (const [v, n] of Object.entries(props[key] ?? {})) bump(v, n);
    }
  }
  if (split.legacy) await legacyEventProperties(db, siteId, split.legacy, event, key, now, bump);

  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (key === undefined) return { keys: sorted.map(([k, count]) => ({ key: k, count })) };
  const cap = Math.min(Math.max(Math.trunc(limit) || 10, 1), MAX_PROPERTY_VALUES);
  return { values: sorted.slice(0, cap).map(([name, value]) => ({ name, value })) };
}

async function legacyEventProperties(
  db: D1Database,
  siteId: number,
  range: { from: string; to: string },
  event: string,
  key: string | undefined,
  now: Date,
  bump: (name: string, value: number) => void,
): Promise<void> {
  const today = partsFor(now).day;
  const historyTo = range.to < today ? range.to : shiftDay(today, -1);

  if (range.from <= historyTo) {
    const { results } = await db
      .prepare(
        `SELECT ${key === undefined ? 'k.key' : 'v.key'} AS name, SUM(json_extract(v.value, '$[0]')) AS n
         FROM app_daily d, json_each(d.props) e, json_each(e.value) k, json_each(k.value) v
         WHERE d.site_id = ? AND d.day BETWEEN ? AND ? AND e.key = ?${key === undefined ? '' : ' AND k.key = ?'}
         GROUP BY name`,
      )
      .bind(siteId, range.from, historyTo, event, ...(key === undefined ? [] : [key]))
      .all<{ name: string; n: number }>();
    for (const row of results) bump(String(row.name), row.n);
  }

  if (range.to >= today && range.from <= today) {
    let tables = await todayTables(db, now);
    const hourOf = (t: string): string => {
      const s = tableSuffix(t);
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}`;
    };
    const folded = tables.filter(isFolded).map(hourOf);
    if (folded.length > 0) {
      // Folded hours from their packed counts: only this event's subtree of
      // each hour's row is walked. An hour folded before the counts existed
      // ('' rather than '{}') comes back as `legacy` and is read raw below.
      const { results } = await db
        .prepare(
          `SELECT h.hour AS hour, h.props = '' AS legacy, ${key === undefined ? 'k.key' : 'v.key'} AS label,
                  SUM(json_extract(v.value, '$[0]')) AS n
           FROM stats_hourly h
           LEFT JOIN json_each(json_extract(CASE WHEN h.props = '' THEN '{}' ELSE h.props END, '$.' || json_quote(?))) k
             ${key === undefined ? '' : 'ON k.key = ?'}
           LEFT JOIN json_each(k.value) v
           WHERE h.site_id = ? AND h.hour IN (${folded.map(() => '?').join(', ')}) AND h.dim = '_total' AND h.val = ''
           GROUP BY h.hour, label`,
        )
        .bind(event, ...(key === undefined ? [] : [key]), siteId, ...folded)
        .all<{ hour: string; legacy: number; label: string | null; n: number | null }>();
      const legacy = new Set<string>();
      for (const row of results) {
        if (row.legacy) legacy.add(row.hour);
        else if (row.label !== null) bump(String(row.label), Number(row.n ?? 0));
      }
      tables = tables.filter((t) => !isFolded(t) || legacy.has(hourOf(t)));
    }
    if (tables.length > 0) {
      const source = siteEvents(tables, siteId);
      try {
        const { results } = await withCurrentRawTables(db, tables, () =>
          db
            .prepare(
              // Aliased `label`, not `name`: the events already have a
              // `name` column, and GROUP BY would bind to that instead.
              `SELECT ${key === undefined ? 'k.key' : 'k.value'} AS label, COUNT(*) AS n
               FROM (${source.sql}) e, json_each(CASE WHEN e.props = '' THEN '{}' ELSE e.props END) k
               WHERE e.name = ? AND e.props <> ''${key === undefined ? '' : ' AND k.key = ?'}
               GROUP BY label`,
            )
            .bind(...source.binds, event, ...(key === undefined ? [] : [key]))
            .all<{ label: string; n: number }>(),
        );
        for (const row of results) bump(String(row.label), row.n);
      } catch (error) {
        if (!/no such table/i.test(String(error))) throw error;
      }
    }
  }
}
