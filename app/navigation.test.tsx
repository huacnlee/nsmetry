/**
 * The content area's page stack (app/DESIGN.md, "Navigation model"): each section pushes its detail
 * as a page over its list, back returns to the list as it was (scroll, tab, filter), a range change
 * keeps the page and reloads it, a section or site change resets the stack, and on a phone the
 * detail is a pushed page under the system header with the tab bar still below.
 */
import { describe, expect, open, test } from "nsh/test";
import { calls, desktop, filtersOf, hasText, S, server, signedIn, site } from "./fixtures/insights-server";

const events = [
  { name: "signup", count: 40, users: 30 },
  { name: "export", count: 120, users: 50 },
];
const withEvents = () =>
  server({
    [`GET ${S}/api/events*`]: { body: { events } },
    [`GET ${S}/api/event-series*`]: { body: { labels: ["2026-11-25", "2026-11-26"], count: [70, 50], users: [30, 20] } },
    [`GET ${S}/api/event-properties*`]: { body: { keys: [] } },
  });

describe("page stack", () => {
  test("each section pushes its detail as a page, and back returns to its list", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: withEvents() });
    await app.waitFor("id:nav-overview");

    // Events: a row.
    await app.press("id:nav-events");
    await app.waitFor("text:export");
    await app.press("text:export");
    await app.waitFor("id:event-page");
    expect(app.shows("id:event-page-title")).toBe(true);
    expect(app.accessibility("id:event-page-header-back")?.label).toBe("Back to Events");
    await app.press("id:event-page-header-back");
    await app.waitUntil(() => !app.shows("id:event-page"));
    await app.waitFor("id:events-table");

    // Pages: a page row filters and pushes the route.
    await app.press("id:nav-pages");
    await app.waitFor("role:button[/pricing, 300]");
    await app.press("role:button[/pricing, 300]");
    await app.waitFor("id:route-page-props");
    await app.back();
    await app.waitFor("id:screen-pages");

    // Geography: the details of the filtered country.
    await app.press("id:nav-geography");
    await app.waitFor("id:add-filter-country");
    await app.press("id:add-filter-country");
    await app.waitFor("text:Germany");
    await app.press("text:Germany");
    await app.waitFor("id:country-details");
    await app.press("id:country-details");
    await app.waitFor("id:country-page-props");
    await app.keyboard.press("Escape");
    await app.waitUntil(() => !app.shows("id:country-page"));

    // Tech: a filtered tech value.
    await app.press("id:nav-tech");
    await app.waitFor("role:button[Chrome, 500]");
    await app.press("role:button[Chrome, 500]");
    await app.press("id:tech-details");
    await app.waitFor("id:tech-page-props");
    // Its breakdowns are the questions about a browser: systems, devices, countries.
    await app.waitUntil(() => calls(app, "/api/breakdown").some((r) => r.url.includes("dim=os%2Cdevice%2Ccountry") && filtersOf(r.url).browser === "Chrome"));
    expect(hasText(app.texts(), "Operating systems")).toBe(true);
    app.dispose();
  });

  test("back keeps the list's tab, filter and scroll position", async () => {
    // A short window, so the list scrolls.
    const app = await open("./App.tsx", { width: 1280, height: 280, platform: "macos", storage: signedIn(), network: server() });
    await app.press("id:nav-sources");
    await app.press("role:tab[Campaign]");
    await app.waitFor("role:button[autumn-launch, 60]");
    await app.press("role:button[autumn-launch, 60]");
    await app.waitFor("id:remove-filter-utm_campaign");
    await app.scroll("id:page-section", 40);
    const before = app.layout("id:source-details");
    expect(before).not.toBeNull();
    await app.press("id:source-details");
    await app.waitFor("id:source-page-props");
    // The list is beneath the page: nothing of it is on screen or pressable.
    expect(app.shows("id:screen-sources")).toBe(false);
    await app.back();
    await app.waitFor("id:screen-sources");
    expect(app.accessibility("role:tab[Campaign]")?.selected).toBe(true);
    expect(app.shows("id:remove-filter-utm_campaign")).toBe(true);
    expect(app.layout("id:source-details")?.y).toBe(before!.y);
    app.dispose();
  });

  test("a range change keeps the page and reloads it; a section change resets the stack", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: withEvents() });
    await app.press("id:nav-events");
    await app.waitFor("text:export");
    await app.press("text:export");
    await app.waitFor("id:event-page");
    const series = () => calls(app, "/api/event-series").length;
    const n = series();
    await app.press("text:30d");
    await app.waitUntil(() => series() > n);
    expect(app.shows("id:event-page")).toBe(true);
    await app.waitUntil(() => hasText(app.texts(), "example.com · event · Last 30 days")); // the header's meta follows

    // Another section: back to a list, the new one, with nothing to go back to.
    await app.press("id:nav-pages");
    await app.waitFor("id:screen-pages");
    expect(app.shows("id:event-page")).toBe(false);
    await expect(app.back()).rejects.toMatchObject({ code: "ERR_NSH_TEST_NO_BACK" });

    // The current section again pops to its list.
    await app.press("role:button[/pricing, 300]");
    await app.waitFor("id:route-page");
    await app.press("id:nav-pages");
    await app.waitUntil(() => !app.shows("id:route-page"));
    await app.waitFor("id:screen-pages");
    // The filter the row added stays (a section change keeps filters).
    expect(app.shows("id:remove-filter-path")).toBe(true);
    app.dispose();
  });

  test("a site change resets the stack", async () => {
    const other = { id: 8, domain: "other.dev", created_at: 0 };
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server({ [`GET ${S}/api/sites`]: { body: { sites: [site, other] } } }) });
    await app.press("id:nav-pages");
    await app.press("role:button[/pricing, 300]");
    await app.waitFor("id:route-page");
    await app.press("id:site-switcher");
    await app.press("text:other.dev");
    await app.waitUntil(() => !app.shows("id:route-page"));
    await app.waitFor("id:screen-pages");
    expect(app.shows("id:remove-filter-path")).toBe(false);
    app.dispose();
  });

  test("on a phone the detail is a pushed page under the system header, the tab bar below", async () => {
    const app = await open("./App.tsx", { width: 390, height: 844, platform: "ios", storage: signedIn(), network: withEvents() });
    await app.waitFor("id:tab-more");
    await app.press("id:tab-more");
    await app.press("id:more-events");
    await app.waitFor("text:export");
    await app.press("text:export");
    await app.waitFor("id:event-detail");
    // iOS draws the title in its own header; the page does not repeat it, nor draw the desktop header.
    expect(app.shows("id:event-page-header")).toBe(false);
    expect(app.shows("id:event-page-title")).toBe(false);
    expect(app.shows("id:tab-more")).toBe(true);
    const page = app.layout("id:event-detail")!;
    expect(page.x).toBeGreaterThanOrEqual(16);
    expect(page.x + page.width).toBeLessThanOrEqual(390 - 16);
    // The system back (the header's button, the edge swipe) pops it.
    await app.back();
    await app.waitFor("id:events-table");
    app.dispose();
  });
});
