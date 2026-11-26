/**
 * Dyadic blocks: a finished day, or 2^level finished days, as one stored row.
 *
 * A level-0 block is built from a site's final day_state the night after; a
 * level-k block (k = 1..9) merges its two level-(k-1) children when the
 * 2^k-day period it covers has ended. `start` is an epoch day and a multiple
 * of 2^level, so any range of finished days is covered greedily by at most
 * two blocks per level — a year is about a dozen rows instead of 365, and a
 * 30-day range about eight. A reader asks once per level
 * (`level = ? AND start IN (…)`); a block that was never built (a quiet
 * period, or a level not built yet) is a primary-key miss, which D1 bills as
 * nothing, and is covered by its two children instead.
 *
 * Columns (JSON unless noted):
 *   core   per-day vectors (views, visits, bounces, duration, events, dau,
 *          new); at level 0 also the 24-hour and 144 ten-minute vectors; per
 *          ranked column the top 500 values plus the rest summed; per event
 *          (top 100) a per-day [count, users]; `cap` when anything was cut,
 *          which readers report as `approx: true`
 *   users  BLOB: flag byte 0 then sorted 8-byte uid hashes, or flag 1 then a
 *          HyperLogLog sketch (p = 12) once a block holds over 100k users
 *   pairs  level 0: one filter's answers, {F: {f: {_: [views, visits,
 *          bounces, duration, visitors], B: {b: [views, visitors]}}}}, at
 *          most 200 values per filter dimension
 *   cube   level 0: the day's tuples, stats_cube2's shape, for two or more
 *          filters (and one filter whose value is past the 200)
 *   props  event -> key -> value -> count, 50 values per key plus '(other)'
 *   ret    level 0: {first_day: [active, week_new]} (app_daily.ret's shape)
 */
import { addToSketch, estimateSketch, newSketch } from './app-analytics';
import {
  type Core,
  type DayState,
  OTHER_VALUE,
  PROP_VALUES_PER_KEY,
  TUPLE_COLUMNS,
  cubeFromTable,
  cubeRows,
  cubeTable,
  dayString,
  hex8,
  toBytes,
} from './fold';

export const MAX_LEVEL = 9;
export const DIM_TOP = 500;
export const EVENT_TOP = 100;
export const PAIR_VALUES = 200;
export const PAIR_ROWS = 50;
export const HLL_FROM = 100_000;
/** Above this a block row leaves out pairs (readers use the cube instead). */
const ROW_BUDGET = 1_800_000;
export const BLOCK_FMT = 1;

/** Column name (raw) -> the dimension name readers use. */
export const COLUMN_DIM: Record<string, string> = { ref: 'referrer' };
export const dimOfColumn = (column: string): string => COLUMN_DIM[column] ?? column;
export const columnOfDim = (dim: string): string => (dim === 'referrer' ? 'ref' : dim);

export type Vectors = Record<'views' | 'visits' | 'bounces' | 'duration' | 'events' | 'dau' | 'new', number[]>;
const VECTOR_KEYS = ['views', 'visits', 'bounces', 'duration', 'events', 'dau', 'new'] as const;

export interface BlockCore {
  /** Days covered. */
  n: number;
  v: Vectors;
  h?: Core['h'];
  m?: Core['m'];
  /** column -> [value, a, b][] (views/visitors, or visits for entry/exit) */
  d: Record<string, [string, number, number][]>;
  /** column -> the rest, summed. */
  o: Record<string, [number, number]>;
  /** event -> [count per day, users per day] */
  e: Record<string, [number[], number[]]>;
  /** Level 0: event -> [count per hour, distinct visitors per hour]. */
  eh?: Record<string, [number[], number[]]>;
  cap: 0 | 1;
}

export interface Block {
  level: number;
  start: number;
  core?: BlockCore;
  users?: UserSet;
  props?: DayState['props'];
  ret?: Record<string, [number, number]>;
  cube?: Record<string, (string | number)[][]>;
  /** One filter's answer, when read with json_extract (undefined: not stored for that dimension). */
  pair?: Pair | null;
  pairsMissing?: boolean;
}

