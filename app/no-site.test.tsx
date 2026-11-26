/** An instance with no site shows an "Add site" state on the analytics sections instead of loading forever. */
import { expect, open, test } from "nsh/test";

const S = "https://stats.test";
const owner = { id: 1, email: "owner@example.com", role: "owner", created_at: 0, siteIds: [] };
const network = {
  [`GET ${S}/api/me`]: { body: { user: owner, trackerUrl: `${S}/t.js`, version: "0.4.0", update: null } },
  [`GET ${S}/api/sites`]: { body: { sites: [] } },
};
const storage = { server: S, [`session:${S}`]: JSON.stringify({ token: "tok-1", user: owner }) };

test("with no site, Overview offers to add one and the dialog opens", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "web", network, storage });
  await app.waitFor("id:no-site");
  expect(app.shows("id:screen-overview")).toBe(false);
  await app.press("Add site");
  await app.waitFor("id:add-site-submit");
  app.dispose();
});
