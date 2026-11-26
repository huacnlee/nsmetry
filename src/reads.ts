/**
 * Readers for the days the fold owns (SETTING_BLOCKS_FROM on): today from its
 * day_state plus the unfolded tail, finished days from dyadic blocks. The
 * loaders in query.ts and app-analytics.ts split every range at the cutover
 * and call these for the part on or after it, so the HTTP routes and the MCP
 * tools keep sharing one set of answers.
 *
 * What is exact and what is not (docs/api.md says the same):
 *   - totals, series, visits, bounces, time, DAU and new users: exact;
 *   - rankings: exact unless a block had to cut a list (500 values per
 *     dimension, 100 events), which is reported as `approx: true`;
 *   - event users and dimension visitors: distinct per day, summed over days;
 *   - filtered visitors and event users: distinct per tuple, summed (an upper
 *     bound, as the older cube was);
 *   - distinct users over a range (WAU, MAU, totals.active): exact from the
 *     blocks' uid sets, a HyperLogLog estimate only where a block holds over
 *     100k users.
 */
import {
  type Block,
  type BlockCore,
  type Pair,
  aggregateCube,
  columnOfDim,
  countUsers,
  dimOfColumn,
  loadCover,
  loadCubes,
  loadPairs,
  mergeProps,
  unionUsers,
  type UserSet,
} from './blocks';
import { type DayState, cubeRows, cutComponents, dayNumber, dayString, epochDay, filteredHours } from './fold';
import { blocksFrom, liveDay, readState } from './state';

export interface DayComponents {
  views: number;
  visits: number;
  bounces: number;
  duration: number;
}

export interface FilterSpec {
  dim: string;
  value: string;
}

const EMPTY = (): DayComponents => ({ views: 0, visits: 0, bounces: 0, duration: 0 });

/* --------------------------------------------------------------- eras ----- */

/** The range split at the cutover: legacy days before it, fold days from it. */
export async function splitRange(
  db: D1Database,
  from: string,
  to: string,
): Promise<{ legacy: { from: string; to: string } | null; fresh: { from: string; to: string } | null }> {
  const cut = await blocksFrom(db);
  if (cut === null || to < cut) return { legacy: { from, to }, fresh: null };
  if (from >= cut) return { legacy: null, fresh: { from, to } };
  return { legacy: { from, to: dayString(dayNumber(cut) - 1) }, fresh: { from: cut, to } };
}

/* -------------------------------------------------------------- today ----- */

const memo = new Map<string, { at: number; state: Promise<DayState> }>();