export type UserSet = { kind: 'set'; ids: string[] } | { kind: 'hll'; registers: Uint8Array };

export interface Pair {
  _: [number, number, number, number, number];
  B: Record<string, Record<string, [number, number]>>;
}

/* ----------------------------------------------------------- user sets ---- */

export function encodeUserSet(set: UserSet): Uint8Array {
  if (set.kind === 'hll') {
    const out = new Uint8Array(1 + set.registers.length);
    out[0] = 1;
    out.set(set.registers, 1);
    return out;
  }
  const out = new Uint8Array(1 + set.ids.length * 8);
  set.ids.forEach((id, i) => {
    for (let b = 0; b < 8; b += 1) out[1 + i * 8 + b] = Number.parseInt(id.slice(b * 2, b * 2 + 2), 16) || 0;
  });
  return out;
}

export function decodeUserSet(raw: unknown): UserSet {
  const bytes = toBytes(raw);
  if (bytes.length === 0) return { kind: 'set', ids: [] };
  if (bytes[0] === 1) return { kind: 'hll', registers: bytes.slice(1) };
  const ids: string[] = [];
  for (let i = 1; i + 8 <= bytes.length; i += 8) ids.push(hex8(bytes, i));
  return { kind: 'set', ids };
}

/** Union of user sets: exact while every part is a list and the result stays under 100k. */
export function unionUsers(sets: UserSet[]): UserSet {
  if (sets.every((s) => s.kind === 'set')) {
    const all = new Set<string>();
    for (const s of sets) for (const id of (s as { ids: string[] }).ids) all.add(id);
    if (all.size <= HLL_FROM) return { kind: 'set', ids: [...all].sort() };
  }
  const registers = newSketch();
  for (const s of sets) {
    if (s.kind === 'set') addToSketch(registers, s.ids);
    else for (let i = 0; i < registers.length; i += 1) if (s.registers[i]! > registers[i]!) registers[i] = s.registers[i]!;
  }
  return { kind: 'hll', registers };
}

export function countUsers(set: UserSet): number {
  return set.kind === 'set' ? set.ids.length : estimateSketch(set.registers);
}

/* -------------------------------------------------------------- build ----- */

function rank(entries: [string, number, number][], top: number): { kept: [string, number, number][]; rest: [number, number]; cut: boolean } {
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const kept = entries.slice(0, top);
  const rest: [number, number] = [0, 0];
  for (const e of entries.slice(top)) {
    rest[0] += e[1];
    rest[1] += e[2];
  }
  return { kept, rest, cut: entries.length > top };
}

function capProps(props: DayState['props']): DayState['props'] {
  const out: DayState['props'] = {};
  for (const [event, keys] of Object.entries(props)) {
    for (const [key, values] of Object.entries(keys)) {
      const sorted = Object.entries(values)
        .filter(([v]) => v !== OTHER_VALUE)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const kept: Record<string, number> = {};
      let other = values[OTHER_VALUE] ?? 0;
      sorted.forEach(([v, n], i) => {
        if (i < PROP_VALUES_PER_KEY) kept[v] = n;
        else other += n;
      });
      if (other > 0) kept[OTHER_VALUE] = other;
      ((out[event] ??= {})[key] = kept);
    }
  }
  return out;
}

export function mergeProps(into: DayState['props'], from: DayState['props'] | undefined): void {
  if (!from) return;
  for (const [event, keys] of Object.entries(from)) {
    for (const [key, values] of Object.entries(keys)) {
      const target = ((into[event] ??= {})[key] ??= {});
      for (const [v, n] of Object.entries(values)) target[v] = (target[v] ?? 0) + n;
    }
  }
}

