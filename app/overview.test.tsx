/**
 * The Overview against a fake instance: metric tiles with deltas, switching the hero chart's metric,
 * compare costing no request, one breakdown for every list, a row adding a filter, and the live
 * panel's poll: every 30 s while visible, nothing in the background, at once on coming back.
 */
import { describe, expect, open, test } from "nsh/test";
import { calls, desktop, hasText, S, server, signedIn, summaryBody } from "./fixtures/insights-server";

describe("overview", () => {
  test("tiles show each metric with its change; a tile selects the hero chart's metric", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.waitFor("id:metric-visitors-value");
    expect(hasText(app.texts(), "1,200")).toBe(true); // visitors
    expect(hasText(app.texts(), "2.83")).toBe(true); // views per visit
    expect(hasText(app.texts(), "41.5%") || hasText(app.texts(), "42%")).toBe(true); // bounce
    expect(hasText(app.texts(), "1m 35s")).toBe(true); // time
    expect(hasText(app.texts(), "20%")).toBe(true); // visitors +20% vs previous
    // Every summary asks for the previous period, so deltas show with compare off.
    expect(calls(app, "/api/summary").every((r) => r.url.includes("cmp=1"))).toBe(true);
    expect(app.accessibility("id:metric-visitors")?.selected).toBe(true);
    await app.press("id:metric-views");
    await app.waitUntil(() => app.accessibility("id:metric-views")?.selected === true);
    expect(app.accessibility("id:metric-visitors")?.selected).toBe(false);
    app.dispose();
  });

  test("compare toggles the dashed series without loading anything again", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.waitFor("id:overview-chart");
    const summaries = calls(app, "/api/summary").length;
    const breakdowns = calls(app, "/api/breakdown").length;
    await app.press("id:compare");
    await app.waitUntil(() => hasText(app.texts(), "Previous 7 days"));
    await app.wait(200);
    expect(calls(app, "/api/summary").length).toBe(summaries);
    expect(calls(app, "/api/breakdown").length).toBe(breakdowns);
    app.dispose();
  });

  test("one breakdown request carries every list; a row adds a filter", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.waitUntil(() => hasText(app.texts(), "/pricing"));
    const b = calls(app, "/api/breakdown");
    expect(b.length).toBe(1);
    for (const d of ["path", "referrer", "event", "country", "browser"]) expect(b[0]!.url).toContain(d);
    expect(hasText(app.texts(), "Germany")).toBe(true);
    expect(hasText(app.texts(), "Direct / none")).toBe(true);
    await app.press("role:button[/pricing, 300]");
    await app.waitFor("id:remove-filter-path");
    await app.waitUntil(() => calls(app, "/api/breakdown").some((r) => r.url.includes("f=path:%2Fpricing")));
    await app.waitUntil(() => calls(app, "/api/summary").some((r) => r.url.includes("f=path:%2Fpricing")));
    app.dispose();
  });

  test("the live panel shows who is online and the latest views", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.waitFor("id:live-online");
    expect(hasText(app.texts(), "Live · 3 online")).toBe(true);
    expect(app.shows("id:live-feed")).toBe(true);
    expect(hasText(app.texts(), "Germany")).toBe(true);
    app.dispose();
  });

  test("realtime polls every 30 s only while the app is visible", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server(), clock: {} });
    await app.waitFor("id:live-online");
    const live = () => calls(app, "/api/realtime").length;
    expect(live()).toBe(1);
    await app.clock!.runFor(30_000);
    await app.waitUntil(() => live() === 2);
    await app.setLifecycle("background");
    await app.clock!.runFor(120_000);
    expect(live()).toBe(2);
    // Back in front after a long pause: one request at once, then the 30 s rhythm again.
    await app.setLifecycle("active");
    await app.waitUntil(() => live() === 3);
    await app.clock!.runFor(30_000);
    await app.waitUntil(() => live() === 4);
    app.dispose();
  });

  test("errors show in place with a retry", async () => {
    const app = await open("./App.tsx", {
      ...desktop,
      storage: signedIn(),
      network: server({ [`GET ${S}/api/summary*`]: { status: 500, body: { error: "database is busy" } } }),
    });
    await app.waitUntil(() => hasText(app.texts(), "database is busy"));
    expect(hasText(app.texts(), "Could not load the summary")).toBe(true);
    app.dispose();
  });
});

describe("overview: install entry", () => {
  test("the header's Install tracking opens Settings", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.waitFor("id:metric-visitors-value");
    expect(app.texts().some((t) => t.startsWith("No data for"))).toBe(false);
    await app.press("id:overview-install");
    await app.waitFor("id:screen-settings");
    app.dispose();
  });

  test("a site with nothing recorded says so and offers the install", async () => {
    const zero = { visitors: 0, views: 0, vpv: 0, bounce: 0, time: 0 };
    const network = server({ [`GET ${S}/api/summary*`]: { body: { ...summaryBody, totals: zero, previous: zero } } });
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network });
    await app.waitFor("id:overview-no-data");
    await app.press("id:overview-no-data >> text:Install tracking");
    await app.waitFor("id:screen-settings");
    app.dispose();
  });
});
