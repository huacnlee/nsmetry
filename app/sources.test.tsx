/** Sources: referrers with direct visits named, UTM tabs, a row adding a filter, the source's detail page. */
import { describe, expect, open, test } from "nsh/test";
import { desktop, hasText, server, signedIn } from "./fixtures/insights-server";

describe("sources screen", () => {
  test("referrers, then a campaign tab; a campaign row filters and opens its details", async () => {
    const app = await open("./App.tsx", { ...desktop, storage: signedIn(), network: server() });
    await app.press("id:nav-sources");
    await app.waitFor("text:news.ycombinator.com");
    expect(hasText(app.texts(), "Direct / none")).toBe(true);
    expect(app.shows("id:source-details")).toBe(false);
    await app.press("role:tab[Campaign]");
    await app.waitFor("text:autumn-launch");
    await app.press("role:button[autumn-launch, 60]");
    await app.waitFor("id:remove-filter-utm_campaign");
    await app.press("id:source-details");
    await app.waitFor("id:source-page-props");
    expect(app.shows("text:autumn-launch")).toBe(true); // the page's title
    expect(hasText(app.texts(), "Landing pages")).toBe(true);
    app.dispose();
  });
});