/** One filter's answers from cube rows: totals plus each ranked dimension. */
export function aggregateCube(rows: ReturnType<typeof cubeRows>): Pair {
  const pair: Pair = { _: [0, 0, 0, 0, 0], B: {} };
  const bump = (dim: string, value: string, a: number, b: number): void => {
    if (a === 0 && b === 0) return;
    const table = (pair.B[dim] ??= {});
    const entry = (table[value] ??= [0, 0]);
    entry[0] += a;
    entry[1] += b;
  };
  for (const row of rows) {
    const [pv, visitors, entrances, exits, bounces, duration] = row.m as [number, number, number, number, number, number];
    if (row.name === 'pageview') {
      pair._[0] += pv;
      pair._[1] += entrances;
      pair._[2] += bounces;
      pair._[3] += duration;
      pair._[4] += visitors;
      TUPLE_COLUMNS.forEach((column, i) => bump(dimOfColumn(column), row.tuple[i]!, pv, visitors));
      bump('entry', row.tuple[0]!, entrances, entrances);
      bump('exit', row.tuple[0]!, exits, exits);
    } else if (row.name) {
      bump('event', row.name, pv, visitors);
    }
  }
  return pair;
}

function trimPair(pair: Pair): Pair {
  const B: Pair['B'] = {};
  for (const [dim, table] of Object.entries(pair.B)) {
    const sorted = Object.entries(table).sort((a, b) => b[1][0] - a[1][0] || (a[0] < b[0] ? -1 : 1));
    B[dim] = Object.fromEntries(sorted.slice(0, PAIR_ROWS));
  }
  return { _: pair._, B };
}

/** The level-0 `pairs` column: per filter dimension, its 200 busiest values. */
export function buildPairs(cube: DayState['cube']): Record<string, Record<string, Pair | number>> {
  const all = cubeRows(cube, []);
  const out: Record<string, Record<string, Pair | number>> = {};
  TUPLE_COLUMNS.forEach((column, i) => {
    const byValue = new Map<string, ReturnType<typeof cubeRows>>();
    for (const row of all) {
      const list = byValue.get(row.tuple[i]!);
      if (list) list.push(row);
      else byValue.set(row.tuple[i]!, [row]);
    }
    const values = [...byValue.entries()]
      .map(([value, rows]) => ({ value, pair: aggregateCube(rows) }))
      .filter((x) => x.pair._[0] > 0 || Object.keys(x.pair.B).length > 0)
      .sort((a, b) => b.pair._[0] - a.pair._[0] || (a.value < b.value ? -1 : 1));
    const table: Record<string, Pair | number> = {};
    for (const x of values.slice(0, PAIR_VALUES)) table[x.value] = trimPair(x.pair);
    if (values.length > PAIR_VALUES) table['~cap'] = 1;
    out[dimOfColumn(column)] = table;
  });
  return out;
}

/** Users active on `day`, by first day (the last 210 days), with how many were new to the Monday-based week. */
export function buildRet(state: DayState, earlierThisWeek: Set<string>): Record<string, [number, number]> {
  const ret: Record<string, [number, number]> = {};
  for (const [uid, first] of state.users) {
    const firstDay = first < 0 ? state.day : first;
    if (state.day - firstDay > 210) continue;
    const key = dayString(firstDay);
    const entry = (ret[key] ??= [0, 0]);
    entry[0] += 1;
    if (!earlierThisWeek.has(uid)) entry[1] += 1;
  }
  return ret;
}

export interface BuiltBlock {
  core: string;
  users: Uint8Array;
  pairs: string;
  cube: string;
  props: string;
  ret: string;
}

