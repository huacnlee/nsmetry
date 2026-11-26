/** The site switcher's trigger always names the site being viewed, the one checked in its menu. */
import { expect, open, test } from "nsh/test";

const S = "https://stats.test";
const owner = { id: 1, email: "owner@example.com", role: "owner", created_at: 0, siteIds: [] };
const sites = [
  { id: 1, domain: "nsvim", created_at: 0 },
  { id: 2, domain: "nsmetry", created_at: 0 },
  { id: 3, domain: "noop", created_at: 0 },
];
const network = {
  [`GET ${S}/api/me`]: { body: { user: owner, trackerUrl: `${S}/t.js`, version: "0.1.0", update: null } },
  [`GET ${S}/api/sites`]: { body: { sites } },
};
const storage = { server: S, [`session:${S}`]: JSON.stringify({ token: "tok-1", user: owner }), [`prefs:${S}`]: JSON.stringify({ site: 1, range: "7d", compare: false }) };

test("choosing a site renames the trigger", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "web", network, storage });
  await app.waitFor("id:site-switcher");
  expect(app.accessibility("id:site-switcher")?.label).toContain("nsvim");
  await app.press("id:site-switcher");
  await app.press("id:site-row-3");
  await app.waitUntil(() => (app.accessibility("id:site-switcher")?.label ?? "").includes("noop"));
  await app.press("id:site-switcher");
  await app.press("id:site-row-2");
  await app.waitUntil(() => (app.accessibility("id:site-switcher")?.label ?? "").includes("nsmetry"), { timeout: 2000 });
  app.dispose();
});

test("after adding a site, choosing another still renames the trigger", async () => {
  let list = sites.slice(0, 2);
  const app = await open("./App.tsx", {
    width: 1280, height: 800, platform: "web", storage,
    network: {
      ...network,
      [`GET ${S}/api/sites`]: () => ({ body: { sites: list } }),
      [`POST ${S}/api/sites`]: () => {
        list = sites;
        return { body: { site: sites[2] } };
      },
    },
  });
  await app.waitFor("id:site-switcher");
  await app.press("id:site-switcher");
  await app.press("id:add-site");
  await app.waitFor("id:add-site-submit");
  await app.type("text:example.com", "noop");
  await app.press("id:add-site-submit");
  await app.waitUntil(() => (app.accessibility("id:site-switcher")?.label ?? "").includes("noop"));
  // Adding a site goes on to its install prompts.
  await app.waitFor("id:install-any");
  // Opened right after adding, the menu checks the new site, not the one viewed before.
  await app.press("id:site-switcher");
  await app.waitFor("id:site-row-3");
  expect(String(app.accessibility("id:site-row-3")?.checked)).toBe("true");
  expect(String(app.accessibility("id:site-row-1")?.checked)).toBe("false");
  await app.press("id:site-row-2");
  await app.waitUntil(() => (app.accessibility("id:site-switcher")?.label ?? "").includes("nsmetry"), { timeout: 2000 });
  // The menu, opened again, checks the site the trigger names and nothing else.
  await app.press("id:site-switcher");
  await app.waitFor("id:site-row-2");
  expect(String(app.accessibility("id:site-row-2")?.checked)).toBe("true");
  expect(String(app.accessibility("id:site-row-3")?.checked)).toBe("false");
  app.dispose();
});
