/**
 * The shell's navigation controls: "More" on the phone tab bar is a button beside the tab list (not
 * a tab, so arrow keys never open its sheet), the range picker's segments are never narrower than
 * their labels at phone width, and the sidebar's site switcher shares the nav items' left edge.
 */
import { expect, open, test } from "nsh/test";

const S = "https://stats.test";
const owner = { id: 1, email: "owner@example.com", role: "owner", created_at: 0, siteIds: [] };
const network = {
  [`GET ${S}/api/me`]: { body: { user: owner, trackerUrl: `${S}/t.js`, version: "0.3.0", update: null } },
  [`GET ${S}/api/sites`]: { body: { sites: [{ id: 7, domain: "example.com", created_at: 0 }] } },
};
const storage = { server: S, [`session:${S}`]: JSON.stringify({ token: "tok-1", user: owner }) };

test("on a phone, More is a button outside the tab list and opens the sheet", async () => {
  const app = await open("./App.tsx", { width: 390, height: 844, platform: "ios", network, storage });
  await app.waitFor("id:tab-more");
  expect(app.accessibility("id:tab-more")?.role).toBe("button");
  expect(app.accessibility("id:tab-overview")?.role).toBe("tab");
  expect(app.accessibility("id:tab-overview")?.selected).toBe(true);
  await app.press("id:tab-users");
  await app.waitFor("id:screen-users");
  expect(app.shows("id:more-settings")).toBe(false);
  await app.press("id:tab-more");
  await app.waitFor("id:more-settings");
  app.dispose();
});

test("at 390pt the range segments fit their labels and the window", async () => {
  const app = await open("./App.tsx", { width: 390, height: 844, platform: "ios", network, storage });
  await app.waitFor("id:range-today");
  let right = 0;
  for (const r of ["today", "7d", "30d", "90d", "12mo"]) {
    const box = app.layout(`id:range-${r}`)!;
    expect(box.width).toBeGreaterThanOrEqual(40);
    right = Math.max(right, box.x + box.width);
  }
  expect(right).toBeLessThanOrEqual(390);
  app.dispose();
});

test("the site switcher leads the top bar, right of the sidebar", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos", network, storage });
  await app.waitFor("id:nav-overview");
  const sw = app.layout("id:site-switcher")!;
  const nav = app.layout("id:nav-overview")!;
  const range = app.layout("id:range-today")!;
  expect(sw.x).toBeGreaterThan(nav.x + nav.width); // in the content column, not the sidebar
  expect(sw.x).toBeLessThan(range.x); // leading the top bar, before the range
  expect(Math.abs(sw.y + sw.height / 2 - (range.y + range.height / 2))).toBeLessThanOrEqual(2); // one row
  app.dispose();
});

test("the wide top bar's controls share one vertical center", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "web", network, storage });
  await app.waitFor("id:nav-overview");
  const centers = ["site-switcher", "range", "compare", "account"].map((id) => {
    const b = app.layout(`id:${id}`)!;
    return b.y + b.height / 2;
  });
  for (const c of centers) expect(Math.abs(c - centers[0])).toBeLessThanOrEqual(0.5);
  app.dispose();
});