/** Today as the fold sees it now (memoized for two seconds, never mutated by readers). */
export function today(db: D1Database, siteId: number, now: Date): Promise<DayState> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const key = `${siteId}:${nowSeconds}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit.state;
  const state = liveDay(db, siteId, epochDay(nowSeconds), nowSeconds);
  memo.set(key, { at: Date.now(), state });
  state.catch(() => memo.delete(key));
  while (memo.size > 16) memo.delete(memo.keys().next().value as string);
  return state;
}

export function clearTodayMemo(): void {
  memo.clear();
}

/**
 * Finished days [from, to] as blocks. In the first hour of a day, yesterday
 * may not have its block yet: then it is read from its state and tail.
 */
async function finished(
  db: D1Database,
  siteId: number,
  from: number,
  to: number,
  columns: Parameters<typeof loadCover>[4],
  now: Date,
): Promise<{ blocks: Block[]; states: DayState[] }> {
  const blocks = await loadCover(db, siteId, from, to, columns);
  const covered = (day: number) => blocks.some((b) => b.start <= day && day < b.start + (1 << b.level));
  const late = await unfinishedYesterday(db, siteId, from, to, covered, now);
  return { blocks, states: late ? [late] : [] };
}

/**
 * Yesterday, in the first hour of today, when its block is not written yet:
 * its state plus the tail to midnight. Null otherwise.
 */
async function unfinishedYesterday(
  db: D1Database,
  siteId: number,
  from: number,
  to: number,
  covered: (day: number) => boolean,
  now: Date,
): Promise<DayState | null> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const yesterday = epochDay(nowSeconds) - 1;
  if (yesterday < from || yesterday > to || nowSeconds % 86_400 >= 3600 || covered(yesterday)) return null;
  const stored = await readState(db, siteId);
  if (!stored || stored.day !== yesterday) return null;
  return liveDay(db, siteId, yesterday, nowSeconds);
}

/** A state as a level-0 block's core (for readers that treat both alike). */
function stateCore(s: DayState): BlockCore {
  let fresh = 0;
  for (const first of s.users.values()) if (first < 0 || first === s.day) fresh += 1;
  const d: BlockCore['d'] = {};
  for (const [column, table] of Object.entries(s.core.d)) {
    d[column] = Object.entries(table).map(([name, x]) => [name, x[0], x[1]] as [string, number, number]);
  }
  const e: BlockCore['e'] = {};
  for (const [name, x] of Object.entries(s.core.e)) e[name] = [[x[0]], [x[3]]];
  return {
    n: 1,
    v: {
      views: [s.core.t[0]],
      visits: [s.core.t[1]],
      bounces: [s.core.t[2]],
      duration: [s.core.t[3]],
      events: [s.core.t[4]],
      dau: [s.users.size],
      new: [fresh],
    },
    h: s.core.h,
    m: s.core.m,
    d,
    o: {},
    e,
    cap: 0,
  };
}

/** Every day in [from, to] as (start, core) pieces: blocks, states, and today. */
async function cores(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  now: Date,
  columns: Parameters<typeof loadCover>[4] = ['core'],
): Promise<{ start: number; core: BlockCore; block?: Block; state?: DayState }[]> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const t = epochDay(nowSeconds);
  const a = dayNumber(from);
  const b = dayNumber(to);
  const out: { start: number; core: BlockCore; block?: Block; state?: DayState }[] = [];
  const { blocks, states } = await finished(db, siteId, a, Math.min(b, t - 1), columns, now);
  for (const block of blocks) if (block.core) out.push({ start: block.start, core: block.core, block });
  for (const s of states) out.push({ start: s.day, core: stateCore(s), state: s });
  if (a <= t && t <= b) {
    const s = await today(db, siteId, now);
    out.push({ start: t, core: stateCore(s), state: s });
  }
  return out;
}

/* ---------------------------------------------------------- components ---- */

/** Per-day components for fold days [from, to]. */
export async function freshComponents(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  filters: FilterSpec[],
  now: Date,
): Promise<Map<string, DayComponents>> {
  const out = new Map<string, DayComponents>();
  if (filters.length === 0) {
    for (const piece of await cores(db, siteId, from, to, now)) {
      const v = piece.core.v;
      for (let i = 0; i < piece.core.n; i += 1) {
        const day = dayString(piece.start + i);
        if (day < from || day > to) continue;
        if (!v.views[i] && !v.visits[i]) continue;
        out.set(day, { views: v.views[i] ?? 0, visits: v.visits[i] ?? 0, bounces: v.bounces[i] ?? 0, duration: v.duration[i] ?? 0 });
      }
    }
    return out;
  }
  for (const [day, pair] of await filteredPairs(db, siteId, from, to, filters, now)) {
    out.set(day, { views: pair._[0], visits: pair._[1], bounces: pair._[2], duration: pair._[3] });
  }
  return out;
}

/**
 * One day's components cut at a ten-minute bucket (0–143, inclusive): the
 * comparison day of a range that ends today, at the same time of day.
 */
export async function cutDay(db: D1Database, siteId: number, day: string, bucket: number, now: Date): Promise<DayComponents | null> {
  const [piece] = await cores(db, siteId, day, day, now);
  if (!piece?.core.m) return null;
  return cutComponents(piece.core.m, bucket);
}

/** A day's hours (labels YYYY-MM-DDTHH); with `throughBucket`, the last hour is cut there. */
export async function freshHours(
  db: D1Database,
  siteId: number,
  day: string,
  now: Date,
  throughBucket?: number,
): Promise<{ label: string; views: number; visits: number; bounces: number; duration: number }[]> {
  const [piece] = await cores(db, siteId, day, day, now);
  if (!piece) return [];
  const out: { label: string; views: number; visits: number; bounces: number; duration: number }[] = [];
  const m = piece.core.m;
  const h = piece.core.h;
  if (!h) return out;
  for (let hour = 0; hour < 24; hour += 1) {
    const label = `${day}T${String(hour).padStart(2, '0')}`;
    if (throughBucket !== undefined && m) {
      const first = hour * 6;
      if (first > throughBucket) break;
      const last = Math.min(first + 5, throughBucket);
      const sum = (a: number[]) => a.slice(first, last + 1).reduce((x, y) => x + y, 0);
      out.push({ label, views: sum(m.v), visits: sum(m.s), bounces: sum(m.b), duration: sum(m.d) });
    } else {
      out.push({ label, views: h.v[hour] ?? 0, visits: h.s[hour] ?? 0, bounces: h.b[hour] ?? 0, duration: h.d[hour] ?? 0 });
    }
  }
  return out;
}

/* ----------------------------------------------------------- filtered ----- */

/** Today's hours under a filter stack, from its state and tail alone. */
export async function freshFilteredHours(
  db: D1Database,
  siteId: number,
  filters: FilterSpec[],
  now: Date,
): Promise<{ label: string; views: number; visits: number; bounces: number; duration: number }[]> {
  const s = await today(db, siteId, now);
  const day = dayString(s.day);
  const hours = filteredHours(s, filters.map((f) => ({ column: columnOfDim(f.dim), value: f.value })));
  const through = Math.floor((Math.floor(now.getTime() / 1000) % 86_400) / 3600);
  return hours.slice(0, through + 1).map(([views, visits, bounces, duration], h) => ({
    label: `${day}T${String(h).padStart(2, '0')}`,
    views: views!,
    visits: visits!,
    bounces: bounces!,
    duration: duration!,
  }));
}

const toColumns = (filters: FilterSpec[]) => filters.map((f) => ({ column: columnOfDim(f.dim), value: f.value }));

/** Per-day answers under a filter stack (fold days only; ranges are ≤ 31 days). */
export async function filteredPairs(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  filters: FilterSpec[],
  now: Date,
): Promise<Map<string, Pair>> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const t = epochDay(nowSeconds);
  const a = dayNumber(from);
  const b = Math.min(dayNumber(to), t - 1);
  const out = new Map<string, Pair>();
  const columns = toColumns(filters);
  let cubeDays: number[] = [];
  if (a <= b) {
    if (filters.length === 1) {
      for (const row of await loadPairs(db, siteId, a, b, filters[0]!.dim, filters[0]!.value)) {
        if (row.fallback) cubeDays.push(row.start);
        else if (row.pair) out.set(dayString(row.start), row.pair);
      }
    } else {
      cubeDays = Array.from({ length: b - a + 1 }, (_, i) => a + i);
    }
    if (cubeDays.length > 0) {
      for (const [start, cube] of await loadCubes(db, siteId, cubeDays)) {
        out.set(dayString(start), aggregateCube(cubeRows(cube, columns)));
      }
    }
    const late = await unfinishedYesterday(db, siteId, a, b, (day) => out.has(dayString(day)) || cubeDays.includes(day), now);
    if (late) out.set(dayString(late.day), aggregateCube(cubeRows(late.cube, columns)));
  }
  if (dayNumber(from) <= t && t <= dayNumber(to)) {
    const s = await today(db, siteId, now);
    out.set(dayString(t), aggregateCube(cubeRows(s.cube, columns)));
  }
  return out;
}

/* ---------------------------------------------------------- breakdowns ---- */

export interface FreshRanking {
  /** dim -> name -> [value, visits] */
  rows: Map<string, Map<string, [number, number]>>;
  approx: boolean;
}

function bump(rows: FreshRanking['rows'], dim: string, name: string, a: number, b: number): void {
  if (a === 0 && b === 0) return;
  let table = rows.get(dim);
  if (!table) {
    table = new Map();
    rows.set(dim, table);
  }
  const x = table.get(name);
  if (x) {
    x[0] += a;
    x[1] += b;
  } else table.set(name, [a, b]);
}

/** Rankings for fold days [from, to]: the referrer's '' row is "no referrer". */
export async function freshRankings(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  filters: FilterSpec[],
  dims: string[],
  now: Date,
): Promise<FreshRanking> {
  const rows: FreshRanking['rows'] = new Map();
  let approx = false;
  if (filters.length > 0) {
    for (const pair of (await filteredPairs(db, siteId, from, to, filters, now)).values()) {
      for (const dim of dims) for (const [name, [a, b]] of Object.entries(pair.B[dim] ?? {})) bump(rows, dim, name, a, b);
    }
    return { rows, approx };
  }
  const lo = dayNumber(from);
  const hi = dayNumber(to);
  for (const piece of await cores(db, siteId, from, to, now)) {
    const core = piece.core;
    if (core.cap) approx = true;
    for (const dim of dims) {
      if (dim === 'event') {
        for (const [name, [count, users]] of Object.entries(core.e)) {
          let c = 0;
          let u = 0;
          for (let i = 0; i < core.n; i += 1) {
            if (piece.start + i < lo || piece.start + i > hi) continue;
            c += count[i] ?? 0;
            u += users[i] ?? 0;
          }
          bump(rows, dim, name, c, u);
        }
        continue;
      }
      for (const [name, a, b] of core.d[columnOfDim(dim)] ?? []) bump(rows, dim, name, a, b);
    }
  }
  return { rows, approx };
}

/* -------------------------------------------------------------- events ---- */

/** One event per day (or per hour of one day) on fold days. */
export async function freshEventSeries(
  db: D1Database,
  siteId: number,
  from: string,
  to: string,
  event: string,
  filters: FilterSpec[],
  byHour: boolean,
  now: Date,
): Promise<Map<string, [number, number]>> {
  const out = new Map<string, [number, number]>();
  const add = (label: string, c: number, u: number): void => {
    if (!c && !u) return;
    const x = out.get(label) ?? [0, 0];
    x[0] += c;
    x[1] += u;
    out.set(label, x);
  };
  if (filters.length > 0) {
    if (byHour) return out;
    for (const [day, pair] of await filteredPairs(db, siteId, from, to, filters, now)) {
      const x = pair.B.event?.[event];
      if (x) add(day, x[0], x[1]);
    }
    return out;
  }
  for (const piece of await cores(db, siteId, from, to, now)) {
    if (byHour) {
      const live = piece.state?.core.e[event];
      const stored = (piece.core as BlockCore & { eh?: Record<string, [number[], number[]]> }).eh?.[event];
      const day = dayString(piece.start);
      const hours = live ? [live[1], live[2]] : stored;
      if (hours) for (let h = 0; h < 24; h += 1) add(`${day}T${String(h).padStart(2, '0')}`, hours[0]![h] ?? 0, hours[1]![h] ?? 0);
      continue;
    }
    const x = piece.core.e[event];
    if (!x) continue;
    for (let i = 0; i < piece.core.n; i += 1) {
      const day = dayString(piece.start + i);
      if (day >= from && day <= to) add(day, x[0][i] ?? 0, x[1][i] ?? 0);
    }
  }
  return out;
}

/** Event property counts on fold days. */
export async function freshProps(db: D1Database, siteId: number, from: string, to: string, now: Date): Promise<DayState['props']> {
  const out: DayState['props'] = {};
  for (const piece of await cores(db, siteId, from, to, now, ['core', 'props'])) {
    mergeProps(out, piece.state ? piece.state.props : piece.block?.props);
  }
  return out;
}

/* --------------------------------------------------------------- users ---- */

export interface FreshUsers {
  dau: Map<string, number>;
  fresh: Map<string, number>;
  /** The uid sets of the range, unioned (exact unless a block was a sketch). */
  users: UserSet;
  any: boolean;
}

/** DAU and new users per day, and the union of users, for fold days [from, to]. */
export async function freshUsers(db: D1Database, siteId: number, from: string, to: string, now: Date): Promise<FreshUsers> {
  const dau = new Map<string, number>();
  const fresh = new Map<string, number>();
  const sets: UserSet[] = [];
  let any = false;
  for (const piece of await cores(db, siteId, from, to, now, ['core', 'users'])) {
    for (let i = 0; i < piece.core.n; i += 1) {
      const day = dayString(piece.start + i);
      if (day < from || day > to) continue;
      const n = piece.core.v.dau[i] ?? 0;
      if (n > 0) any = true;
      dau.set(day, n);
      fresh.set(day, piece.core.v.new[i] ?? 0);
    }
    if (piece.state) sets.push({ kind: 'set', ids: [...piece.state.users.keys()] });
    else if (piece.block?.users) sets.push(piece.block.users);
  }
  return { dau, fresh, users: unionUsers(sets), any };
}

export { countUsers };

/** Level-0 retention rows of fold days [from, to] ({first_day: [active, week_new]} each). */
export async function freshRet(db: D1Database, siteId: number, from: string, to: string): Promise<{ day: string; ret: Record<string, [number, number]> }[]> {
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (a > b) return [];
  const out: { day: string; ret: Record<string, [number, number]> }[] = [];
  const { results } = await db
    .prepare('SELECT start, ret FROM blocks WHERE site_id = ? AND level = 0 AND start BETWEEN ? AND ?')
    .bind(siteId, a, b)
    .all<{ start: number; ret: string }>();
  for (const r of results) out.push({ day: dayString(r.start), ret: JSON.parse(r.ret || '{}') });
  return out;
}

/** uid64s active on fold days [from, to] (for "already counted this week"). */
export async function freshActiveIds(db: D1Database, siteId: number, from: string, to: string): Promise<Set<string>> {
  const a = dayNumber(from);
  const b = dayNumber(to);
  const set = new Set<string>();
  if (a > b) return set;
  const blocks = await loadCover(db, siteId, a, b, ['users']);
  const all = unionUsers(blocks.map((x) => x.users ?? { kind: 'set', ids: [] }));
  if (all.kind === 'set') for (const id of all.ids) set.add(id);
  return set;
}

export { dimOfColumn, EMPTY };
