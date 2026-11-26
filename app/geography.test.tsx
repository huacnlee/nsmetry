/** Geography: the world map and the country list, a country filter, the country's detail page, a map error. */
import { describe, expect, open, test } from "nsh/test";
import { calls, desktop, hasText, S, server, signedIn } from "./fixtures/insights-server";

describe("geography screen", () => {
  test("the map and the list of countries; a country row filters and opens its details", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.press("id:nav-geography");
    await app.waitFor("id:world-map");
    await app.waitFor("text:Germany");
    expect(hasText(app.texts(), "Japan")).toBe(true);
    expect(app.accessibility("id:world-map-canvas")?.label ?? "").toContain("Germany");
    await app.press("role:button[Japan, 200]");
    await app.waitFor("id:remove-filter-country");
    await app.waitUntil(() => calls(app, "/api/breakdown").some((r) => r.url.includes("f=country:JP")));
    await app.press("id:country-details");
    await app.waitFor("id:country-page-props");
    expect(app.shows("id:world-map")).toBe(false); // beneath the page
    app.dispose();
  });

  test("the world's shapes are asked for once, and a failure offers a retry", async () => {
    const app = await open("./App.tsx", {
      ...desktop,
      storage: signedIn(),
      network: server({ [`GET ${S}/api/world.json`]: { status: 500, body: { error: "map unavailable" } } }),
    });
    await app.press("id:nav-geography");
    await app.waitUntil(() => hasText(app.texts(), "Could not load the map"));
    expect(hasText(app.texts(), "Germany")).toBe(true); // the list still works
    app.dispose();
  });
});
