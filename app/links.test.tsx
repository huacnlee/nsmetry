/**
 * NsMetry's website and GitHub: both open from the account menu when signed in and from below the
 * sign-in card when signed out. The test records the URLs; nothing opens.
 */
import { expect, open, test } from "nsh/test";

const S = "https://stats.test";
const owner = { id: 1, email: "owner@example.com", role: "owner", created_at: 0, siteIds: [] };
const network = {
  [`GET ${S}/api/me`]: { body: { user: owner, trackerUrl: `${S}/t.js`, version: "0.4.0", update: null } },
  [`GET ${S}/api/sites`]: { body: { sites: [] } },
};
const storage = { server: S, [`session:${S}`]: JSON.stringify({ token: "tok-1", user: owner }) };
const website = "https://huacnlee.github.io/nsmetry/";
const github = "https://github.com/huacnlee/nsmetry";

test("the account menu opens the website and GitHub", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "web", network, storage });
  await app.press("id:account");
  await app.press("id:open-website");
  await app.press("id:account");
  await app.press("id:open-github");
  expect(app.openedUrls()).toEqual([website, github]);
  app.dispose();
});

test("the sign-in screen links to the website and GitHub", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "web" });
  await app.waitFor("id:send-code");
  await app.press("id:signin-website");
  await app.press("id:signin-github");
  expect(app.openedUrls()).toEqual([website, github]);
  app.dispose();
});
