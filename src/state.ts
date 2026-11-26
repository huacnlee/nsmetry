/**
 * day_state on disk, the raw tail after its cursor, and the fold units the
 * cron dispatches (src/rollup.ts plans them).
 *
 * Reading today is: one day_state row (a range seek over site_id*16..+15,
 * normally one row) plus a seek of the raw rows after its cursor in the hour
 * tables it can reach (normally the last ten minutes of one or two hours),
 * folded in memory and never written back. Nothing here lists sqlite_master:
 * hour tables are addressed by name and a missing one is an empty one.
 */
import { SETTING_BLOCKS_FROM, getSetting, rawTable } from './db';
import {
  type DayState,
  type FoldRow,
  FOLD_COLUMNS,
  decodeState,
  emptyState,
  encodeState,
  encodeUsers,
  epochDay,
  dayString,
  fold,
} from './fold';
import {
  blockStatement,
  buildDayBlock,
  clearBlockCache,
  decodeUserSet,
  encodeUserSet,
  mergeBlockProps,
  mergeCores,
  unionUsers,
  type BlockCore,
  type UserSet,
  MAX_LEVEL,
} from './blocks';
import { partsForTs } from './time';

/** Raw rows one fold unit may read (the CPU proxy). */
export const UNIT_ROWS = 300;
/** The cursor never passes now − 5 s: a row stamped "now" may still be on its way in. */
export const SETTLE_SECONDS = 5;
/** A stored state row's budget; beyond it the state continues in shard rows. */
export const SHARD_BYTES = 1_800_000;
const MAX_SHARDS = 16;
const STATE_FMT = 1;

const isGone = (error: unknown): boolean => /no such table/i.test(String(error));

/* --------------------------------------------------------- blocks_from ---- */

let blocksFromCache: { value: string | null; at: number } | null = null;

/** The first day the fold owns, or null before the first scheduled run (cached a minute). */
export async function blocksFrom(db: D1Database): Promise<string | null> {
  const now = Date.now();
  if (blocksFromCache && now - blocksFromCache.at < 60_000) return blocksFromCache.value;
  const value = await getSetting(db, SETTING_BLOCKS_FROM);
  blocksFromCache = { value, at: now };
  return value;
}

export function resetBlocksFromCache(): void {
  blocksFromCache = null;
}

/* -------------------------------------------------------------- storage --- */

interface StateRow {
  site_id: number;
  day: number;
  cur_ts: number;
  cur_k: string;
  fmt: number;
  core: string;
  visitors: string;
  users: unknown;
  cube: string;
  props: string;
}

