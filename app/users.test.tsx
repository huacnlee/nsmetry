/**
 * The Users screen against a fake instance: the tiles and chart of a site that sends user ids, the
 * retention grid and its day / week switch, that filters do not reload it, and the setup snippet of a
 * site that has never sent one.
 */
import { describe, expect, open, test, type StubRequest, type StubResponse } from "nsh/test";
import { retentionGrid } from "./screens/users/retention";
import { bucketLabel } from "./screens/users/labels";

const S = "https://stats.test";
const owner = { id: 1, email: "owner@example.com", role: "owner", created_at: 0, siteIds: [] };
const site = { id: 7, domain: "my-app", created_at: 0 };

type Routes = Record<string, StubResponse | ((r: StubRequest) => StubResponse)>;

const activeUsers = {
  tracked: true,
  labels: ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"],
  dau: [100, 120, 90, 110, 130, 140, 150],
  new: [20, 25, 10, 15, 30, 22, 18],
  totals: { active: 640, new: 140 },
  wau: 640,
  mau: 1600,
};

const retention = (cohort: string) => ({
  tracked: true,
  cohorts: [
    { label: cohort === "day" ? "2026-11-24" : "2026-11-09", size: 200, retained: [200, 80, 50] },
    { label: cohort === "day" ? "2026-11-25" : "2026-11-16", size: 100, retained: [100, 30] },
    { label: cohort === "day" ? "2026-11-26" : "2026-11-23", size: 50, retained: [50] },
  ],
});

function server(over: Routes = {}): Routes {
  return {
    [`GET ${S}/api/me`]: { body: { user: owner, trackerUrl: `${S}/t.js`, version: "0.3.0", update: null } },
    [`GET ${S}/api/sites`]: { body: { sites: [site] } },
    [`GET ${S}/api/summary*`]: { body: { totals: { visitors: 0, views: 0, vpv: 0, bounce: 0, time: 0 }, previous: null, series: { labels: [], cur: { visitors: [], views: [], vpv: [], bounce: [], time: [] }, prev: null } } },
    [`GET ${S}/api/breakdown*`]: { body: { breakdowns: { country: [{ name: "DE", value: 5 }] } } },
    [`GET ${S}/api/timeseries*`]: { body: { granularity: "day", points: [] } },
    [`GET ${S}/api/realtime*`]: { body: { online: 0, minutes: [], recent: [] } },
    [`GET ${S}/api/active-users*`]: { body: activeUsers },
    [`GET ${S}/api/retention*`]: (r) => ({ body: retention(r.url.includes("cohort=day") ? "day" : "week") }),
    ...over,
  };
}

/** A desktop window: the sidebar lists every section. */
const desktop = { width: 1280, height: 900, platform: "macos" as const };
const signedIn = () => ({ server: S, [`session:${S}`]: JSON.stringify({ token: "tok-1", user: owner }) });
const hasText = (texts: string[], part: string) => texts.some((t) => t.includes(part));
const calls = (app: { requests(): StubRequest[] }, path: string) => app.requests().filter((r) => r.url.startsWith(`${S}${path}`));

