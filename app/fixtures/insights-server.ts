/**
 * A fake NsMetry instance for the insights screens' tests (Overview, Pages, Sources, Geography,
 * Tech): every endpoint they call, answering from fixed data, with filters honored where a screen
 * depends on them (a breakdown of a filtered dimension shows only its value).
 */
import type { StubRequest, StubResponse } from "nsh/test";

export const S = "https://stats.test";
export const owner = { id: 1, email: "owner@example.com", role: "owner", created_at: 0, siteIds: [] as number[] };
export const site = { id: 7, domain: "example.com", created_at: 0 };

export type Routes = Record<string, StubResponse | ((r: StubRequest) => StubResponse)>;

const labels = ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"];
const series = (base: number) => labels.map((_, i) => base + i * 3);

export const summaryBody = {
  site,
  range: { id: "7d", from: labels[0], to: labels[6], prevFrom: "2026-11-13", prevTo: "2026-11-19", granularity: "day", prevLabel: "previous 7 days" },
  filters: [],
  totals: { visitors: 1200, views: 3400, vpv: 2.83, bounce: 41.5, time: 95 },
  previous: { visitors: 1000, views: 3600, vpv: 3.6, bounce: 45, time: 80 },
  series: {
    labels,
    cur: { visitors: series(150), views: series(400), vpv: series(2), bounce: series(40), time: series(90) },
    prev: { visitors: series(120), views: series(420), vpv: series(3), bounce: series(44), time: series(80) },
  },
};

export const rows: Record<string, { name: string; value: number }[]> = {
  path: [{ name: "/", value: 600 }, { name: "/pricing", value: 300 }, { name: "Settings", value: 120 }],
  entry: [{ name: "/", value: 500 }, { name: "/blog/launch", value: 90 }],
  exit: [{ name: "/pricing", value: 200 }],
  referrer: [{ name: "", value: 400 }, { name: "news.ycombinator.com", value: 250 }],
  utm_source: [{ name: "newsletter", value: 80 }],
  utm_medium: [{ name: "email", value: 80 }],
  utm_campaign: [{ name: "autumn-launch", value: 60 }],
  event: [{ name: "signup", value: 40 }],
  country: [{ name: "DE", value: 500 }, { name: "JP", value: 200 }, { name: "US", value: 150 }],
  browser: [{ name: "Chrome", value: 500 }, { name: "App", value: 300 }],
  os: [{ name: "macOS", value: 400 }, { name: "iOS", value: 200 }],
  device: [{ name: "desktop", value: 700 }, { name: "mobile", value: 300 }],
  screen: [{ name: "1280+", value: 600 }],
  app_version: [{ name: "1.2.0", value: 250 }, { name: "1.1.4", value: 50 }],
};

/** The filters a request carries, as `{ dim: value }`. */
export function filtersOf(url: string): Record<string, string> {
  const f = /[?&]f=([^&]*)/.exec(url)?.[1];
  const out: Record<string, string> = {};
  if (!f) return out;
  for (const part of f.split(",")) {
    const i = part.indexOf(":");
    out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

function breakdown(r: StubRequest): StubResponse {
  const dims = decodeURIComponent(/[?&]dim=([^&]*)/.exec(r.url)?.[1] ?? "").split(",");
  const f = filtersOf(r.url);
  const out: Record<string, { name: string; value: number }[]> = {};
  for (const d of dims) {
    const all = rows[d] ?? [];
    out[d] = f[d] !== undefined ? all.filter((x) => x.name === f[d]) : all;
  }
  return { body: { breakdowns: out } };
}

export const realtimeBody = {
  online: 3,
  minutes: Array.from({ length: 30 }, (_, i) => ({ label: `${30 - i}m`, cur: i % 4 })),
  recent: [
    { ts: Math.floor(Date.now() / 1000) - 20, path: "/pricing", country: "DE" },
    { ts: Math.floor(Date.now() / 1000) - 200, path: "Settings", country: "JP" },
  ],
};

/** Two squares for a map: Germany and Japan. */
export const worldBody = {
  width: 200,
  height: 100,
  countries: { DE: "M10 10 L60 10 L60 60 L10 60 Z", JP: "M120 10 L170 10 L170 60 L120 60 Z" },
};

export function server(over: Routes = {}): Routes {
  return {
    [`GET ${S}/api/me`]: { body: { user: owner, trackerUrl: `${S}/t.js`, version: "0.3.0", update: null } },
    [`GET ${S}/api/sites`]: { body: { sites: [site] } },
    [`GET ${S}/api/summary*`]: { body: summaryBody },
    [`GET ${S}/api/breakdown*`]: breakdown,
    [`GET ${S}/api/realtime*`]: { body: realtimeBody },
    [`GET ${S}/api/world.json`]: { body: worldBody },
    [`GET ${S}/api/events*`]: { body: { events: [] } },
    [`GET ${S}/api/active-users*`]: { body: { tracked: false, labels: [], dau: [], new: [], totals: { active: 0, new: 0 }, wau: 0, mau: 0 } },
    ...over,
  };
}

/** A desktop window: the sidebar lists every section. */
export const desktop = { width: 1280, height: 900, platform: "macos" as const };
export const signedIn = () => ({ server: S, [`session:${S}`]: JSON.stringify({ token: "tok-1", user: owner }) });
export const hasText = (texts: string[], part: string) => texts.some((t) => t.includes(part));
export const calls = (app: { requests(): StubRequest[] }, path: string) => app.requests().filter((r) => r.url.startsWith(`${S}${path}`));
