/**
 * Pages and screens: the three tabs, shares of the range's visitors, a row adding a path filter that
 * pushes the route's detail page, going back keeping the filter, pushing it again, and removing the
 * filter from the page (which pops it).
 */
import { describe, expect, open, test } from "nsh/test";
import { calls, desktop, hasText, server, signedIn } from "./fixtures/insights-server";

describe("pages screen", () => {
  test("tabs switch between top, entry and exit pages, each with its share", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.press("id:nav-pages");
    await app.waitFor("text:Settings");
    expect(hasText(app.texts(), "50%")).toBe(true); // "/" 600 of 1,200 visitors
    expect(calls(app, "/api/breakdown").at(-1)!.url).toContain("dim=path%2Centry%2Cexit");
    // No route page is open: its loads ask nothing.
    expect(calls(app, "/api/breakdown").some((r) => r.url.includes("dim=referrer%2Ccountry%2Cdevice"))).toBe(false);
    await app.press("role:tab[Entry]");
    await app.waitUntil(() => hasText(app.texts(), "/blog/launch"));
    await app.press("role:tab[Exit]");
    await app.waitUntil(() => !hasText(app.texts(), "/blog/launch"));
    app.dispose();
  });

  test("a page row filters by it and pushes the route page; back keeps the filter", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.press("id:nav-pages");
    await app.waitUntil(() => hasText(app.texts(), "/pricing"));
    await app.press("role:button[/pricing, 300]");
    await app.waitFor("id:route-page");
    await app.waitFor("id:route-page-props");
    expect(hasText(app.texts(), "Where visitors came from")).toBe(true);
    // The page's loads carry the route as a filter.
    expect(calls(app, "/api/breakdown").some((r) => r.url.includes("dim=referrer%2Ccountry%2Cdevice") && r.url.includes("f=path:%2Fpricing"))).toBe(true);
    await app.press("id:route-page-header-back");
    await app.waitUntil(() => !app.shows("id:route-page"));
    await app.waitFor("id:screen-pages");
    expect(app.shows("id:remove-filter-path")).toBe(true);
    await app.press("id:route-details");
    await app.waitFor("id:route-page");
    await app.press("id:route-page-clear");
    await app.waitUntil(() => !app.shows("id:route-page"));
    await app.waitFor("id:screen-pages");
    expect(app.shows("id:remove-filter-path")).toBe(false);
    app.dispose();
  });
});
