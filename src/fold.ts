/**
 * The cursor fold: one site's day as a single state that raw rows are folded
 * into, a few hundred at a time, in arrival order.
 *
 * Why a fold. Every question the dashboard asks about today used to be asked of
 * the day's raw rows, and D1 bills every row a query walks: a site with two
 * thousand daily users paid for its whole day on every dashboard load. Folded,
 * today is one stored row (`day_state`) plus the few minutes of rows since its
 * cursor, and the nightly block for a finished day is built from the state
 * alone — no full scan of the day, ever.
 *
 * The fold is pure and deterministic: `fold(fold(s, a), b)` serializes to the
 * same bytes as `fold(s, [...a, ...b])` for every split of the rows
 * (test/fold.test.ts). That is what makes it safe to fold in units on a
 * schedule, and to fold the unfolded tail again in memory on every read
 * without writing it back.
 *
 * Definitions, the same ones the older rollups used:
 *   - a visitor is one daily visitor hash; a visit is a visitor's pageviews
 *     in the UTC day, so a day has one visit per visitor with a pageview;
 *   - bounces are visits of one pageview; duration is last pageview minus
 *     first; entry and exit are the first and last pageview's path (ties in
 *     time broken by the tuple's text, as the SQL rollup's MIN/MAX did);
 *   - visit-level numbers (visits, bounces, duration, entrances, exits) are
 *     derived from each visitor's record, so when a returning visitor's record
 *     changes its old contribution is taken out and the new one put in;
 *   - time-of-day vectors use each event's own time (clamped into the day),
 *     visits count in the bucket where they started.
 *
 * Visitor records carry the ids of everything they touched (dimension values,
 * cube tuples, events, event-hours), so "distinct visitors" for each of those
 * is counted exactly once, the first time.
 */

/** A raw row as the fold reads it (`ev_*` columns; `k` as text, it is 64-bit). */
export interface FoldRow {
  ts: number;
  k: string;
  visitor: string;
  uid: string;
  name: string;
  path: string;
  ref: string;
  country: string;
  browser: string;
  os: string;
  device: string;
  screen: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  app_version: string;
  props: string;
  batch: string;
}

/** The columns a fold reads, in a SELECT list (k cast so it survives JavaScript numbers). */
export const FOLD_COLUMNS =
  'ts, CAST(k AS TEXT) AS k, visitor, uid, name, path, ref, country, browser, os, device, screen, ' +
  'utm_source, utm_medium, utm_campaign, app_version, props, batch';

/** Profile columns: one value per stored row. Order is the cube tuple's order after `path`. */
export const PROFILE_COLUMNS = [
  'ref', 'country', 'browser', 'os', 'device', 'screen', 'utm_source', 'utm_medium', 'utm_campaign', 'app_version',
] as const;
/** The cube tuple: path, then the profile. Same order as CUBE_TUPLE_COLUMNS in db.ts. */
export const TUPLE_COLUMNS = ['path', ...PROFILE_COLUMNS] as const;
/** The columns ranked per pageview. */
export const VIEW_DIMS = TUPLE_COLUMNS;

export const PROP_VALUES_PER_KEY = 50;
export const OTHER_VALUE = '(other)';
const SEP = '\u0001';

/** Per (column, value): [views, visitors]. `entry`/`exit`: [visits, visits]. */
export type DimTable = Record<string, Record<string, [number, number]>>;
/** Per event: [count, count by hour, distinct visitors by hour, distinct visitors]. */
export type EventTable = Record<string, [number, number[], number[], number]>;