describe("users screen", () => {
  test("tiles, stickiness and the two-series chart of a tracked site", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.waitFor("id:nav-users");
    await app.press("id:nav-users");
    await app.waitFor("id:users-tiles");
    expect(hasText(app.texts(), "Counting user ids")).toBe(true);
    // Active over the range, new, average DAU (840 / 7 = 120), WAU, MAU, stickiness 120 / 1600.
    expect(hasText(app.texts(), "640")).toBe(true);
    expect(hasText(app.texts(), "1,600")).toBe(true);
    expect(hasText(app.texts(), "120")).toBe(true);
    expect(hasText(app.texts(), "7.5%")).toBe(true);
    expect(app.shows("id:users-chart")).toBe(true);
    expect(calls(app, "/api/active-users").at(-1)!.url).toContain("range=7d");
    app.dispose();
  });

  test("retention loads weekly cohorts and switches to daily", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.press("id:nav-users");
    await app.waitFor("id:retention-grid");
    expect(calls(app, "/api/retention").at(-1)!.url).toContain("cohort=week");
    // 80 + 30 of 300 came back a week later.
    await app.waitUntil(() => hasText(app.texts(), "37% of new users came back the next week"));
    await app.press("id:retention-cohort-day");
    await app.waitUntil(() => calls(app, "/api/retention").some((r) => r.url.includes("cohort=day")));
    await app.waitUntil(() => hasText(app.texts(), "came back the next day"));
    app.dispose();
  });

  test("a filter does not reload users, and says it does not apply", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.press("id:nav-users");
    await app.waitFor("id:users-tiles");
    const before = calls(app, "/api/active-users").length;
    await app.press("id:add-filter-country");
    await app.waitFor("role:button[DE]");
    await app.press("role:button[DE]");
    await app.waitFor("id:users-filter-note");
    expect(calls(app, "/api/active-users").length).toBe(before);
    app.dispose();
  });

  test("an untracked site gets the user id snippet for this instance and site", async () => {
    const app = await open("./App.tsx", { ...desktop,
      storage: signedIn(),
      network: server({ [`GET ${S}/api/active-users*`]: { body: { ...activeUsers, tracked: false, dau: [], new: [], labels: [] } } }),
    });
    await app.press("id:nav-users");
    await app.waitFor("id:users-setup");
    expect(hasText(app.texts(), "No user ids yet")).toBe(true);
    expect(hasText(app.texts(), `endpoint: "${S}"`)).toBe(true);
    expect(hasText(app.texts(), `site: "my-app"`)).toBe(true);
    await app.press("id:user-id-way-http");
    await app.waitUntil(() => hasText(app.texts(), "/api/events/batch"));
    expect(app.shows("id:retention")).toBe(false);
    app.dispose();
  });

  test("an error offers to try again", async () => {
    const app = await open("./App.tsx", { ...desktop,
      storage: signedIn(),
      network: server({ [`GET ${S}/api/active-users*`]: { status: 500, body: { error: "database is busy" } } }),
    });
    await app.press("id:nav-users");
    await app.waitUntil(() => hasText(app.texts(), "database is busy"));
    expect(hasText(app.texts(), "Try again")).toBe(true);
    app.dispose();
  });
});

describe("retention arithmetic", () => {
  test("size column, shares, the best share and the period-one average", () => {
    const g = retentionGrid(retention("week"), "week");
    expect(g.rows).toEqual(["Nov 9", "Nov 16", "Nov 23"]);
    expect(g.cells.filter((c) => c.x === "0").map((c) => c.label)).toEqual(["200", "100", "50"]);
    expect(g.cells.find((c) => c.y === "Nov 9" && c.x === "1")?.value).toBe(0.4);
    expect(g.best).toBe(0.4);
    expect(Math.abs((g.periodOne ?? 0) - 110 / 300) < 1e-9).toBe(true);
  });

  test("bucket labels", () => {
    expect(bucketLabel("2026-11-20")).toBe("Nov 20");
    expect(bucketLabel("2026-11-20T09")).toBe("09:00");
    expect(bucketLabel("2026-11")).toBe("Nov 2026");
  });
});

describe("users screen on a phone", () => {
  test("the tab bar opens it and the tiles wrap", async () => {
    const app = await open("./App.tsx", { storage: signedIn(), network: server() });
    await app.waitFor("id:tab-users");
    await app.press("id:tab-users");
    await app.waitFor("id:users-tiles");
    const tile = app.layout("id:users-active");
    expect(tile !== null && tile.width < 390).toBe(true);
    app.dispose();
  });
});

describe("an app's overview", () => {
  test("leads with active users and leaves out what only a website has", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.waitFor("id:overview-users-tiles");
    expect(app.shows("id:overview-users-chart")).toBe(true);
    expect(app.shows("id:overview-platforms")).toBe(true);
    expect(app.shows("id:overview-versions")).toBe(true);
    expect(app.shows("id:overview-metrics")).toBe(false);
    expect(app.shows("id:overview-sources")).toBe(false);
    expect(app.shows("id:nav-sources")).toBe(false);
    const dims = calls(app, "/api/breakdown").at(-1)!.url;
    expect(dims).toContain("app_version");
    expect(dims).not.toContain("referrer");
    app.dispose();
  });

  test("an app that has not sent a user id yet points to the install", async () => {
    const app = await open("./App.tsx", { ...desktop,
      storage: signedIn(),
      network: server({ [`GET ${S}/api/active-users*`]: { body: { ...activeUsers, tracked: false, dau: [], new: [], labels: [] } } }),
    });
    await app.waitFor("id:overview-no-users");
    expect(app.shows("id:overview-users-tiles")).toBe(false);
    app.dispose();
  });
});
