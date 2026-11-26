/**
 * Screenshots of a pushed detail page (an event's) in light and dark, at desktop width and at 390pt,
 * for the finishing checklist. On a real target (`nsh test app/detail-shots.test.tsx --target macos`)
 * they land in app/shots/; headless the test returns early, since nothing is drawn.
 */
import { open, test, type StubRequest, type StubResponse } from "nsh/test";

const S = "https://stats.test";
const owner = { id: 1, email: "owner@example.com", role: "owner", created_at: 0, siteIds: [] };
const site = { id: 7, domain: "my-app", created_at: 0 };
const days = Array.from({ length: 30 }, (_, i) => `2026-${i < 4 ? "10" : "11"}-${String(i < 4 ? 28 + i : i - 3).padStart(2, "0")}`);
const wave = (base: number, amp: number) => days.map((_, i) => Math.round(base + amp * Math.sin(i / 2.2) + i * base * 0.01));

const network: Record<string, StubResponse | ((r: StubRequest) => StubResponse)> = {
  [`GET ${S}/api/me`]: { body: { user: owner, trackerUrl: `${S}/t.js`, version: "0.3.0", update: null } },
  [`GET ${S}/api/sites`]: { body: { sites: [site] } },
  [`GET ${S}/api/summary*`]: { body: { totals: { visitors: 4200, views: 9000, vpv: 2.1, bounce: 30, time: 60 }, previous: null, series: { labels: [], cur: { visitors: [], views: [], vpv: [], bounce: [], time: [] }, prev: null } } },
  [`GET ${S}/api/breakdown*`]: { body: { breakdowns: {} } },
  [`GET ${S}/api/timeseries*`]: { body: { granularity: "day", points: [] } },
  [`GET ${S}/api/realtime*`]: { body: { online: 0, minutes: [], recent: [] } },
  [`GET ${S}/api/active-users*`]: { body: { tracked: true, labels: days, dau: wave(420, 60), new: wave(60, 15), totals: { active: 3900, new: 1820 }, wau: 1500, mau: 3900 } },
  [`GET ${S}/api/retention*`]: {
    body: {
      tracked: true,
      cohorts: Array.from({ length: 8 }, (_, c) => {
        const size = 300 + c * 23;
        return { label: `2026-${c < 3 ? "10" : "11"}-${String(c < 3 ? 6 + c * 7 : (c - 3) * 7 + 3).padStart(2, "0")}`, size, retained: Array.from({ length: 8 - c }, (_, i) => (i === 0 ? size : Math.round(size * (0.42 / Math.sqrt(i)) * (1 - c * 0.02)))) };
      }),
    },
  },
  [`GET ${S}/api/events*`]: {
    body: {
      events: [
        { name: "export", count: 1840, users: 1210 },
        { name: "signup", count: 420, users: 410 },
        { name: "share_link", count: 380, users: 260 },
        { name: "theme_changed", count: 120, users: 90 },
        { name: "purchase", count: 64, users: 60 },
      ],
    },
  },
  [`GET ${S}/api/event-series*`]: { body: { labels: days, count: wave(60, 14), users: wave(40, 8) } },
  [`GET ${S}/api/event-properties*`]: (r) =>
    r.url.includes("key=")
      ? { body: { values: [{ name: "csv", value: 1100 }, { name: "pdf", value: 520 }, { name: "png", value: 220 }] } }
      : { body: { keys: [{ key: "format", count: 1840 }, { key: "rows", count: 1600 }, { key: "source", count: 300 }] } },
};

const storage = { server: S, [`session:${S}`]: JSON.stringify({ token: "tok-1", user: owner }) };

for (const [name, width, height] of [["desktop", 1280, 900], ["390", 390, 844]] as const) {
  test(`an event's detail page at ${name}, light and dark`, async () => {
    const app = await open("./App.tsx", { width, height, platform: "macos", network, storage });
    await app.waitFor("id:account").catch(() => undefined);
    if (!(await app.screenshot().then(() => true, () => false))) return app.dispose();
    if (name === "desktop") await app.press("id:nav-events");
    else {
      await app.press("id:tab-more");
      await app.press("id:more-events");
    }
    await app.waitFor("id:events-table");
    await app.press("text:export");
    await app.waitFor("id:event-values-format");
    for (const scheme of ["light", "dark"] as const) {
      await app.setColorScheme(scheme);
      await app.wait(900);
      await app.screenshot(`app/shots/detail-page-${name}-${scheme}.png`);
    }
    app.dispose();
  }, 300_000);
}