export interface Core {
  /** [views, visits, bounces, duration, events] */
  t: [number, number, number, number, number];
  /** 24 hourly vectors: views, visits, bounces, duration. */
  h: { v: number[]; s: number[]; b: number[]; d: number[] };
  /** 144 ten-minute vectors (not cumulative; prefix sums give "so far"): views, visits, bounces, duration, new visitors, new uids. */
  m: { v: number[]; s: number[]; b: number[]; d: number[]; u: number[]; x: number[] };
  d: DimTable;
  e: EventTable;
  /**
   * Who may be online, for /api/realtime: short visitor hash -> [last arrival,
   * online until]. A web row keeps its visitor online 300 s from arrival, an
   * app segment 600 s from its last screen view. Entries that arrived more than
   * 900 s before the cursor are dropped at the end of every fold.
   */
  a: Record<string, [number, number]>;
}

/**
 * Cube entry measures: [pageviews, visitors, entrances, exits, bounces, duration].
 * Keyed `name␁path␁ref␁…␁app_version`.
 */
export type Cube = Record<string, number[]>;

/** One visitor's day: [hash, first, last, views, entry tuple id, exit tuple id, dim ids, tuple ids, event ids, event-hour codes]. */
export type VisitorRec = [string, number, number, number, number, number, number[], number[], number[], number[]];

export interface DayState {
  /** UTC epoch day. */
  day: number;
  /** The last row folded, as (ts, k): rows after it are the tail. */
  cur: [number, string];
  /** Raw rows folded so far today (the planner's estimate of a site's rate). */
  rows: number;
  core: Core;
  /** Interned strings the visitor records point at. */
  dict: string[];
  vis: VisitorRec[];
  /** uid64 (16 hex) -> first epoch day, or -1 while not yet looked up in app_users. */
  users: Map<string, number>;
  cube: Cube;
  /**
   * Today's filtered hours: `hour:tupleId` -> [pageviews, visits, bounces,
   * duration], visits counted at their entry tuple and first hour. Kept in the
   * state only (blocks have no hours under a filter), so a filtered `today`
   * reads no raw rows.
   */
  hc: Record<string, number[]>;
  /** event -> key -> value -> count, each key capped at PROP_VALUES_PER_KEY values plus '(other)'. */
  props: Record<string, Record<string, Record<string, number>>>;
  /** Not stored: full uids of pending users, for the app_users probe. */
  fresh?: Map<string, string>;
  /** Not stored: lookup indexes. */
  idx?: { dict: Map<string, number>; vis: Map<string, number> };
}

const zeros = (n: number): number[] => new Array<number>(n).fill(0);

export function emptyCore(): Core {
  return {
    t: [0, 0, 0, 0, 0],
    h: { v: zeros(24), s: zeros(24), b: zeros(24), d: zeros(24) },
    m: { v: zeros(144), s: zeros(144), b: zeros(144), d: zeros(144), u: zeros(144), x: zeros(144) },
    d: {},
    e: {},
    a: {},
  };
}

/** The largest k: a cursor at (t, MAX_K) has read every row of second t. */
export const MAX_K = '9223372036854775807';

/** A day's state with nothing folded; by default its cursor sits just before the day starts. */
export function emptyState(day: number, cursor: [number, string] = [day * 86_400 - 1, MAX_K]): DayState {
  return { day, cur: cursor, rows: 0, core: emptyCore(), dict: [], vis: [], users: new Map(), cube: {}, hc: {}, props: {} };
}

