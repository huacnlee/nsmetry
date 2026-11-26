import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SETTING_BLOCKS_FROM, createRawTableSql, ensureSchema, rawTable } from '../src/db';
import { loadRankings, loadTotals } from '../src/query';
import { loadEvents } from '../src/app-analytics';
import { clearTodayMemo } from '../src/reads';
import { foldUnit, resetBlocksFromCache } from '../src/state';
import { rollupDay } from '../src/rollup';
import { clearBlockCache } from '../src/blocks';
import { partsForTs } from '../src/time';
import {
  type DayState,
  type FoldRow,
  cloneState,
  decodeState,
  emptyState,
  encodeState,
  encodeUsers,
  fold,
} from '../src/fold';
import { buildDayBlock, decodeUserSet, dyadicCover, mergeCores, type BlockCore } from '../src/blocks';
import { readState, shardColumns, writeState } from '../src/state';

const DAY = 20_522; // 2026-03-10
const START = DAY * 86_400;

/** A small deterministic PRNG, so a failure names its seed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

function makeRows(seed: number, count: number): FoldRow[] {
  const r = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const rows: FoldRow[] = [];
  let ts = START + 30;
  for (let i = 0; i < count; i += 1) {
    ts += Math.floor(r() * 400);
    const visitor = `v${Math.floor(r() * 12)}`;
    const app = r() < 0.5;
    const base = {
      ts,
      k: String(Math.floor(r() * 2 ** 40) - 2 ** 39),
      visitor,
      uid: app && r() < 0.8 ? `${visitor.padEnd(16, 'a')}0123456789ab`.replace(/v/g, 'c') : '',
      ref: pick(['', 'google.com', 'news.ycombinator.com']),
      country: pick(['US', 'DE', 'JP']),
      browser: pick(['Chrome', 'Safari']),
      os: pick(['macOS', 'iOS']),
      device: pick(['desktop', 'mobile']),
      screen: '',
      utm_source: pick(['', 'mail']),
      utm_medium: '',
      utm_campaign: '',
      app_version: app ? pick(['2.3.1', '2.4.0']) : '',
      props: '',
      batch: '',
    };
    if (app) {
      const events = Array.from({ length: 1 + Math.floor(r() * 4) }, () => {
        const name = pick(['pageview', 'pageview', 'purchase', 'signup']);
        const t = ts - Math.floor(r() * 60);
        return name === 'pageview'
          ? [t, name, pick(['/home', '/settings', '/feed'])]
          : [t, name, pick(['/home', '/feed']), { plan: pick(['pro', 'free']), n: Math.floor(r() * 3) }];
      });
      rows.push({ ...base, name: '', path: '', batch: JSON.stringify(events) });
    } else {
      const name = r() < 0.85 ? 'pageview' : 'download';
      rows.push({ ...base, name, path: pick(['/', '/docs', '/pricing']), props: name === 'download' ? '{"file":"a.zip"}' : '' });
    }
  }
  return rows;
}

const snapshot = (s: DayState) => ({ ...encodeState(s), cur: s.cur, rows: s.rows, users: [...encodeUsers(s.users, s.day)] });

describe('fold', () => {
  it('is the same whether the rows come in one unit or two, for every split', () => {
    for (const seed of [1, 7, 42]) {
      const rows = makeRows(seed, 60);
      const whole = snapshot(fold(emptyState(DAY), rows));
      for (let cut = 0; cut <= rows.length; cut += 1) {
        const first = fold(emptyState(DAY), rows.slice(0, cut));
        // Through storage in between, as the cron does it.
        const stored = encodeState(first);
        const reread = decodeState(first.day, first.cur, stored, encodeUsers(first.users, first.day));
        expect(snapshot(fold(reread, rows.slice(cut))), `seed ${seed} cut ${cut}`).toEqual(whole);
      }
    }
  });

  it('counts visits, bounces, entry and exit like the rollups did', () => {
    const row = (ts: number, visitor: string, path: string, name = 'pageview'): FoldRow => ({
      ts, k: String(ts), visitor, uid: '', name, path, ref: '', country: 'US', browser: '', os: '', device: '', screen: '',
      utm_source: '', utm_medium: '', utm_campaign: '', app_version: '', props: '', batch: '',
    });
    const s = fold(emptyState(DAY), [
      row(START + 100, 'a', '/'),
      row(START + 200, 'b', '/x'),
      row(START + 4000, 'a', '/y'),
      row(START + 4100, 'c', '/', 'download'),
    ]);
    expect(s.core.t).toEqual([3, 2, 1, 3900, 1]);
    expect(s.core.d.entry).toEqual({ '/': [1, 1], '/x': [1, 1] });
    expect(s.core.d.exit).toEqual({ '/y': [1, 1], '/x': [1, 1], '/': [0, 0] });
    expect(s.core.d.path!['/']).toEqual([1, 1]);
    expect(s.core.e.download![0]).toBe(1);
    expect(s.core.e.download![3]).toBe(1);
  });

  it('leaves a cloned state untouched when the clone is folded further', () => {
    const rows = makeRows(3, 30);
    const s = fold(emptyState(DAY), rows.slice(0, 15));
    const before = snapshot(s);
    fold(cloneState(s), rows.slice(15));
    expect(snapshot(s)).toEqual(before);
  });
});

describe('blocks', () => {
  it('covers a range with dyadic blocks and nothing twice', () => {
    for (const [from, to] of [[DAY - 364, DAY - 1], [DAY - 29, DAY - 1], [5, 5], [DAY - 1000, DAY]]) {
      const cover = dyadicCover(from!, to!);
      let next = from!;
      for (const c of cover) {
        expect(c.start).toBe(next);
        expect(c.start % (1 << c.level)).toBe(0);
        next += 1 << c.level;
      }
      expect(next).toBe(to! + 1);
      expect(cover.length).toBeLessThanOrEqual(2 * 10);
    }
  });

  it('merges two days into a parent whose vectors are the days side by side', () => {
    const a = JSON.parse(buildDayBlock(fold(emptyState(DAY - 1), makeRows(5, 20).map((r) => ({ ...r, ts: r.ts - 86_400 }))), new Set()).core) as BlockCore;
    const b = JSON.parse(buildDayBlock(fold(emptyState(DAY), makeRows(6, 20)), new Set()).core) as BlockCore;
    const parent = mergeCores(a, b, 1);
    expect(parent.v.views).toEqual([a.v.views[0], b.v.views[0]]);
    const views = (c: BlockCore) => (c.d.path ?? []).reduce((n, r) => n + r[1], 0);
    expect(views(parent)).toBe(views(a) + views(b));
  });

  it('keeps the users of a day as a sorted set', () => {
    const s = fold(emptyState(DAY), makeRows(9, 40));
    const users = decodeUserSet(buildDayBlock(s, new Set()).users);
    expect(users.kind).toBe('set');
    if (users.kind === 'set') expect(users.ids).toEqual([...s.users.keys()].sort());
  });
});

describe('day_state storage', () => {
  beforeAll(async () => {
    await ensureSchema(env.DB);
  });

  it('shards a state above the size limit and reads it back whole', async () => {
    const s = fold(emptyState(DAY), makeRows(11, 80));
    const cols = encodeState(s);
    const limit = Math.ceil(Object.values(cols).reduce((n, c) => n + c.length, 0) / 4);
    expect(shardColumns(cols, limit).length).toBeGreaterThan(2);
    expect(await writeState(env.DB, 3, s, null, limit)).toBe(true);
    const back = await readState(env.DB, 3);
    expect(back && snapshot(back)).toEqual(snapshot(s));
    // A writer holding an old cursor loses, and changes nothing.
    const moved = fold(cloneState(s), makeRows(12, 5).map((r) => ({ ...r, ts: r.ts + 80_000 })));
    expect(await writeState(env.DB, 3, moved, { day: DAY, cur: [1, '1'] }, limit)).toBe(false);
    expect(snapshot((await readState(env.DB, 3))!)).toEqual(snapshot(s));
  });
});

describe('the fold path answers what the older path answered', () => {
  // 15:30 on a day of its own, so nothing else in this file shares its tables.
  const day = 20_600;
  const now = new Date((day * 86_400 + 15.5 * 3600) * 1000);
  const site = 77;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    await ensureSchema(env.DB);
    const r = prng(99);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    for (let i = 0; i < 160; i += 1) {
      const ts = day * 86_400 + Math.floor(r() * 15 * 3600);
      const table = rawTable(partsForTs(ts).suffix);
      await env.DB.prepare(createRawTableSql(table)).run();
      const name = r() < 0.8 ? 'pageview' : 'signup';
      await env.DB.prepare(
        `INSERT INTO ${table} (site_id, ts, visitor, name, path, ref, country, browser, os, device, screen, utm_source, utm_medium, utm_campaign, props)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Chrome', 'macOS', 'desktop', '', '', '', '', ?)`,
      )
        .bind(site, ts, `v${Math.floor(r() * 25)}`, name, pick(['/', '/a', '/b']), pick(['', 'google.com']), pick(['US', 'DE']), name === 'signup' ? '{"plan":"pro"}' : '')
        .run();
    }
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  async function answers() {
    const range = { from: '2026-05-27', to: '2026-05-27' };
    const totals = await loadTotals(env.DB, site, range.from, range.to, [], now);
    const filtered = await loadTotals(env.DB, site, range.from, range.to, [{ dim: 'country', value: 'US' }], now);
    const { breakdowns } = await loadRankings(env.DB, site, range, [], ['path', 'entry', 'exit', 'country', 'referrer'], 10, now);
    const events = await loadEvents(env.DB, site, range, [], now);
    const sorted = Object.fromEntries(
      Object.entries(breakdowns).map(([dim, rows]) => [dim, [...rows].sort((a, b) => a.name.localeCompare(b.name))]),
    );
    return { totals, filtered, sorted, events };
  }

  it('for today: totals, a filter, rankings and events', async () => {
    expect(new Date(day * 86_400_000).toISOString().slice(0, 10)).toBe('2026-05-27');
    // The fold path first: the older one renames the hours it folds.
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(SETTING_BLOCKS_FROM, '2026-05-27')
      .run();
    resetBlocksFromCache();
    clearTodayMemo();
    const fresh = await answers();
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(SETTING_BLOCKS_FROM).run();
    resetBlocksFromCache();
    const legacy = await answers();
    expect(fresh.totals).toEqual(legacy.totals);
    expect(fresh.filtered).toEqual(legacy.filtered);
    expect(fresh.sorted).toEqual(legacy.sorted);
    expect(fresh.events).toEqual(legacy.events);
  });
});

describe('a finished day from its blocks answers what its rollups answered', () => {
  const day = 20_602; // 2026-05-29
  const site = 78;
  const label = '2026-05-29';

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await ensureSchema(env.DB);
    const r = prng(1234);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    for (let i = 0; i < 200; i += 1) {
      const ts = day * 86_400 + Math.floor(r() * 86_000);
      const table = rawTable(partsForTs(ts).suffix);
      await env.DB.prepare(createRawTableSql(table)).run();
      const visitor = `w${Math.floor(r() * 30)}`;
      await env.DB.prepare(
        `INSERT INTO ${table} (site_id, ts, visitor, name, path, ref, country, browser, os, device, screen, utm_source, utm_medium, utm_campaign)
         VALUES (?, ?, ?, 'pageview', ?, ?, ?, 'Firefox', 'Linux', 'desktop', '', '', '', '')`,
      )
        .bind(site, ts, visitor, pick(['/', '/x', '/y', '/z']), pick(['', 'example.org']), visitor < 'w2' ? 'FR' : 'JP')
        .run();
    }
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  async function answers(now: Date) {
    const totals = await loadTotals(env.DB, site, label, label, [], now);
    const { breakdowns } = await loadRankings(env.DB, site, { from: label, to: label }, [], ['path', 'entry', 'exit', 'country', 'referrer'], 10, now);
    return {
      totals,
      sorted: Object.fromEntries(Object.entries(breakdowns).map(([dim, rows]) => [dim, [...rows].sort((a, b) => a.name.localeCompare(b.name))])),
    };
  }

  it('totals and rankings', async () => {
    const after = new Date(((day + 1) * 86_400 + 600) * 1000);
    vi.setSystemTime(after);
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(SETTING_BLOCKS_FROM, label)
      .run();
    resetBlocksFromCache();
    clearBlockCache();
    clearTodayMemo();
    // The fold's first run after midnight folds the day and writes its block.
    const results = await foldUnit(env.DB, [site], Math.floor(after.getTime() / 1000), day);
    expect(results[0]!.finalized).toEqual([day]);
    vi.setSystemTime(new Date(((day + 1) * 86_400 + 7200) * 1000));
    const fresh = await answers(new Date());
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(SETTING_BLOCKS_FROM).run();
    resetBlocksFromCache();
    await rollupDay(env.DB, label, true);
    const legacy = await answers(new Date());
    expect(fresh.totals).toEqual(legacy.totals);
    // Pageviews per value match. The older daily rollup's per-value "visits"
    // were its own (summed over hours, a visitor in three hours counted three
    // times, none for "Direct / none"); the blocks keep today's meaning —
    // distinct visitors of a path, visits by their entry for profile values.
    const values = (x: typeof fresh.sorted) =>
      Object.fromEntries(Object.entries(x).map(([dim, rows]) => [dim, rows.map((r) => [r.name, r.value])]));
    expect(values(fresh.sorted)).toEqual(values(legacy.sorted));
    const countryVisits = fresh.sorted.country!.reduce((n, r) => n + r.visits, 0);
    expect(countryVisits).toBe(fresh.totals.visits);
    expect(fresh.totals.visits).toBe(legacy.totals.visits);
  });
});
