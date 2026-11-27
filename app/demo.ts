/**
 * The demo server: an NsMetry instance that lives on the device.
 *
 * Entering "demo" as the server, pressing "Try the demo" on the sign-in screen, or opening the web
 * build with `?demo` (the GitHub Pages demo does) routes every API request through `demoTransport`
 * instead of the network. It answers the whole of docs/api.md from synthetic data, so the app runs
 * end to end — sign-in, every screen, filters, ranges, comparison, Team and Agents — with nothing
 * leaving the device. That serves the public demo, screenshots and store review alike.
 *
 * The data is generated per request rather than stored:
 *  - No baked-in dates: everything is an offset from now (UTC), so the demo is always "the last year
 *    ending today" and never goes stale.
 *  - Seeded: the same site, day and dimension always give the same number, so two people (and two
 *    screenshots) see the same demo, and a figure does not change when the screen reloads it.
 *  - Filters, ranges and comparison all change the answer: a filter scales the totals by its value's
 *    share, and the filtered dimension's own breakdown shows only that value — the same semantics as
 *    the real server, at the precision of a demo.
 *
 * Writes (adding a site, inviting a person, disconnecting an agent) change in-memory state for the
 * run, so the admin screens can be tried; nothing persists.
 */
import { WORLD_GEOMETRY } from "../src/world";
import type { Dim, Filter, Metric, PublicUser, RangeId, Row, Site, TransportRequest, TransportResponse, Transport } from "./api";

/** `normalizeServer("demo")`: the address that selects the demo. */
export const DEMO_SERVER = "https://demo";
export const DEMO_EMAIL = "demo@nsmetry.dev";
/** Any code works in the demo; this is the one the sign-in screen fills in. */
export const DEMO_CODE = "DEMO2026";

/** True for the demo server, however it was typed ("demo", "https://demo", "http://demo/"). */
export const isDemoServer = (url: string) => /^(https?:\/\/)?demo\/?$/i.test(url.trim());

// ------------------------------------------------------------------------------------- seeded noise