export const epochDay = (seconds: number): number => Math.floor(seconds / 86_400);
export const dayString = (epoch: number): string => new Date(epoch * 86_400_000).toISOString().slice(0, 10);
export const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/** Compare two (ts, k) cursors; k is a signed 64-bit integer as text. */
export function compareCursor(a: [number, string], b: [number, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  const x = BigInt(a[1]);
  const y = BigInt(b[1]);
  return x === y ? 0 : x < y ? -1 : 1;
}

function indexes(state: DayState): NonNullable<DayState['idx']> {
  if (!state.idx) {
    state.idx = {
      dict: new Map(state.dict.map((s, i) => [s, i])),
      vis: new Map(state.vis.map((v, i) => [v[0], i])),
    };
  }
  return state.idx;
}

function intern(state: DayState, value: string): number {
  const idx = indexes(state);
  let id = idx.dict.get(value);
  if (id === undefined) {
    id = state.dict.length;
    state.dict.push(value);
    idx.dict.set(value, id);
  }
  return id;
}

interface FoldEvent {
  t: number;
  name: string;
  path: string;
  props: unknown;
}

function expand(row: FoldRow): FoldEvent[] {
  if (!row.batch) {
    let props: unknown = null;
    if (row.props) {
      try {
        props = JSON.parse(row.props);
      } catch {
        props = null;
      }
    }
    return [{ t: row.ts, name: row.name, path: row.path, props }];
  }
  let list: unknown;
  try {
    list = JSON.parse(row.batch);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: FoldEvent[] = [];
  for (const item of list) {
    if (!Array.isArray(item)) continue;
    out.push({ t: Number(item[0]) || row.ts, name: String(item[1] ?? ''), path: String(item[2] ?? ''), props: item[3] ?? null });
  }
  return out;
}

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

function cubeEntry(cube: Cube, key: string): number[] {
  let entry = cube[key];
  if (!entry) {
    entry = [0, 0, 0, 0, 0, 0];
    cube[key] = entry;
  }
  return entry;
}

function dimEntry(d: DimTable, column: string, value: string): [number, number] {
  const table = (d[column] ??= {});
  let entry = table[value];
  if (!entry) {
    entry = [0, 0];
    table[value] = entry;
  }
  return entry;
}

/** Path of a cube key (`name␁path␁…`). */
export function tuplePath(key: string): string {
  const a = key.indexOf(SEP);
  const b = key.indexOf(SEP, a + 1);
  return key.slice(a + 1, b < 0 ? undefined : b);
}

/** A visitor's visit-level numbers in or out of the totals. */
function contribute(state: DayState, rec: VisitorRec, sign: 1 | -1): void {
  const n = rec[3];
  if (n <= 0) return;
  const core = state.core;
  const start = state.day * 86_400;
  const bounce = n === 1 ? sign : 0;
  const span = (rec[2] - rec[1]) * sign;
  core.t[1] += sign;
  core.t[2] += bounce;
  core.t[3] += span;
  const h = clamp(Math.floor((rec[1] - start) / 3600), 0, 23);
  const m = clamp(Math.floor((rec[1] - start) / 600), 0, 143);
  core.h.s[h]! += sign;
  core.h.b[h]! += bounce;
  core.h.d[h]! += span;
  core.m.s[m]! += sign;
  core.m.b[m]! += bounce;
  core.m.d[m]! += span;
  const entryKey = state.dict[rec[4]]!;
  const exitKey = state.dict[rec[5]]!;
  const entry = dimEntry(core.d, 'entry', tuplePath(entryKey));
  entry[0] += sign;
  entry[1] += sign;
  const exit = dimEntry(core.d, 'exit', tuplePath(exitKey));
  exit[0] += sign;
  exit[1] += sign;
  const entryProfile = entryKey.split(SEP).slice(2);
  for (let i = 0; i < PROFILE_COLUMNS.length; i += 1) dimEntry(core.d, PROFILE_COLUMNS[i]!, entryProfile[i] ?? '')[1] += sign;
  const ce = cubeEntry(state.cube, entryKey);
  ce[2]! += sign;
  ce[4]! += bounce;
  ce[5]! += span;
  cubeEntry(state.cube, exitKey)[3]! += sign;
  const hc = hourEntry(state.hc, `${h}:${rec[4]}`);
  hc[1]! += sign;
  hc[2]! += bounce;
  hc[3]! += span;
}

function hourEntry(hc: Record<string, number[]>, key: string): number[] {
  let entry = hc[key];
  if (!entry) {
    entry = [0, 0, 0, 0];
    hc[key] = entry;
  }
  return entry;
}

/** Today's hours under a filter stack (see DayState.hc): hour -> [views, visits, bounces, duration]. */
export function filteredHours(state: DayState, filters: ReadonlyArray<{ column: string; value: string }>): number[][] {
  const out = Array.from({ length: 24 }, () => [0, 0, 0, 0]);
  const groups = new Map<number, Set<string>>();
  for (const f of filters) {
    const at = TUPLE_COLUMNS.indexOf(f.column as (typeof TUPLE_COLUMNS)[number]);
    const set = groups.get(at);
    if (set) set.add(f.value);
    else groups.set(at, new Set([f.value]));
  }
  const matches = new Map<number, boolean>();
  for (const [key, m] of Object.entries(state.hc)) {
    const colon = key.indexOf(':');
    const hour = Number(key.slice(0, colon));
    const tid = Number(key.slice(colon + 1));
    let ok = matches.get(tid);
    if (ok === undefined) {
      const tuple = state.dict[tid]!.split(SEP).slice(1);
      ok = true;
      for (const [at, values] of groups) if (at < 0 || !values.has(tuple[at]!)) ok = false;
      matches.set(tid, ok);
    }
    if (!ok) continue;
    const row = out[hour]!;
    for (let i = 0; i < 4; i += 1) row[i]! += m[i]!;
  }
  return out;
}

function pushOnce(list: number[], id: number): boolean {
  if (list.includes(id)) return false;
  list.push(id);
  return true;
}

function addProps(state: DayState, name: string, props: unknown): void {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return;
  const byKey = (state.props[name] ??= {});
  for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const values = (byKey[key] ??= {});
    if (values[value] !== undefined) values[value] += 1;
    else if (Object.keys(values).filter((v) => v !== OTHER_VALUE).length < PROP_VALUES_PER_KEY) values[value] = 1;
    else values[OTHER_VALUE] = (values[OTHER_VALUE] ?? 0) + 1;
  }
}

/** Fold rows (already in (ts, k) order, all after the cursor) into the state. Mutates and returns it. */
export function fold(state: DayState, rows: readonly FoldRow[]): DayState {
  const idx = indexes(state);
  const core = state.core;
  const start = state.day * 86_400;
  for (const row of rows) {
    state.cur = [row.ts, String(row.k)];
    state.rows += 1;
    let vi = idx.vis.get(row.visitor);
    let rec: VisitorRec;
    if (vi === undefined) {
      rec = [row.visitor, 0, 0, 0, -1, -1, [], [], [], []];
      vi = state.vis.length;
      state.vis.push(rec);
      idx.vis.set(row.visitor, vi);
      core.m.u[clamp(Math.floor((row.ts - start) / 600), 0, 143)]! += 1;
    } else {
      rec = state.vis[vi]!;
    }
    if (row.uid) {
      const key = row.uid.slice(0, 16);
      if (!state.users.has(key)) {
        state.users.set(key, -1);
        (state.fresh ??= new Map()).set(key, row.uid);
        core.m.x[clamp(Math.floor((row.ts - start) / 600), 0, 143)]! += 1;
      }
    }
    const profile = PROFILE_COLUMNS.map((c) => String(row[c] ?? ''));
    const profileKey = profile.join(SEP);
    const events = expand(row);
    let lastView = 0;
    for (const ev of events) if (ev.name === 'pageview' && ev.t > lastView) lastView = ev.t;
    const until = row.batch && lastView > 0 ? lastView + 600 : row.ts + 300;
    const short = row.visitor.slice(0, 12);
    const live = (core.a[short] ??= [row.ts, until]);
    if (row.ts > live[0]) live[0] = row.ts;
    if (until > live[1]) live[1] = until;
    for (const ev of events) {
      const hour = clamp(Math.floor((ev.t - start) / 3600), 0, 23);
      const bucket = clamp(Math.floor((ev.t - start) / 600), 0, 143);
      const tupleKey = `${ev.name}${SEP}${ev.path}${SEP}${profileKey}`;
      const tid = intern(state, tupleKey);
      const cube = cubeEntry(state.cube, tupleKey);
      cube[0]! += 1;
      if (pushOnce(rec[7], tid)) cube[1]! += 1;
      if (ev.name === 'pageview') {
        hourEntry(state.hc, `${hour}:${tid}`)[0]! += 1;
        contribute(state, rec, -1);
        if (rec[3] === 0 || ev.t < rec[1] || (ev.t === rec[1] && tupleKey < state.dict[rec[4]]!)) {
          rec[1] = ev.t;
          rec[4] = tid;
        }
        if (rec[3] === 0 || ev.t > rec[2] || (ev.t === rec[2] && tupleKey > state.dict[rec[5]]!)) {
          rec[2] = ev.t;
          rec[5] = tid;
        }
        rec[3] += 1;
        contribute(state, rec, 1);
        core.t[0] += 1;
        core.h.v[hour]! += 1;
        core.m.v[bucket]! += 1;
        for (let i = 0; i < VIEW_DIMS.length; i += 1) {
          const column = VIEW_DIMS[i]!;
          const value = i === 0 ? ev.path : profile[i - 1]!;
          const entry = dimEntry(core.d, column, value);
          entry[0] += 1;
          // Paths count each visitor who viewed them; profile values count
          // visits by their entry (in contribute), as the older rollups did.
          if (i === 0 && pushOnce(rec[6], intern(state, `${column}${SEP}${value}`))) entry[1] += 1;
        }
      } else if (ev.name) {
        core.t[4] += 1;
        let e = core.e[ev.name];
        if (!e) {
          e = [0, zeros(24), zeros(24), 0];
          core.e[ev.name] = e;
        }
        e[0] += 1;
        e[1][hour]! += 1;
        const eid = intern(state, `event${SEP}${ev.name}`);
        if (pushOnce(rec[8], eid)) e[3] += 1;
        if (pushOnce(rec[9], eid * 24 + hour)) e[2][hour]! += 1;
        addProps(state, ev.name, ev.props);
      }
    }
  }
  const horizon = state.cur[0] - 900;
  for (const [key, live] of Object.entries(core.a)) if (live[0] < horizon) delete core.a[key];
  return state;
}

/* ------------------------------------------------------------ storage ----- */

/** Everything but users, as stored text columns. */
export interface StateColumns {
  core: string;
  visitors: string;
  cube: string;
  props: string;
}

export function encodeState(state: DayState): StateColumns {
  return {
    // Arrivals sorted, so a state encodes the same however its rows were split.
    core: JSON.stringify({
      r: state.rows,
      ...state.core,
      a: Object.fromEntries(Object.entries(state.core.a).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))),
    }),
    visitors: JSON.stringify({ dict: state.dict, vis: state.vis, hc: state.hc }),
    cube: JSON.stringify(state.cube),
    props: JSON.stringify(state.props),
  };
}