/** The level-0 block of a finished day. */
export function buildDayBlock(state: DayState, earlierThisWeek: Set<string>): BuiltBlock {
  const c = state.core;
  const d: BlockCore['d'] = {};
  const o: BlockCore['o'] = {};
  let cap: 0 | 1 = 0;
  for (const [column, table] of Object.entries(c.d)) {
    const entries = Object.entries(table)
      .filter(([, x]) => x[0] !== 0 || x[1] !== 0)
      .map(([name, x]) => [name, x[0], x[1]] as [string, number, number]);
    const r = rank(entries, DIM_TOP);
    d[column] = r.kept;
    if (r.cut) {
      o[column] = r.rest;
      cap = 1;
    }
  }
  const events = Object.entries(c.e).sort((a, b) => b[1][0] - a[1][0] || (a[0] < b[0] ? -1 : 1));
  if (events.length > EVENT_TOP) cap = 1;
  const e: BlockCore['e'] = {};
  const eh: NonNullable<BlockCore['eh']> = {};
  for (const [name, x] of events.slice(0, EVENT_TOP)) {
    e[name] = [[x[0]], [x[3]]];
    eh[name] = [x[1], x[2]];
  }
  let fresh = 0;
  for (const first of state.users.values()) if (first < 0 || first === state.day) fresh += 1;
  const core: BlockCore = {
    n: 1,
    v: {
      views: [c.t[0]],
      visits: [c.t[1]],
      bounces: [c.t[2]],
      duration: [c.t[3]],
      events: [c.t[4]],
      dau: [state.users.size],
      new: [fresh],
    },
    h: c.h,
    m: c.m,
    d,
    o,
    e,
    eh,
    cap,
  };
  const coreText = JSON.stringify(core);
  const cubeText = JSON.stringify(cubeTable(state.cube));
  const propsText = JSON.stringify(capProps(state.props));
  const retText = JSON.stringify(buildRet(state, earlierThisWeek));
  const users = encodeUserSet({ kind: 'set', ids: [...state.users.keys()].sort() });
  let pairsText = JSON.stringify(buildPairs(state.cube));
  const size = coreText.length + cubeText.length + propsText.length + retText.length + users.length;
  if (size + pairsText.length > ROW_BUDGET) pairsText = '';
  return { core: coreText, users, pairs: pairsText, cube: size > ROW_BUDGET ? '' : cubeText, props: propsText, ret: retText };
}

const emptyVectors = (n: number): Vectors =>
  Object.fromEntries(VECTOR_KEYS.map((k) => [k, new Array<number>(n).fill(0)])) as Vectors;

/** Merge two children (either may be absent) into their parent's core. */
export function mergeCores(left: BlockCore | undefined, right: BlockCore | undefined, half: number): BlockCore {
  const n = half * 2;
  const v = emptyVectors(n);
  for (const key of VECTOR_KEYS) {
    left?.v[key].forEach((x, i) => (v[key][i] = x));
    right?.v[key].forEach((x, i) => (v[key][half + i] = x));
  }
  let cap: 0 | 1 = (left?.cap ?? 0) | (right?.cap ?? 0) ? 1 : 0;
  const d: BlockCore['d'] = {};
  const o: BlockCore['o'] = {};
  const columns = new Set([...Object.keys(left?.d ?? {}), ...Object.keys(right?.d ?? {})]);
  for (const column of columns) {
    const sum = new Map<string, [number, number]>();
    for (const side of [left, right]) {
      for (const [name, a, b] of side?.d[column] ?? []) {
        const x = sum.get(name);
        if (x) {
          x[0] += a;
          x[1] += b;
        } else sum.set(name, [a, b]);
      }
    }
    const r = rank([...sum.entries()].map(([name, [a, b]]) => [name, a, b]), DIM_TOP);
    d[column] = r.kept;
    const rest: [number, number] = [r.rest[0], r.rest[1]];
    for (const side of [left, right]) {
      const x = side?.o[column];
      if (x) {
        rest[0] += x[0];
        rest[1] += x[1];
      }
    }
    if (rest[0] > 0 || rest[1] > 0) o[column] = rest;
    if (r.cut) cap = 1;
  }
  const totals = new Map<string, [number[], number[]]>();
  const place = (side: BlockCore | undefined, offset: number): void => {
    for (const [name, [count, users]] of Object.entries(side?.e ?? {})) {
      let x = totals.get(name);
      if (!x) {
        x = [new Array<number>(n).fill(0), new Array<number>(n).fill(0)];
        totals.set(name, x);
      }
      count.forEach((c, i) => (x[0][offset + i] = c));
      users.forEach((u, i) => (x[1][offset + i] = u));
    }
  };
  place(left, 0);
  place(right, half);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const events = [...totals.entries()].sort((a, b) => sum(b[1][0]) - sum(a[1][0]) || (a[0] < b[0] ? -1 : 1));
  if (events.length > EVENT_TOP) cap = 1;
  return { n, v, d, o, e: Object.fromEntries(events.slice(0, EVENT_TOP)), cap };
}