/** A deterministic 0..1 from any key: the same key, the same number, on every device. */
function noise(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------------------------- dates (UTC)

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const msOf = (day: string) => Date.parse(`${day}T00:00:00Z`);
const shift = (day: string, n: number) => dayOf(msOf(day) + n * DAY_MS);
function weekStart(day: string) {
  const d = new Date(msOf(day));
  return shift(day, -((d.getUTCDay() + 6) % 7));
}

const PRESETS: Record<RangeId, { days: number; granularity: "hour" | "day" | "week" | "month"; prevLabel: string }> = {
  today: { days: 1, granularity: "hour", prevLabel: "yesterday" },
  "7d": { days: 7, granularity: "day", prevLabel: "previous 7 days" },
  "30d": { days: 30, granularity: "day", prevLabel: "previous 30 days" },
  "90d": { days: 90, granularity: "week", prevLabel: "previous 90 days" },
  "12mo": { days: 365, granularity: "month", prevLabel: "previous year" },
};

interface Window {
  id: RangeId;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  granularity: "hour" | "day" | "week" | "month";
  prevLabel: string;
}

function windowFor(rangeId: string | null, now: number): Window | null {
  const id = (rangeId ?? "30d") as RangeId;
  const p = PRESETS[id];
  if (!p) return null;
  const today = dayOf(now);
  const from = shift(today, -(p.days - 1));
  return { id, from, to: today, prevFrom: shift(from, -p.days), prevTo: shift(from, -1), granularity: p.granularity, prevLabel: p.prevLabel };
}

/** The labels the real server uses for a window (src/query.ts, labelsFor). */
function labelsFor(w: { from: string; to: string; granularity: Window["granularity"] }, now: number): string[] {
  if (w.granularity === "hour") {
    const last = w.from === dayOf(now) ? new Date(now).getUTCHours() : 23;
    return Array.from({ length: last + 1 }, (_, h) => `${w.from}T${String(h).padStart(2, "0")}`);
  }
  const out: string[] = [];
  for (let d = w.from; d <= w.to; d = shift(d, 1)) {
    const l = w.granularity === "week" ? weekStart(d) : w.granularity === "month" ? d.slice(0, 7) : d;
    if (out[out.length - 1] !== l) out.push(l);
  }
  return out;
}

// ------------------------------------------------------------------------------------- the fleet

interface Profile {
  /** Visitors (users, for an app) on an ordinary weekday. */
  base: number;
  app: boolean;
  /** Weighted values per dimension. */
  dims: Partial<Record<Dim, [string, number][]>>;
  /** Custom events: name, events per visitor, and their properties. */
  events: [string, number, Record<string, [string, number][]>][];
  views: number;
  bounce: number;
  time: number;
}

const COUNTRIES: [string, number][] = [
  ["US", 30], ["DE", 12], ["GB", 9], ["JP", 8], ["CN", 7], ["FR", 6], ["CA", 5], ["IN", 5], ["BR", 4], ["NL", 3],
  ["AU", 3], ["SE", 2], ["KR", 2], ["SG", 2], ["ES", 2],
];
const APP_TECH: Partial<Record<Dim, [string, number][]>> = {
  browser: [["App", 100]],
  os: [["macOS", 46], ["Windows", 27], ["iOS", 12], ["Linux", 9], ["Android", 6]],
  device: [["desktop", 82], ["mobile", 15], ["tablet", 3]],
  screen: [["1280+", 70], ["1024–1279", 12], ["< 768", 18]],
  referrer: [["", 100]],
};
const WEB_TECH: Partial<Record<Dim, [string, number][]>> = {
  browser: [["Chrome", 52], ["Safari", 24], ["Firefox", 9], ["Edge", 8], ["Samsung Internet", 3], ["Opera", 2]],
  os: [["macOS", 33], ["Windows", 28], ["iOS", 20], ["Android", 12], ["Linux", 7]],
  device: [["desktop", 64], ["mobile", 32], ["tablet", 4]],
  screen: [["1280+", 58], ["1024–1279", 9], ["768–1023", 5], ["< 768", 28]],
};

const PROFILES: Record<string, Profile> = {
  disktree: {
    base: 640, app: true, views: 4.1, bounce: 12, time: 412,
    dims: {
      ...APP_TECH,
      path: [["Scan", 40], ["Results", 26], ["Treemap", 14], ["Cleanup", 9], ["Settings", 6], ["Upgrade", 3], ["About", 2]],
      entry: [["Scan", 82], ["Results", 12], ["Settings", 6]],
      exit: [["Results", 38], ["Cleanup", 27], ["Treemap", 21], ["Scan", 14]],
      app_version: [["2.4.1", 61], ["2.4.0", 24], ["2.3.7", 11], ["2.2.0", 4]],
      country: COUNTRIES,
    },
    events: [
      ["scan_finished", 1.6, { volume: [["Macintosh HD", 62], ["External", 28], ["Network", 10]], duration_bucket: [["< 10 s", 41], ["10–60 s", 44], ["> 60 s", 15]] }],
      ["files_deleted", 0.7, { kind: [["caches", 46], ["downloads", 31], ["logs", 13], ["other", 10]] }],
      ["upgrade_clicked", 0.08, { from: [["treemap", 44], ["cleanup", 38], ["settings", 18]] }],
      ["purchase", 0.03, { plan: [["lifetime", 58], ["yearly", 42]] }],
    ],
  },
  "disktree.app": {
    base: 1850, app: false, views: 2.3, bounce: 47, time: 96,
    dims: {
      ...WEB_TECH,
      path: [["/", 45], ["/download", 21], ["/pricing", 12], ["/docs", 9], ["/docs/cleanup", 5], ["/blog/2-4", 5], ["/changelog", 3]],
      entry: [["/", 61], ["/blog/2-4", 14], ["/docs", 11], ["/pricing", 8], ["/download", 6]],
      exit: [["/download", 34], ["/", 30], ["/pricing", 18], ["/docs", 18]],
      referrer: [["", 38], ["google.com", 24], ["news.ycombinator.com", 11], ["github.com", 8], ["reddit.com", 7], ["x.com", 5], ["duckduckgo.com", 4], ["producthunt.com", 3]],
      utm_source: [["newsletter", 55], ["producthunt", 30], ["mastodon", 15]],
      utm_medium: [["email", 55], ["social", 45]],
      utm_campaign: [["v2-4-launch", 70], ["black-friday", 30]],
      country: COUNTRIES,
    },
    events: [
      ["download", 0.21, { platform: [["macOS", 64], ["Windows", 30], ["Linux", 6]] }],
      ["outbound_link", 0.05, { host: [["github.com", 70], ["apps.apple.com", 30]] }],
    ],
  },
  omasend: {
    base: 260, app: true, views: 6.2, bounce: 8, time: 640,
    dims: {
      ...APP_TECH,
      os: [["iOS", 52], ["Android", 31], ["macOS", 17]],
      device: [["mobile", 78], ["desktop", 17], ["tablet", 5]],
      screen: [["< 768", 79], ["768–1023", 5], ["1280+", 16]],
      path: [["Inbox", 46], ["Compose", 18], ["Thread", 17], ["Contacts", 9], ["Settings", 6], ["Onboarding", 4]],
      entry: [["Inbox", 88], ["Onboarding", 12]],
      exit: [["Inbox", 51], ["Thread", 27], ["Compose", 22]],
      app_version: [["1.8.0", 58], ["1.7.3", 33], ["1.6.9", 9]],
      country: [["JP", 21], ["US", 19], ["DE", 12], ["TW", 9], ["HK", 8], ["SG", 7], ["GB", 6], ["KR", 5], ["CN", 5], ["FR", 4]],
    },
    events: [
      ["message_sent", 3.4, { attachment: [["none", 71], ["image", 21], ["file", 8]] }],
      ["contact_added", 0.3, { source: [["share sheet", 52], ["manual", 34], ["import", 14]] }],
      ["onboarding_done", 0.04, { step_count: [["3", 70], ["4", 30]] }],
    ],
  },
  nsvim: {
    base: 95, app: true, views: 2.6, bounce: 21, time: 1310,
    dims: {
      ...APP_TECH,
      os: [["macOS", 58], ["Linux", 33], ["Windows", 9]],
      path: [["Editor", 64], ["File finder", 18], ["Command palette", 12], ["Settings", 6]],
      entry: [["Editor", 100]],
      exit: [["Editor", 100]],
      app_version: [["0.9.2", 74], ["0.9.1", 26]],
      country: COUNTRIES,
    },
    events: [["plugin_installed", 0.12, { plugin: [["lsp", 48], ["git", 31], ["copilot", 21]] }]],
  },
  "spotish.app": {
    base: 720, app: false, views: 1.8, bounce: 58, time: 64,
    dims: {
      ...WEB_TECH,
      path: [["/", 58], ["/features", 17], ["/download", 15], ["/privacy", 6], ["/support", 4]],
      entry: [["/", 74], ["/features", 14], ["/download", 12]],
      exit: [["/", 46], ["/download", 39], ["/features", 15]],
      referrer: [["", 44], ["google.com", 31], ["apps.apple.com", 12], ["reddit.com", 8], ["bing.com", 5]],
      utm_source: [["appstore", 100]],
      utm_medium: [["referral", 100]],
      utm_campaign: [["spring", 100]],
      country: COUNTRIES,
    },
    events: [["download", 0.18, { platform: [["iOS", 61], ["macOS", 39]] }]],
  },
};

// ------------------------------------------------------------------------------------- the numbers

/** How busy one day is: weekday rhythm, a year of slow growth, and day-to-day noise. */
function dayFactor(site: string, day: string, app: boolean, now: number): number {
  const weekday = new Date(msOf(day)).getUTCDay();
  const weekly = app ? [0.78, 1.04, 1.08, 1.07, 1.05, 0.98, 0.8][weekday]! : [0.66, 1.06, 1.12, 1.1, 1.07, 0.96, 0.7][weekday]!;
  const age = (now - msOf(day)) / DAY_MS;
  const growth = 1 / (1 + age / 420);
  // An occasional spike, the kind a launch or a newsletter makes.
  const spike = noise(`${site}:spike:${day}`) > 0.975 ? 1.9 : 1;
  return weekly * growth * spike * (0.86 + noise(`${site}:${day}`) * 0.28);
}

/** The share of one hour in a day (UTC), for the hourly series. */
function hourShare(site: string, hour: number): number {
  const curve = [2, 1.5, 1.2, 1, 1.2, 1.8, 2.6, 3.6, 4.6, 5.4, 5.8, 5.9, 5.7, 5.8, 6, 6.1, 6, 5.6, 5.1, 4.6, 4.1, 3.6, 3, 2.4];
  return (curve[hour]! * (0.85 + noise(`${site}:h${hour}`) * 0.3)) / 97;
}

function share(list: [string, number][] | undefined, value: string): number {
  if (!list) return 0.05;
  const total = list.reduce((s, [, w]) => s + w, 0);
  const hit = list.find(([name]) => name === value);
  return hit ? hit[1] / total : 0.01;
}

/** How much of the traffic a filter stack keeps. */
function filterFactor(p: Profile, filters: readonly Filter[]): number {
  return filters.reduce((f, x) => f * share(p.dims[x.dim], x.value), 1);
}

interface Totals {
  visitors: number;
  views: number;
  visits: number;
  bounces: number;
  duration: number;
}

/** Visitors and the rest for one day, or for the elapsed share of today. */
function dayTotals(site: string, p: Profile, day: string, factor: number, now: number, hours?: number): Totals {
  const today = dayOf(now);
  let part = 1;
  if (day === today) {
    const h = new Date(now).getUTCHours();
    part = 0;
    for (let i = 0; i <= h; i++) part += hourShare(site, i);
  }
  if (hours !== undefined) part = hourShare(site, hours);
  const visitors = p.base * dayFactor(site, day, p.app, now) * factor * part;
  const vpv = p.views * (0.9 + noise(`${site}:vpv:${day}`) * 0.2);
  const bounce = Math.min(95, p.bounce * (0.85 + noise(`${site}:b:${day}`) * 0.3));
  const time = p.time * (0.85 + noise(`${site}:t:${day}`) * 0.3);
  const visits = visitors * 1.15;
  return { visitors, views: visits * vpv, visits, bounces: (visits * bounce) / 100, duration: visits * time };
}

function metrics(t: Totals): Record<Metric, number> {
  return {
    visitors: Math.round(t.visitors),
    views: Math.round(t.views),
    vpv: t.visits ? Math.round((t.views / t.visits) * 100) / 100 : 0,
    bounce: t.visits ? Math.round((t.bounces / t.visits) * 1000) / 10 : 0,
    time: t.visits ? Math.round(t.duration / t.visits) : 0,
  };
}

const add = (a: Totals, b: Totals): Totals => ({
  visitors: a.visitors + b.visitors,
  views: a.views + b.views,
  visits: a.visits + b.visits,
  bounces: a.bounces + b.bounces,
  duration: a.duration + b.duration,
});
const ZERO: Totals = { visitors: 0, views: 0, visits: 0, bounces: 0, duration: 0 };

/** Every bucket of a window, in label order, with its totals. */
function buckets(site: string, p: Profile, w: { from: string; to: string; granularity: Window["granularity"] }, factor: number, now: number) {
  const labels = labelsFor(w, now);
  const byLabel = new Map<string, Totals>(labels.map((l) => [l, ZERO]));
  if (w.granularity === "hour") {
    labels.forEach((l, h) => byLabel.set(l, dayTotals(site, p, w.from, factor, now, h)));
  } else {
    for (let d = w.from; d <= w.to; d = shift(d, 1)) {
      if (d > dayOf(now)) break;
      const l = w.granularity === "week" ? weekStart(d) : w.granularity === "month" ? d.slice(0, 7) : d;
      byLabel.set(l, add(byLabel.get(l) ?? ZERO, dayTotals(site, p, d, factor, now)));
    }
  }
  return labels.map((label) => ({ label, totals: byLabel.get(label)! }));
}

// ------------------------------------------------------------------------------------- the server

interface State {
  sites: Site[];
  users: PublicUser[];
  grants: { id: number; client_name: string; created_at: number; last_used_at: number | null }[];
  trackerUrl: string;
  nextId: number;
}

/**
 * A demo instance. `now` is injectable so tests can pin the clock; the app uses the real one, so the
 * numbers move with the day like a live instance's would.
 */
export function createDemoServer(opts: { now?: () => number } = {}): Transport {
  const now = opts.now ?? (() => Date.now());
  const t0 = Math.floor(now() / 1000);
  const state: State = {
    sites: Object.keys(PROFILES).map((domain, i) => ({ id: i + 1, domain, created_at: t0 - (400 - i * 40) * 86400 })),
    users: [
      { id: 1, email: DEMO_EMAIL, role: "owner", created_at: t0 - 400 * 86400, siteIds: [] },
      { id: 2, email: "mia@studio.example", role: "viewer", created_at: t0 - 90 * 86400, siteIds: [1, 2] },
      { id: 3, email: "ops@omasend.example", role: "viewer", created_at: t0 - 12 * 86400, siteIds: [3] },
    ],
    grants: [
      { id: 1, client_name: "Claude Code", created_at: t0 - 20 * 86400, last_used_at: t0 - 3600 },
      { id: 2, client_name: "Cursor", created_at: t0 - 4 * 86400, last_used_at: null },
    ],
    trackerUrl: "https://stats.nsmetry.dev/script.js",
    nextId: 100,
  };
  const me = () => state.users[0]!;

  const ok = (json: unknown, status = 200): TransportResponse => ({ status, json });
  const fail = (status: number, error: string): TransportResponse => ({ status, json: { error } });

  function siteOf(q: URLSearchParams): { site: Site; p: Profile } | TransportResponse {
    const id = Number(q.get("site"));
    const site = state.sites.find((s) => s.id === id);
    if (!site) return fail(404, "site not found");
    // A site added during the demo has no history of its own: it borrows the quietest profile.
    return { site, p: PROFILES[site.domain] ?? { ...PROFILES.nsvim!, base: 4 } };
  }

  function parseFilters(raw: string | null): Filter[] {
    if (!raw) return [];
    return raw.split(",").flatMap((part) => {
      const i = part.indexOf(":");
      if (i <= 0) return [];
      const dim = part.slice(0, i) as Dim;
      // As on the server: only real columns narrow (src/dimensions.ts).
      if (dim === "event" || dim === "entry" || dim === "exit") return [];
      return [{ dim, value: decodeURIComponent(part.slice(i + 1)) }];
    });
  }

  function summary(q: URLSearchParams) {
    const found = siteOf(q);
    if ("status" in found) return found;
    const { site, p } = found;
    const w = windowFor(q.get("range"), now());
    if (!w) return fail(400, "invalid range");
    const filters = parseFilters(q.get("f"));
    const factor = filterFactor(p, filters);
    const cur = buckets(site.domain, p, w, factor, now());
    const cmp = q.get("cmp") === "1";
    const prevW = { from: w.prevFrom, to: w.prevTo, granularity: w.granularity };
    // The previous window lines up bucket for bucket with the current one.
    const prev = cmp ? buckets(site.domain, p, prevW, factor, now()).slice(0, cur.length) : null;
    const series = (list: { totals: Totals }[]) => {
      const out = { visitors: [], views: [], vpv: [], bounce: [], time: [] } as Record<Metric, number[]>;
      for (const b of list) {
        const m = metrics(b.totals);
        for (const k of Object.keys(out) as Metric[]) out[k].push(m[k]);
      }
      return out;
    };
    const sum = (list: { totals: Totals }[]) => metrics(list.reduce((a, b) => add(a, b.totals), ZERO));
    return ok({
      site,
      range: w,
      filters,
      totals: sum(cur),
      previous: prev ? sum(prev) : null,
      series: { labels: cur.map((b) => b.label), cur: series(cur), prev: prev ? series(prev) : null },
    });
  }

  function windowVisitors(site: string, p: Profile, w: Window, filters: Filter[]): number {
    return buckets(site, p, w, filterFactor(p, filters), now()).reduce((s, b) => s + b.totals.visitors, 0);
  }

  function rowsFor(site: string, p: Profile, dim: Dim, total: number, filters: Filter[], limit: number): (Row & { visits: number })[] {
    if (dim === "event") {
      return p.events
        .map(([name, rate]) => ({ name, value: Math.round(total * rate), visits: Math.round(total * Math.min(rate, 0.9) * 0.6) }))
        .filter((r) => r.value > 0)
        .slice(0, limit);
    }
    const selected = filters.find((f) => f.dim === dim);
    let list = p.dims[dim] ?? [];
    if (selected) list = list.filter(([name]) => name === selected.value);
    // Undo the filter's own factor for its dimension: its one row is the whole filtered total.
    const sumW = (p.dims[dim] ?? []).reduce((s, [, w]) => s + w, 0) || 1;
    return list
      .map(([name, weight]) => {
        const jitter = 0.92 + noise(`${site}:${dim}:${name}`) * 0.16;
        const value = selected ? total : Math.round(((total * weight) / sumW) * jitter);
        return { name, value, visits: Math.round(value * 1.1) };
      })
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  }

  function breakdown(q: URLSearchParams) {
    const found = siteOf(q);
    if ("status" in found) return found;
    const { site, p } = found;
    const w = windowFor(q.get("range"), now());
    if (!w) return fail(400, "invalid range");
    const filters = parseFilters(q.get("f"));
    const limit = Math.min(Math.max(Number(q.get("limit") ?? 10) || 10, 1), 50);
    const total = windowVisitors(site.domain, p, w, filters);
    const dims = (q.get("dim") ?? "path").split(",") as Dim[];
    const breakdowns: Partial<Record<Dim, Row[]>> = {};
    for (const dim of dims) breakdowns[dim] = rowsFor(site.domain, p, dim, total, filters, limit);
    return ok({ breakdowns });
  }

  function timeseries(q: URLSearchParams) {
    const s = summary(q);
    if (s.status !== 200) return s;
    const body = s.json as { range: Window; series: { labels: string[]; cur: Record<Metric, number[]>; prev: Record<Metric, number[]> | null } };
    const metric = (q.get("metric") ?? "visitors") as Metric;
    return ok({
      granularity: body.range.granularity,
      points: body.series.labels.map((label, i) => ({ label, cur: body.series.cur[metric]?.[i] ?? 0, prev: body.series.prev?.[metric]?.[i] ?? null })),
    });
  }

  function realtime(q: URLSearchParams) {
    const found = siteOf(q);
    if ("status" in found) return found;
    const { site, p } = found;
    const t = now();
    const minute = Math.floor(t / 60_000);
    const hour = new Date(t).getUTCHours();
    // Visitors per minute this hour, from the same day curve as the summary.
    const perMinute = (p.base * dayFactor(site.domain, dayOf(t), p.app, t) * hourShare(site.domain, hour)) / 60;
    const minutes = Array.from({ length: 30 }, (_, i) => {
      const at = minute - (29 - i);
      const cur = Math.max(0, Math.round(perMinute * p.views * (0.4 + noise(`${site.domain}:m${at}`) * 1.2)));
      return { label: `${30 - i}m`, cur };
    });
    const paths = p.dims.path ?? [["/", 1]];
    const countries = p.dims.country ?? COUNTRIES;
    const pick = (list: [string, number][], key: string) => list[Math.floor(noise(key) * Math.min(list.length, 5))]![0];
    const recent = Array.from({ length: 8 }, (_, i) => {
      const ts = Math.floor(t / 1000) - Math.floor(i * 37 + noise(`${site.domain}:r${minute}:${i}`) * 30);
      return { ts, path: pick(paths, `${site.domain}:rp${minute}:${i}`), country: pick(countries, `${site.domain}:rc${minute}:${i}`) };
    });
    const online = Math.max(1, Math.round(perMinute * 5 * (0.8 + noise(`${site.domain}:o${minute}`) * 0.4)));
    return ok({ online, minutes, recent });
  }

  // ----------------------------------------------------------------------------------- app analytics

  function activeUsers(q: URLSearchParams) {
    const found = siteOf(q);
    if ("status" in found) return found;
    const { site, p } = found;
    const w = windowFor(q.get("range"), now());
    if (!w) return fail(400, "invalid range");
    if (!p.app) return ok({ tracked: false, labels: [], dau: [], new: [], totals: { active: 0, new: 0 }, wau: 0, mau: 0 });
    const labels: string[] = [];
    const dau: number[] = [];
    const fresh: number[] = [];
    for (let d = w.from; d <= w.to; d = shift(d, 1)) {
      labels.push(d);
      const users = Math.round(dayTotals(site.domain, p, d, 1, now()).visitors);
      dau.push(users);
      fresh.push(Math.round(users * (0.06 + noise(`${site.domain}:new:${d}`) * 0.05)));
    }
    const avg = dau.reduce((s, n) => s + n, 0) / Math.max(dau.length, 1);
    const distinct = Math.round(dau.length === 1 ? dau[0]! : avg * (1 + Math.log2(dau.length) * 0.55));
    return ok({
      tracked: true,
      labels,
      dau,
      new: fresh,
      totals: { active: distinct, new: fresh.reduce((s, n) => s + n, 0) },
      wau: Math.round(avg * 2.3),
      mau: Math.round(avg * 4.6),
    });
  }

  function retention(q: URLSearchParams) {
    const found = siteOf(q);
    if ("status" in found) return found;
    const { site, p } = found;
    const cohort = q.get("cohort") ?? "day";
    if (cohort !== "day" && cohort !== "week") return fail(400, "cohort must be day or week");
    const n = Math.min(Math.max(Number(q.get("periods") ?? 8) || 8, 1), 26);
    if (!p.app) return ok({ tracked: false, cohorts: [] });
    const today = dayOf(now());
    const step = cohort === "week" ? 7 : 1;
    const current = cohort === "week" ? weekStart(today) : today;
    const cohorts = Array.from({ length: n }, (_, i) => {
      const label = shift(current, -step * (n - 1 - i));
      const size = Math.round(p.base * (cohort === "week" ? 0.55 : 0.09) * (0.85 + noise(`${site.domain}:c${label}`) * 0.3));
      const retained = Array.from({ length: n - i }, (_, k) => {
        if (k === 0) return size;
        // A steep first drop, then a slow tail — the usual shape for an app.
        const curve = (cohort === "week" ? 0.42 : 0.33) * Math.pow(k, -0.45);
        return Math.round(size * curve * (0.9 + noise(`${site.domain}:c${label}:${k}`) * 0.2));
      });
      return { label, size, retained };
    });
    return ok({ tracked: true, cohorts });
  }

  function events(q: URLSearchParams) {
    const found = siteOf(q);
    if ("status" in found) return found;
    const { site, p } = found;
    const w = windowFor(q.get("range"), now());
    if (!w) return fail(400, "invalid range");
    const total = windowVisitors(site.domain, p, w, parseFilters(q.get("f")));
    return ok({
      events: rowsFor(site.domain, p, "event", total, [], 100).map((r) => ({ name: r.name, count: r.value, users: r.visits })),
    });
  }

  function eventProperties(q: URLSearchParams) {
    const found = siteOf(q);
    if ("status" in found) return found;
    const { site, p } = found;
    const w = windowFor(q.get("range"), now());
    if (!w) return fail(400, "invalid range");
    const name = q.get("event");
    if (!name) return fail(400, "event is required");
    const ev = p.events.find(([n]) => n === name);
    if (!ev) return ok(q.get("key") ? { values: [] } : { keys: [] });
    const count = Math.round(windowVisitors(site.domain, p, w, []) * ev[1]);
    const key = q.get("key");
    if (!key) return ok({ keys: Object.keys(ev[2]).map((k) => ({ key: k, count })) });
    const values = ev[2][key] ?? [];
    const sumW = values.reduce((s, [, x]) => s + x, 0) || 1;
    const limit = Math.min(Math.max(Number(q.get("limit") ?? 10) || 10, 1), 50);
    return ok({ values: values.slice(0, limit).map(([v, x]) => ({ name: v, value: Math.round((count * x) / sumW) })) });
  }

  function eventSeries(q: URLSearchParams) {
    const found = siteOf(q);
    if ("status" in found) return found;
    const { site, p } = found;
    const w = windowFor(q.get("range"), now());
    if (!w) return fail(400, "invalid range");
    const ev = p.events.find(([n]) => n === q.get("event"));
    const rate = ev?.[1] ?? 0;
    const list = buckets(site.domain, p, w, filterFactor(p, parseFilters(q.get("f"))), now());
    return ok({
      labels: list.map((b) => b.label),
      count: list.map((b) => Math.round(b.totals.visitors * rate)),
      users: list.map((b) => Math.round(b.totals.visitors * Math.min(rate, 0.9) * 0.6)),
    });
  }

  // ----------------------------------------------------------------------------------- routing

  const withSites = (u: PublicUser): PublicUser => ({ ...u, siteIds: u.role === "owner" ? state.sites.map((s) => s.id) : u.siteIds });

  return async (req: TransportRequest): Promise<TransportResponse> => {
    const url = new URL(req.url);
    const q = url.searchParams;
    const path = url.pathname;
    const body = (req.body ? JSON.parse(req.body) : {}) as Record<string, unknown>;
    const route = `${req.method} ${path}`;

    switch (route) {
      case "POST /api/auth/start":
        if (typeof body.email !== "string" || !body.email.includes("@")) return fail(400, "a valid email is required");
        return ok({ ok: true, delivery: "email", message: "This is the demo: any code signs you in." });
      case "POST /api/auth/verify":
        return ok({ token: "demo", user: withSites(me()) });
      case "POST /api/auth/logout":
        return ok({ ok: true });
      case "GET /api/me":
        return ok({ user: withSites(me()), trackerUrl: state.trackerUrl, version: "demo", update: null });
      case "PUT /api/settings/tracker-url":
        state.trackerUrl = String(body.url ?? "");
        return ok({ trackerUrl: state.trackerUrl });
      case "GET /api/sites":
        return ok({ sites: state.sites });
      case "POST /api/sites": {
        const domain = String(body.domain ?? "").trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9._-]{0,252}$/.test(domain)) return fail(400, "enter a domain (example.com) or a name (my-app)");
        const existing = state.sites.find((s) => s.domain === domain);
        if (existing) return ok({ site: existing });
        const site = { id: state.nextId++, domain, created_at: Math.floor(now() / 1000) };
        state.sites.push(site);
        return ok({ site });
      }
      case "GET /api/users":
        return ok({ users: state.users.map(withSites) });
      case "POST /api/users": {
        const email = String(body.email ?? "").trim().toLowerCase();
        if (!email.includes("@")) return fail(400, "a valid email is required");
        if (email === DEMO_EMAIL) return fail(400, "that is the administrator's own email");
        if (state.users.some((u) => u.email === email)) return fail(409, "already invited");
        const ids = Array.isArray(body.siteIds) ? (body.siteIds as number[]).filter((id) => state.sites.some((s) => s.id === id)) : [];
        const user: PublicUser = { id: state.nextId++, email, role: "viewer", created_at: Math.floor(now() / 1000), siteIds: ids };
        state.users.push(user);
        return ok({ user });
      }
      case "GET /api/summary":
        return summary(q);
      case "GET /api/breakdown":
        return breakdown(q);
      case "GET /api/timeseries":
        return timeseries(q);
      case "GET /api/realtime":
        return realtime(q);
      case "GET /api/world.json":
        return ok(WORLD_GEOMETRY);
      case "GET /api/active-users":
        return activeUsers(q);
      case "GET /api/retention":
        return retention(q);
      case "GET /api/events":
        return events(q);
      case "GET /api/event-properties":
        return eventProperties(q);
      case "GET /api/event-series":
        return eventSeries(q);
      case "GET /api/oauth/grants":
        return ok({ grants: state.grants });
    }

    const site = /^\/api\/sites\/(\d+)$/.exec(path);
    if (site && req.method === "DELETE") {
      state.sites = state.sites.filter((s) => s.id !== Number(site[1]));
      return ok({ ok: true });
    }
    const user = /^\/api\/users\/(\d+)$/.exec(path);
    if (user) {
      const target = state.users.find((u) => u.id === Number(user[1]));
      if (!target || target.role === "owner") return fail(404, "not found");
      if (req.method === "PATCH") {
        target.siteIds = Array.isArray(body.siteIds) ? (body.siteIds as number[]) : target.siteIds;
        return ok({ user: target });
      }
      if (req.method === "DELETE") {
        state.users = state.users.filter((u) => u !== target);
        return ok({ ok: true });
      }
    }
    const grant = /^\/api\/oauth\/grants\/([^/]+)$/.exec(path);
    if (grant && req.method === "DELETE") {
      const before = state.grants.length;
      state.grants = state.grants.filter((g) => String(g.id) !== decodeURIComponent(grant[1]!));
      return state.grants.length < before ? ok({ ok: true }) : fail(404, "not found");
    }
    return fail(404, "not found");
  };
}