/** Sorted uid64 keys, each followed by a 2-byte first-day offset (0xffff: not looked up). */
export function encodeUsers(users: Map<string, number>, day: number): Uint8Array {
  const keys = [...users.keys()].sort();
  const out = new Uint8Array(keys.length * 10);
  keys.forEach((key, i) => {
    for (let b = 0; b < 8; b += 1) out[i * 10 + b] = Number.parseInt(key.slice(b * 2, b * 2 + 2), 16) || 0;
    const first = users.get(key)!;
    const offset = first < 0 ? 0xffff : Math.min(0xfffe, Math.max(0, day - first));
    out[i * 10 + 8] = offset >> 8;
    out[i * 10 + 9] = offset & 0xff;
  });
  return out;
}

export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return new Uint8Array(0);
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export function hex8(bytes: Uint8Array, at: number): string {
  let s = '';
  for (let b = 0; b < 8; b += 1) s += HEX[bytes[at + b]!];
  return s;
}

export function decodeUsers(raw: unknown, day: number): Map<string, number> {
  const bytes = toBytes(raw);
  const users = new Map<string, number>();
  for (let i = 0; i + 10 <= bytes.length; i += 10) {
    const offset = (bytes[i + 8]! << 8) | bytes[i + 9]!;
    users.set(hex8(bytes, i), offset === 0xffff ? -1 : day - offset);
  }
  return users;
}

