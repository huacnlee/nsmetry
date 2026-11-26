/**
 * Regressions from review: rollups racing each other, today against yesterday,
 * the window between midnight and the nightly rollup, event users summed from
 * hours, and filters over windows too long to read affordably.
 */
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEvents } from '../src/app-analytics';
import { ensureSchema, listRawTables } from '../src/db';
import { handleIngest } from '../src/ingest';
import { ReportError, summaryReport } from '../src/reports';
import { catchUpToday, dailyJob, hourlyJob } from '../src/rollup';

const db = env.DB;
const workerEnv = env as unknown as Env;
const site = { id: 1, domain: 'web.example', created_at: 0 };
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

/** One pageview (or a custom event when `name` is given) from one visitor. */
const send = (path: string, name?: string) =>
  handleIngest(
    new Request('https://a.example.com/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA, 'cf-connecting-ip': '198.51.100.7' },
      body: JSON.stringify({ site: 'web.example', url: `https://web.example${path}`, ...(name ? { name } : {}) }),
      cf: { country: 'US' },
    } as RequestInit),
    workerEnv,
  );

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-03-08T00:30:00Z');
  await ensureSchema(db);
  for (const t of await listRawTables(db)) await db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  for (const t of ['stats_hourly', 'stats_daily', 'stats_cube', 'stats_cube2', 'today_visits', 'app_daily', 'app_users', 'sites', 'settings']) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  await db.prepare("INSERT INTO sites (id, domain, created_at) VALUES (1, 'web.example', 0)").run();
});
afterEach(() => vi.useRealTimers());

describe('rollups', () => {
  it('lets two dashboard reads and the cron fold the same hour at once', async () => {
    at('2026-03-09T01:10:00Z');
    await send('/a');
    at('2026-03-09T02:01:00Z');
    const now = new Date();
    const results = await Promise.allSettled([catchUpToday(db, now), catchUpToday(db, now), hourlyJob(db, now)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    const week = await summaryReport(db, site, { range: '7d' }, new Date());
    expect(week.totals.views).toBe(1);
  });

  it('compares today with all of yesterday, one visitor counted once', async () => {
    for (const h of ['01', '05', '20']) {
      at(`2026-03-09T${h}:10:00Z`);
      await send('/a');
      await hourlyJob(db, new Date(`2026-03-09T${h}:59:00Z`));
    }
    at('2026-03-10T00:20:00Z');
    await dailyJob(db, new Date(), 7);
    for (const h of ['01', '05']) {
      at(`2026-03-10T${h}:10:00Z`);
      await send('/a');
    }
    at('2026-03-10T06:00:00Z');
    const today = await summaryReport(db, site, { range: 'today', compare: true }, new Date());
    expect(today.previous?.visitors).toBe(1);
    expect(today.previous?.views).toBe(3);
  });

  it('shows yesterday after the 00:05 cron, before anyone opens the dashboard', async () => {
    at('2026-03-09T10:10:00Z');
    await send('/a');
    at('2026-03-10T00:10:00Z');
    await hourlyJob(db, new Date('2026-03-10T00:05:00Z'));
    const week = await summaryReport(db, site, { range: '7d' }, new Date());
    expect(week.totals.views).toBe(1);
  });

  it("counts an event's users once a day, not once per hour", async () => {
    for (const h of ['02', '09', '17']) {
      at(`2026-03-09T${h}:10:00Z`);
      await send('/a', 'signup_click');
      await hourlyJob(db, new Date(`2026-03-09T${h}:59:00Z`));
    }
    at('2026-03-10T00:20:00Z');
    await dailyJob(db, new Date(), 7);
    const { events } = await loadEvents(db, 1, { from: '2026-03-09', to: '2026-03-09' }, [], new Date());
    expect(events).toEqual([{ name: 'signup_click', count: 3, users: 1 }]);
  });

  it('refuses a filter over more than 31 days, and allows it over 30', async () => {
    at('2026-03-10T06:00:00Z');
    const long = summaryReport(db, site, { range: '90d', f: 'country:US' }, new Date());
    await expect(long).rejects.toBeInstanceOf(ReportError);
    await expect(long).rejects.toMatchObject({ status: 400 });
    const month = await summaryReport(db, site, { range: '30d', f: 'country:US' }, new Date());
    expect(month.totals.views).toBe(0);
  });
});
