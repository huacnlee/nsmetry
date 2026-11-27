/**
 * The on-device demo (app/demo.ts): it answers the whole API without the network, every screen
 * renders from it, and leaving it returns to the server it was entered from.
 */
import { describe, expect, open, test } from "nsh/test";
import { createDemoServer, isDemoServer } from "./demo";

const S = "https://stats.test";
const NOW = Date.parse("2026-11-26T15:30:00Z");

async function get(path: string) {
  const demo = createDemoServer({ now: () => NOW });
  return demo({ method: "GET", url: `https://demo${path}`, headers: {} });
}

describe("demo server", () => {
  test("recognises however the demo is typed", () => {
    for (const s of ["demo", "https://demo", "http://demo/", " Demo "]) expect(isDemoServer(s)).toBe(true);
    expect(isDemoServer("demo.example.com")).toBe(false);
  });

  test("answers every analytics endpoint in the contract's shape", async () => {
    const summary = (await get("/api/summary?site=1&range=30d&cmp=1")).json as {
      totals: { visitors: number };
      previous: unknown;
      series: { labels: string[]; cur: { visitors: number[] } };
      range: { granularity: string };
    };
    expect(summary.totals.visitors).toBeGreaterThan(0);
    expect(summary.previous).not.toBeNull();
    expect(summary.series.labels.length).toBe(30);
    expect(summary.series.cur.visitors.length).toBe(30);
    expect(summary.range.granularity).toBe("day");

    const today = (await get("/api/summary?site=1&range=today")).json as { series: { labels: string[] } };
    expect(today.series.labels.length).toBe(16); // hours 00..15 so far today

    const b = (await get("/api/breakdown?site=2&range=7d&dim=path,referrer,event&limit=3")).json as {
      breakdowns: Record<string, { name: string; value: number }[]>;
    };
    expect(b.breakdowns.path!.length).toBe(3);
    expect(b.breakdowns.event!.some((r) => r.name === "download")).toBe(true);

    for (const path of [
      "/api/timeseries?site=1&range=90d&metric=views",
      "/api/realtime?site=1",
      "/api/active-users?site=1&range=30d",
      "/api/retention?site=1&cohort=week&periods=6",
      "/api/events?site=1&range=30d",
      "/api/event-properties?site=1&range=30d&event=purchase",
      "/api/event-properties?site=1&range=30d&event=purchase&key=plan",
      "/api/event-series?site=1&range=30d&event=scan_finished",
      "/api/world.json",
      "/api/oauth/grants",
    ]) {
      expect((await get(path)).status).toBe(200);
    }
    expect((await get("/api/summary?site=999&range=7d")).status).toBe(404);
  });

  test("is seeded: the same request gives the same numbers", async () => {
    const a = await get("/api/summary?site=3&range=7d");
    const b = await get("/api/summary?site=3&range=7d");
    expect(a.json).toEqual(b.json);
  });

  test("a filter narrows the totals and its own dimension to its value", async () => {
    const all = (await get("/api/summary?site=1&range=30d")).json as { totals: { visitors: number } };
    const de = (await get("/api/summary?site=1&range=30d&f=country:DE")).json as { totals: { visitors: number } };
    expect(de.totals.visitors).toBeLessThan(all.totals.visitors);
    const b = (await get("/api/breakdown?site=1&range=30d&dim=country&f=country:DE")).json as {
      breakdowns: { country: { name: string }[] };
    };
    expect(b.breakdowns.country.map((r) => r.name)).toEqual(["DE"]);
  });
});

describe("demo in the app", () => {
  test("Try the demo signs in without the network; signing out returns to the real server", async () => {
    const app = await open("./App.tsx", { width: 1280, height: 900, platform: "macos", storage: { server: S }, network: {} });
    await app.waitFor("id:try-demo");
    await app.press("id:try-demo");
    await app.waitFor("id:screen-overview");
    expect(app.requests().length).toBe(0);

    // The demo opens on disktree, an app: Sources is a website's section, so it is not in the nav.
    expect(app.shows("id:nav-sources")).toBe(false);
    for (const screen of ["pages", "geography", "tech", "events", "users", "team", "agents"]) {
      await app.press(`id:nav-${screen}`);
      await app.waitFor(`id:screen-${screen}`);
    }
    expect(app.requests().length).toBe(0);

    await app.press("id:account");
    await app.press("id:sign-out");
    await app.waitFor("id:send-code");
    expect(app.storage().server).toBe(S);
    app.dispose();
  });
});