/** A site's stored state, or null. One range seek; shards are concatenated column by column. */
export async function readState(db: D1Database, siteId: number): Promise<DayState | null> {
  const { results } = await db
    .prepare(
      `SELECT site_id, day, cur_ts, cur_k, fmt, core, visitors, users, cube, props FROM day_state
       WHERE site_id BETWEEN ? AND ? ORDER BY site_id`,
    )
    .bind(siteId * 16, siteId * 16 + MAX_SHARDS - 1)
    .all<StateRow>();
  const head = results[0];
  if (!head || head.site_id !== siteId * 16 || !head.core) return null;
  const shards = Math.max(1, head.fmt >> 8);
  const parts = results.slice(0, shards);
  const join = (key: 'core' | 'visitors' | 'cube' | 'props') => parts.map((p) => p[key] ?? '').join('');
  try {
    return decodeState(head.day, [head.cur_ts, String(head.cur_k)], {
      core: join('core'),
      visitors: join('visitors'),
      cube: join('cube'),
      props: join('props'),
    }, head.users);
  } catch {
    // A torn or unreadable state is rebuilt from the day's raw rows.
    return null;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Split text columns into shard rows of at most `limit` bytes each (never inside a UTF-8 sequence). */
export function shardColumns(cols: Record<'core' | 'visitors' | 'cube' | 'props', string>, limit = SHARD_BYTES) {
  const shards: Record<'core' | 'visitors' | 'cube' | 'props', string>[] = [{ core: '', visitors: '', cube: '', props: '' }];
  let room = limit;
  for (const key of ['core', 'visitors', 'cube', 'props'] as const) {
    let bytes = encoder.encode(cols[key]);
    while (bytes.length > 0) {
      if (room <= 0) {
        shards.push({ core: '', visitors: '', cube: '', props: '' });
        room = limit;
      }
      let cut = Math.min(room, bytes.length);
      while (cut < bytes.length && cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
      if (cut === 0) {
        room = 0;
        continue;
      }
      shards[shards.length - 1]![key] += decoder.decode(bytes.subarray(0, cut));
      room -= cut;
      bytes = bytes.subarray(cut);
    }
  }
  return shards;
}

/**
 * Statements that store a state, conditional on the stored cursor still being
 * `expected` (null: no row yet). The first statement's `changes` says whether
 * the write won; shard rows follow only a write that won.
 */
export function writeStateStatements(
  db: D1Database,
  siteId: number,
  state: DayState,
  expected: { day: number; cur: [number, string] } | null,
  limit = SHARD_BYTES,
): D1PreparedStatement[] {
  const shards = shardColumns(encodeState(state), limit);
  if (shards.length > MAX_SHARDS) throw new Error(`day_state for site ${siteId} needs ${shards.length} shards`);
  const fmt = STATE_FMT | (shards.length << 8);
  const users = encodeUsers(state.users, state.day);
  const base = siteId * 16;
  const head = shards[0]!;
  const statements: D1PreparedStatement[] = [];
  if (expected === null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO day_state (site_id, day, cur_ts, cur_k, fmt, core, visitors, users, cube, props)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(site_id) DO NOTHING`,
        )
        .bind(base, state.day, state.cur[0], state.cur[1], fmt, head.core, head.visitors, users, head.cube, head.props),
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE day_state SET day = ?, cur_ts = ?, cur_k = ?, fmt = ?, core = ?, visitors = ?, users = ?, cube = ?, props = ?
           WHERE site_id = ? AND day = ? AND cur_ts = ? AND cur_k = ?`,
        )
        .bind(state.day, state.cur[0], state.cur[1], fmt, head.core, head.visitors, users, head.cube, head.props,
          base, expected.day, expected.cur[0], expected.cur[1]),
    );
  }
  shards.slice(1).forEach((shard, i) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO day_state (site_id, day, cur_ts, cur_k, fmt, core, visitors, users, cube, props)
           SELECT ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?
           WHERE EXISTS (SELECT 1 FROM day_state WHERE site_id = ? AND cur_ts = ? AND cur_k = ? AND fmt = ?)
           ON CONFLICT(site_id) DO UPDATE SET day = excluded.day, cur_ts = excluded.cur_ts, cur_k = excluded.cur_k,
             core = excluded.core, visitors = excluded.visitors, cube = excluded.cube, props = excluded.props`,
        )
        .bind(base + 1 + i, state.day, state.cur[0], state.cur[1], shard.core, shard.visitors, shard.cube, shard.props,
          base, state.cur[0], state.cur[1], fmt),
    );
  });
  return statements;
}

/** Store a state; false when another unit moved the cursor first (nothing is written then). */
export async function writeState(
  db: D1Database,
  siteId: number,
  state: DayState,
  expected: { day: number; cur: [number, string] } | null,
  limit = SHARD_BYTES,
): Promise<boolean> {
  const results = await db.batch(writeStateStatements(db, siteId, state, expected, limit));
  return (results[0]?.meta.changes ?? 0) > 0;
}

/* ----------------------------------------------------------------- tail --- */

/**
 * Raw rows of one site after `cursor` and no later than `until`, in (ts, k)
 * order, at most `limit`. Each hour table is a seek on its (site_id, ts, k) key.
 */
export async function seekRows(
  db: D1Database,
  siteId: number,
  cursor: [number, string],
  until: number,
  limit: number,
): Promise<{ rows: FoldRow[]; complete: boolean }> {
  const rows: FoldRow[] = [];
  if (until < cursor[0]) return { rows, complete: true };
  let hour = Math.floor(Math.max(cursor[0], 0) / 3600);
  const last = Math.floor(until / 3600);
  for (; hour <= last; hour += 1) {
    const want = limit - rows.length;
    if (want <= 0) return { rows, complete: false };
    const table = rawTable(partsForTs(hour * 3600).suffix);
    try {
      const { results } = await db
        // Ordered by the table's own columns: `k` alone would name the TEXT
        // alias in the select list, and sorting by it costs a sort pass that
        // D1 bills as a second read of every row.
        .prepare(
          `SELECT ${FOLD_COLUMNS} FROM ${table}
           WHERE site_id = ? AND ts >= ? AND ts <= ? AND (ts > ? OR k > CAST(? AS INTEGER))
           ORDER BY ${table}.ts, ${table}.k LIMIT ?`,
        )
        .bind(siteId, cursor[0], until, cursor[0], cursor[1], want + 1)
        .all<FoldRow>();
      const take = results.slice(0, want);
      rows.push(...take);
      if (results.length > want) return { rows, complete: false };
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  return { rows, complete: true };
}

/** First days for uids the state has not looked up: one json_each probe of app_users. */
export async function resolveUsers(db: D1Database, siteId: number, state: DayState, insert: boolean): Promise<D1PreparedStatement | null> {
  const pending = [...(state.fresh ?? new Map<string, string>()).entries()].filter(([key]) => (state.users.get(key) ?? 0) < 0);
  if (pending.length === 0) return null;
  const uids = pending.map(([, uid]) => uid);
  // A correlated lookup per uid: D1 bills each json_each entry and each hit.
  // `uid IN (SELECT value FROM json_each(?))` looks the same but walks the
  // site's whole app_users range (measured: 267 rows read for 100 uids among
  // 200, and it grows with the site's users, not with the question).
  const { results } = await db
    .prepare(
      `SELECT j.value AS uid, (SELECT first_day FROM app_users a WHERE a.site_id = ?1 AND a.uid = j.value) AS first_day
       FROM json_each(?2) j`,
    )
    .bind(siteId, JSON.stringify(uids))
    .all<{ uid: string; first_day: string | null }>();
  const known = new Map(results.filter((r) => r.first_day !== null).map((r) => [r.uid, r.first_day!]));
  const today = dayString(state.day);
  const fresh: string[] = [];
  for (const [key, uid] of pending) {
    const first = known.get(uid);
    if (first !== undefined && first < today) state.users.set(key, epochDayOf(first));
    else {
      state.users.set(key, state.day);
      if (first === undefined) fresh.push(uid);
    }
  }
  state.fresh = undefined;
  if (!insert || fresh.length === 0) return null;
  return db
    .prepare(
      `INSERT INTO app_users (site_id, uid, first_day)
       SELECT ?, value, ? FROM json_each(?) WHERE true ON CONFLICT(site_id, uid) DO NOTHING`,
    )
    .bind(siteId, today, JSON.stringify(fresh));
}

const epochDayOf = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/**
 * A day of a site as the fold sees it right now: the stored state if it is
 * that day's, plus the tail, folded in memory (not written). For `day` today
 * the tail runs to now; for an earlier day, to its end.
 */
export async function liveDay(db: D1Database, siteId: number, day: number, nowSeconds: number): Promise<DayState> {
  let state = await readState(db, siteId);
  // A state of an earlier day has read nothing of this one: start empty.
  if (!state || state.day !== day) state = emptyState(day);
  const until = Math.min(nowSeconds, day * 86_400 + 86_399);
  const { rows } = await seekRows(db, siteId, state.cur, until, 20_000);
  fold(state, rows);
  await resolveUsers(db, siteId, state, false);
  return state;
}

/* ---------------------------------------------------------------- units --- */

export interface UnitResult {
  site: number;
  rows: number;
  finalized: number[];
  written: boolean;
}

/** Earlier days of `day`'s Monday-based week, as one set of uid64s (≤ 6 level-0 rows). */
async function weekUsers(db: D1Database, siteId: number, day: number): Promise<Set<string>> {
  // Epoch day 0 was a Thursday: (day + 3) % 7 is days since Monday.
  const since = (day + 3) % 7;
  if (since === 0) return new Set();
  const { results } = await db
    .prepare('SELECT users FROM blocks WHERE site_id = ? AND level = 0 AND start BETWEEN ? AND ?')
    .bind(siteId, day - since, day - 1)
    .all<{ users: unknown }>();
  const set = new Set<string>();
  for (const r of results) {
    const u = decodeUserSet(r.users);
    if (u.kind === 'set') for (const id of u.ids) set.add(id);
  }
  return set;
}

/**
 * Turn a finished day's state into its level-0 block, and every higher level
 * whose period ends with it. Returns the statements to run.
 */
export async function finalizeStatements(db: D1Database, siteId: number, state: DayState): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = [];
  const built = buildDayBlock(state, await weekUsers(db, siteId, state.day));
  statements.push(blockStatement(db, siteId, 0, state.day, built));
  let core: BlockCore = JSON.parse(built.core) as BlockCore;
  let users: UserSet = decodeUserSet(built.users);
  let props = JSON.parse(built.props) as DayState['props'];
  let start = state.day;
  for (let k = 1; k <= MAX_LEVEL && (state.day + 1) % (1 << k) === 0; k += 1) {
    const half = 1 << (k - 1);
    const parent = state.day + 1 - (1 << k);
    const siblingStart = parent === start ? start + half : parent;
    const row = await db
      .prepare('SELECT core, users, props FROM blocks WHERE site_id = ? AND level = ? AND start = ?')
      .bind(siteId, k - 1, siblingStart)
      .first<{ core: string; users: unknown; props: string }>();
    const sibling = row ? (JSON.parse(row.core) as BlockCore) : undefined;
    const siblingUsers = row ? decodeUserSet(row.users) : { kind: 'set' as const, ids: [] };
    const siblingProps = row ? (JSON.parse(row.props) as DayState['props']) : {};
    const [left, right] = siblingStart < start ? [sibling, core] : [core, sibling];
    core = mergeCores(left, right, half);
    users = unionUsers([users, siblingUsers]);
    props = mergeBlockProps(props, siblingProps);
    start = parent;
    statements.push(
      blockStatement(db, siteId, k, parent, {
        core: JSON.stringify(core),
        users: encodeUserSet(users),
        props: JSON.stringify(props),
      }),
    );
  }
  clearBlockCache();
  return statements;
}

/**
 * One site's share of a fold unit: finish any earlier day still in its state
 * (refusing until the day's rows are all folded), then fold today's rows after
 * the cursor, look up new users, and store the state if the cursor is still
 * where it was read.
 */
export async function foldSite(
  db: D1Database,
  siteId: number,
  nowSeconds: number,
  budget: number,
  blocksFromDay: number,
): Promise<UnitResult> {
  const today = epochDay(nowSeconds);
  const settled = nowSeconds - SETTLE_SECONDS;
  const stored = await readState(db, siteId);
  const expected = stored ? { day: stored.day, cur: [...stored.cur] as [number, string] } : null;
  // A site's first fold starts with today (or yesterday, in the first quarter
  // hour of a day, so its last rows are not stranded), never before the cutover.
  let state = stored ?? emptyState(Math.max(blocksFromDay, nowSeconds - today * 86_400 < 900 ? today - 1 : today));
  const result: UnitResult = { site: siteId, rows: 0, finalized: [], written: false };
  const statements: D1PreparedStatement[] = [];
  let left = budget;

  while (state.day < today) {
    const end = state.day * 86_400 + 86_399;
    const { rows, complete } = await seekRows(db, siteId, state.cur, Math.min(end, settled), left);
    fold(state, rows);
    left -= rows.length;
    result.rows += rows.length;
    if (!complete || settled < end) break;
    const insert = await resolveUsers(db, siteId, state, true);
    if (insert) statements.push(insert);
    if (state.rows > 0 || state.users.size > 0) {
      statements.push(...(await finalizeStatements(db, siteId, state)));
      result.finalized.push(state.day);
    }
    // Days with no state between are days without rows; after a long outage
    // (over two days) the fold resumes with today rather than walk every hour.
    state = emptyState(today - state.day > 2 ? today : state.day + 1);
  }

  if (state.day === today && left > 0) {
    const { rows } = await seekRows(db, siteId, state.cur, settled, left);
    fold(state, rows);
    result.rows += rows.length;
  }
  const insert = await resolveUsers(db, siteId, state, true);
  if (insert) statements.push(insert);

  const changed = result.rows > 0 || result.finalized.length > 0 || !stored;
  if (!changed) return result;
  // The state write goes first: when it loses the race nothing else in the
  // batch should land. D1 runs a batch as one transaction, so the blocks and
  // users below are written only alongside a state write that won... except
  // that a lost conditional UPDATE is not an error. They are idempotent
  // (built from the same rows), so landing them anyway is harmless.
  const stateStatements = writeStateStatements(db, siteId, state, expected);
  const results = await db.batch([...stateStatements, ...statements]);
  result.written = (results[0]?.meta.changes ?? 0) > 0;
  return result;
}

/** A unit: sites folded one after another within one 300-row budget. */
export async function foldUnit(db: D1Database, sites: number[], nowSeconds: number, blocksFromDay: number): Promise<UnitResult[]> {
  const out: UnitResult[] = [];
  let left = UNIT_ROWS;
  for (const site of sites) {
    if (left <= 0) break;
    const r = await foldSite(db, site, nowSeconds, left, blocksFromDay);
    left -= r.rows;
    out.push(r);
  }
  return out;
}

export { dayString, epochDay };
export const blocksFromDayNumber = (day: string | null): number => (day ? epochDayOf(day) : Number.POSITIVE_INFINITY);