export function decodeState(
  day: number,
  cursor: [number, string],
  cols: StateColumns,
  users: unknown,
): DayState {
  const core = JSON.parse(cols.core) as Core & { r?: number };
  const rows = core.r ?? 0;
  delete core.r;
  core.a ??= {};
  const v = JSON.parse(cols.visitors) as { dict: string[]; vis: VisitorRec[]; hc?: Record<string, number[]> };
  return {
    day,
    cur: cursor,
    rows,
    core,
    dict: v.dict,
    vis: v.vis,
    hc: v.hc ?? {},
    users: decodeUsers(users, day),
    cube: JSON.parse(cols.cube) as Cube,
    props: JSON.parse(cols.props) as DayState['props'],
  };
}

/** A deep, independent copy (a reader folds its tail into a copy, never into a cached state). */
export function cloneState(state: DayState): DayState {
  const cols = encodeState(state);
  const copy = decodeState(state.day, [...state.cur] as [number, string], cols, encodeUsers(state.users, state.day));
  copy.users = new Map(state.users);
  if (state.fresh) copy.fresh = new Map(state.fresh);
  return copy;
}

/* ------------------------------------------------------- reading a state -- */

/** Visit components cut at a ten-minute bucket (inclusive), from the 144 vectors. */
export function cutComponents(m: { v: number[]; s: number[]; b: number[]; d: number[] }, through: number) {
  const sum = (a: number[]) => a.slice(0, through + 1).reduce((x, y) => x + y, 0);
  return { views: sum(m.v), visits: sum(m.s), bounces: sum(m.b), duration: sum(m.d) };
}