export function mergeBlockProps(a: DayState['props'] | undefined, b: DayState['props'] | undefined): DayState['props'] {
  const out: DayState['props'] = {};
  mergeProps(out, a);
  mergeProps(out, b);
  return capProps(out);
}

/* -------------------------------------------------------------- cover ----- */

/** Greedy dyadic cover of epoch days [from, to]: (level, start) pairs, largest first. */
export function dyadicCover(from: number, to: number): { level: number; start: number }[] {
  const out: { level: number; start: number }[] = [];
  let a = from;
  while (a <= to) {
    let k = MAX_LEVEL;
    while (k > 0 && (a % (1 << k) !== 0 || a + (1 << k) - 1 > to)) k -= 1;
    out.push({ level: k, start: a });
    a += 1 << k;
  }
  return out;
}

/* --------------------------------------------------- decoded-block cache -- */

const CACHE_MAX = 400;
const cache = new Map<string, Block>();

/** Forget every decoded block (after a block is written, and between tests). */
export function clearBlockCache(): void {
  cache.clear();
}

export type BlockColumn = 'core' | 'users' | 'props' | 'ret' | 'cube';

function remember(key: string, block: Block): void {
  cache.delete(key);
  cache.set(key, block);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

interface BlockRowRaw {
  level: number;
  start: number;
  core?: string;
  users?: unknown;
  props?: string;
  ret?: string;
  cube?: string;
  pair?: string | null;
  missing?: number;
}

function decodeRow(row: BlockRowRaw, columns: readonly BlockColumn[]): Block {
  const block: Block = { level: row.level, start: row.start };
  if (columns.includes('core') && row.core) block.core = JSON.parse(row.core) as BlockCore;
  if (columns.includes('users')) block.users = decodeUserSet(row.users);
  if (columns.includes('props') && row.props) block.props = JSON.parse(row.props) as DayState['props'];
  if (columns.includes('ret') && row.ret) block.ret = JSON.parse(row.ret) as Block['ret'];
  if (columns.includes('cube') && row.cube) block.cube = JSON.parse(row.cube) as Block['cube'];
  return block;
}

/**
 * The blocks covering finished days [from, to] (epoch days), decoded. A block
 * that is not stored is replaced by its two children, down to level 0; a day
 * with no level-0 block had no data. One query per level per round.
 */
export async function loadCover(
  db: D1Database,
  siteId: number,
  from: number,
  to: number,
  columns: readonly BlockColumn[],
): Promise<Block[]> {
  if (from > to) return [];
  const found: Block[] = [];
  let wanted = dyadicCover(from, to);
  const tag = columns.join(',');
  while (wanted.length > 0) {
    const pending: { level: number; start: number }[] = [];
    for (const w of wanted) {
      const hit = cache.get(`${siteId}:${w.level}:${w.start}:${tag}`);
      if (hit) {
        remember(`${siteId}:${w.level}:${w.start}:${tag}`, hit);
        found.push(hit);
      } else pending.push(w);
    }
    const byLevel = new Map<number, number[]>();
    for (const w of pending) {
      const list = byLevel.get(w.level);
      if (list) list.push(w.start);
      else byLevel.set(w.level, [w.start]);
    }
    const next: { level: number; start: number }[] = [];
    for (const [level, starts] of byLevel) {
      for (let i = 0; i < starts.length; i += 90) {
        const chunk = starts.slice(i, i + 90);
        const { results } = await db
          .prepare(
            `SELECT level, start, ${columns.join(', ')} FROM blocks
             WHERE site_id = ? AND level = ? AND start IN (${chunk.map(() => '?').join(', ')})`,
          )
          .bind(siteId, level, ...chunk)
          .all<BlockRowRaw>();
        const got = new Set<number>();
        for (const row of results) {
          got.add(row.start);
          const block = decodeRow(row, columns);
          remember(`${siteId}:${level}:${row.start}:${tag}`, block);
          found.push(block);
        }
        if (level > 0) {
          const half = 1 << (level - 1);
          for (const start of chunk) if (!got.has(start)) next.push({ level: level - 1, start }, { level: level - 1, start: start + half });
        }
      }
    }
    wanted = next;
  }
  return found.sort((a, b) => a.start - b.start);
}

/** One filter's per-day answers from level-0 pairs (json_extract opens only that value). */
export async function loadPairs(
  db: D1Database,
  siteId: number,
  from: number,
  to: number,
  dim: string,
  value: string,
): Promise<{ start: number; pair: Pair | null; fallback: boolean }[]> {
  if (from > to) return [];
  // A range, not an IN list: D1 bills a long IN list about twice per row.
  const { results } = await db
    .prepare(
      `SELECT start, pairs = '' AS missing,
              json_extract(CASE WHEN pairs = '' THEN '{}' ELSE pairs END, '$.' || json_quote(?) || '.' || json_quote(?)) AS pair,
              json_extract(CASE WHEN pairs = '' THEN '{}' ELSE pairs END, '$.' || json_quote(?) || '."~cap"') AS capped
       FROM blocks WHERE site_id = ? AND level = 0 AND start BETWEEN ? AND ?`,
    )
    .bind(dim, value, dim, siteId, from, to)
    .all<{ start: number; missing: number; pair: string | null; capped: number | null }>();
  return results.map((r) => ({
    start: r.start,
    pair: r.pair ? (JSON.parse(r.pair) as Pair) : null,
    fallback: !!r.missing || (!r.pair && !!r.capped),
  }));
}

/** Level-0 cubes for a set of days, decoded to keyed entries. */
export async function loadCubes(db: D1Database, siteId: number, days: number[]): Promise<Map<number, DayState['cube']>> {
  const out = new Map<number, DayState['cube']>();
  if (days.length === 0) return out;
  // One range over the days (≤ 31 of them): D1 bills a long IN list about
  // twice per row, a range once.
  const wanted = new Set(days);
  const { results } = await db
    .prepare('SELECT start, cube FROM blocks WHERE site_id = ? AND level = 0 AND start BETWEEN ? AND ?')
    .bind(siteId, Math.min(...days), Math.max(...days))
    .all<{ start: number; cube: string }>();
  for (const row of results) if (wanted.has(row.start)) out.set(row.start, row.cube ? cubeFromTable(JSON.parse(row.cube)) : {});
  return out;
}

/** Write a block row. */
export function blockStatement(db: D1Database, siteId: number, level: number, start: number, b: Partial<BuiltBlock> & { core: string }): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO blocks (site_id, level, start, fmt, core, users, pairs, cube, props, ret)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, level, start) DO UPDATE SET fmt = excluded.fmt, core = excluded.core, users = excluded.users,
         pairs = excluded.pairs, cube = excluded.cube, props = excluded.props, ret = excluded.ret`,
    )
    .bind(siteId, level, start, BLOCK_FMT, b.core, b.users ?? new Uint8Array([0]), b.pairs ?? '', b.cube ?? '', b.props ?? '{}', b.ret ?? '{}');
}
