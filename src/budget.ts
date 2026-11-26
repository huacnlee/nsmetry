/**
 * The Cloudflare free plan's daily limits, and the share of them this project
 * designs for.
 *
 * NsMetry promises that a fleet of up to a hundred sites and apps runs on one
 * free account. These are the three limits that promise is measured against;
 * everything else on the free plan (CPU time, storage, KV, cron count) is far
 * from binding at this scale. The limits reset at 00:00 UTC, which is also why
 * every "day" in this codebase is a UTC day.
 *
 * TARGET is half of each limit. The other half is headroom — for a launch day,
 * a crawler that gets past the bot filter, a second person watching the
 * realtime panel, or a mistake in an estimate — so that crossing the target is
 * a warning, never an outage. test/budget.test.ts simulates a realistic day
 * for a full fleet and fails if any of the three is at or over TARGET.
 *
 * Never raise TARGET to make that test pass: the test exists precisely to stop
 * a change that makes the fleet more expensive from shipping quietly. Make the
 * change cheaper instead, and update README "How it stays free" with the new
 * per-event costs.
 */

export interface DailyUsage {
  /** Worker invocations: every HTTP request and every cron trigger. */
  requests: number;
  /** D1 rows written, as reported in each statement's `meta.rows_written`. */
  rowsWritten: number;
  /** D1 rows read, as reported in each statement's `meta.rows_read`. */
  rowsRead: number;
}

/** Workers Free and D1 Free, per day (developers.cloudflare.com, "Limits"). */
export const FREE_PLAN: Readonly<DailyUsage> = Object.freeze({
  requests: 100_000,
  rowsWritten: 100_000,
  rowsRead: 5_000_000,
});

/** What a full fleet's day is designed to stay under: half of every limit. */
export const TARGET: Readonly<DailyUsage> = Object.freeze({
  requests: FREE_PLAN.requests / 2,
  rowsWritten: FREE_PLAN.rowsWritten / 2,
  rowsRead: FREE_PLAN.rowsRead / 2,
});

/** The fleet the budget is sized for. */
export const MAX_SITES = 100;

/** Each limit's usage as a fraction of TARGET (1 = exactly at target). */
export function shareOfTarget(usage: DailyUsage): DailyUsage {
  return {
    requests: usage.requests / TARGET.requests,
    rowsWritten: usage.rowsWritten / TARGET.rowsWritten,
    rowsRead: usage.rowsRead / TARGET.rowsRead,
  };
}

/** The limits a day's usage reaches or crosses TARGET on, by name. */
export function overTarget(usage: DailyUsage): (keyof DailyUsage)[] {
  return (Object.keys(TARGET) as (keyof DailyUsage)[]).filter((key) => usage[key] >= TARGET[key]);
}

/**
 * What the design itself aims for, well inside TARGET: the day_state + dyadic
 * blocks design (src/fold.ts, src/blocks.ts, src/state.ts) is sized to these,
 * and test/budget.test.ts holds a full fleet's day to them as well as to
 * TARGET. Crossing one is a regression in the design, not yet a risk to the
 * free plan — but it is the early warning, so do not raise these either.
 */
export const DESIGN_CAPS: Readonly<DailyUsage> = Object.freeze({
  requests: 40_000,
  rowsWritten: 40_000,
  rowsRead: 300_000,
});

/** The limits a day's usage reaches or crosses DESIGN_CAPS on, by name. */
export function overDesignCaps(usage: DailyUsage): (keyof DailyUsage)[] {
  return (Object.keys(DESIGN_CAPS) as (keyof DailyUsage)[]).filter((key) => usage[key] > DESIGN_CAPS[key]);
}