/**
 * Rows of the cube that match a filter stack, as {name, tuple, measures}.
 * Values on one column are OR-ed, columns AND-ed (query.ts filterClause).
 */
export function cubeRows(cube: Cube, filters: ReadonlyArray<{ column: string; value: string }>) {
  const groups = new Map<number, Set<string>>();
  for (const f of filters) {
    const at = TUPLE_COLUMNS.indexOf(f.column as (typeof TUPLE_COLUMNS)[number]);
    const set = groups.get(at);
    if (set) set.add(f.value);
    else groups.set(at, new Set([f.value]));
  }
  const out: { name: string; tuple: string[]; m: number[] }[] = [];
  for (const [key, m] of Object.entries(cube)) {
    const parts = key.split(SEP);
    const tuple = parts.slice(1);
    let ok = true;
    for (const [at, values] of groups) {
      if (at < 0 || !values.has(tuple[at]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ name: parts[0]!, tuple, m });
  }
  return out;
}

/** The state's cube in stats_cube2's shape: {name: [[path, ref, …, app_version, pageviews, visitors, entrances, exits, bounces, duration]]}. */
export function cubeTable(cube: Cube): Record<string, (string | number)[][]> {
  const out: Record<string, (string | number)[][]> = {};
  for (const key of Object.keys(cube).sort()) {
    const m = cube[key]!;
    if (m.every((x) => x === 0)) continue;
    const parts = key.split(SEP);
    (out[parts[0]!] ??= []).push([...parts.slice(1), ...m]);
  }
  return out;
}

/** Back from stats_cube2's shape to keyed entries. */
export function cubeFromTable(table: Record<string, (string | number)[][]>): Cube {
  const cube: Cube = {};
  const width = TUPLE_COLUMNS.length;
  for (const [name, rows] of Object.entries(table)) {
    for (const row of rows) {
      cube[[name, ...row.slice(0, width).map(String)].join(SEP)] = row.slice(width).map(Number);
    }
  }
  return cube;
}
