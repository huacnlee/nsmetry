/**
 * The Events screen against a fake instance: the table with share of visits, the event's pushed page (trend,
 * property keys, a key's values loaded only once it is open), values that do not become filters, the
 * fallback for a server without `/api/event-series`, and the empty state.
 */
import { describe, expect, open, test, type StubRequest, type StubResponse } from "nsh/test";

const S = "https://stats.test";
const owner = { id: 1, email: "owner@example.com", role: "owner", created_at: 0, siteIds: [] };
const site = { id: 7, domain: "my-app", created_at: 0 };

type Routes = Record<string, StubResponse | ((r: StubRequest) => StubResponse)>;

const events = [
  { name: "signup", count: 40, users: 30 },
  { name: "export", count: 120, users: 50 },
];

function server(over: Routes = {}): Routes {
  return {
    [`GET ${S}/api/me`]: { body: { user: owner, trackerUrl: `${S}/t.js`, version: "0.3.0", update: null } },
    [`GET ${S}/api/sites`]: { body: { sites: [site] } },
    [`GET ${S}/api/summary*`]: { body: { totals: { visitors: 200, views: 900, vpv: 4.5, bounce: 30, time: 60 }, previous: null, series: { labels: [], cur: { visitors: [], views: [], vpv: [], bounce: [], time: [] }, prev: null } } },
    [`GET ${S}/api/breakdown*`]: { body: { breakdowns: { country: [{ name: "DE", value: 5 }] } } },
    [`GET ${S}/api/timeseries*`]: { body: { granularity: "day", points: [] } },
    [`GET ${S}/api/realtime*`]: { body: { online: 0, minutes: [], recent: [] } },
    [`GET ${S}/api/events*`]: { body: { events } },
    [`GET ${S}/api/event-series*`]: { body: { labels: ["2026-11-25", "2026-11-26"], count: [70, 50], users: [30, 20] } },
    [`GET ${S}/api/event-properties*`]: (r) =>
      r.url.includes("key=format")
        ? { body: { values: [{ name: "csv", value: 90 }, { name: "pdf", value: 30 }] } }
        : r.url.includes("key=rows")
          ? { body: { values: [{ name: "120", value: 4 }] } }
          : { body: { keys: [{ key: "format", count: 120 }, { key: "rows", count: 40 }] } },
    ...over,
  };
}

/** A desktop window: the sidebar lists every section. */
const desktop = { width: 1280, height: 900, platform: "macos" as const };
const signedIn = () => ({ server: S, [`session:${S}`]: JSON.stringify({ token: "tok-1", user: owner }) });
const hasText = (texts: string[], part: string) => texts.some((t) => t.includes(part));
const calls = (app: { requests(): StubRequest[] }, path: string) => app.requests().filter((r) => r.url.startsWith(`${S}${path}`));

describe("events screen", () => {
  test("the table lists events by count with their share of visits", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.waitFor("id:nav-events");
    await app.press("id:nav-events");
    await app.waitFor("id:events-table");
    await app.waitUntil(() => hasText(app.texts(), "25%")); // export: 50 of 200 visits
    expect(hasText(app.texts(), "15%")).toBe(true); // signup: 30 of 200
    expect(hasText(app.texts(), "2 events")).toBe(true);
    const texts = app.texts();
    expect(texts.findIndex((t) => t === "export")).toBeLessThan(texts.findIndex((t) => t === "signup"));
    app.dispose();
  });

  test("pressing an event pushes its page: trend, keys, the first key's values, then another key's", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.press("id:nav-events");
    await app.waitFor("id:events-table");
    await app.press("text:export");
    await app.waitFor("id:event-page");
    expect(app.shows("id:events-table")).toBe(false); // the table is beneath the page
    expect(app.shows("text:my-app · event · Last 7 days")).toBe(true);
    await app.waitFor("id:event-trend");
    expect(calls(app, "/api/event-series").at(-1)!.url).toContain("event=export");
    await app.waitFor("id:event-values-format");
    await app.waitUntil(() => hasText(app.texts(), "csv"));
    expect(hasText(app.texts(), "75%")).toBe(true); // csv: 90 of the 120 events with `format`
    // `rows` is closed, so its values were not asked for.
    expect(calls(app, "/api/event-properties").some((r) => r.url.includes("key=rows"))).toBe(false);
    await app.press("id:event-key-rows");
    await app.waitFor("id:event-values-rows");
    expect(calls(app, "/api/event-properties").some((r) => r.url.includes("key=rows"))).toBe(true);
    app.dispose();
  });

  test("a property value is not a filter", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.press("id:nav-events");
    await app.waitFor("id:events-table");
    await app.press("text:export");
    await app.waitUntil(() => hasText(app.texts(), "csv"));
    expect(app.shows("role:button[csv, 90]")).toBe(false);
    expect(hasText(app.texts(), "they are not filters")).toBe(true);
    expect(app.shows("id:filters")).toBe(false);
    app.dispose();
  });

  test("a server without the event trend says so instead of failing", async () => {
    const app = await open("./App.tsx", { ...desktop,
      storage: signedIn(),
      network: server({ [`GET ${S}/api/event-series*`]: { status: 404, body: { error: "not found" } } }),
    });
    await app.press("id:nav-events");
    await app.waitFor("id:events-table");
    await app.press("text:signup");
    await app.waitFor("id:event-trend-unavailable");
    expect(app.shows("id:event-keys")).toBe(true);
    app.dispose();
  });

  test("no events: the empty state shows how to send one", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server({ [`GET ${S}/api/events*`]: { body: { events: [] } } }) });
    await app.press("id:nav-events");
    await app.waitFor("id:events-empty");
    expect(hasText(app.texts(), "No custom events in this period")).toBe(true);
    expect(hasText(app.texts(), 'nsmetry.track("export"')).toBe(true);
    app.dispose();
  });

  test("filters reach the events request", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.press("id:nav-events");
    await app.waitFor("id:events-table");
    await app.press("id:add-filter-country");
    await app.waitFor("role:button[DE]");
    await app.press("role:button[DE]");
    await app.waitUntil(() => calls(app, "/api/events").some((r) => r.url.includes("f=country:DE")));
    app.dispose();
  });
});
