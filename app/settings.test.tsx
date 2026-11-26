/**
 * Settings, headless against a fake instance: the install tabs are prefilled with this server and
 * the site key (a domain opens on Website, a bare name on Not sure), copy puts the prompt on the
 * clipboard, the admin's script URL override is saved and refused in the server's words, removing a
 * site asks first, and a viewer sees neither admin control.
 */
import { describe, expect, open, test, type StubRequest, type StubResponse } from "nsh/test";

const S = "https://stats.test";
interface User { id: number; email: string; role: string; created_at: number; siteIds: number[] }
const owner: User = { id: 1, email: "owner@example.com", role: "owner", created_at: 1_700_000_000, siteIds: [] };
const viewer: User = { id: 2, email: "grace@example.com", role: "viewer", created_at: 1_700_000_000, siteIds: [7] };
const web = { id: 7, domain: "example.com", created_at: 0 };
const app = { id: 8, domain: "disktree", created_at: 0 };

type Routes = Record<string, StubResponse | ((r: StubRequest) => StubResponse)>;

function server(user = owner, over: Routes = {}): Routes {
  return {
    [`GET ${S}/api/me`]: { body: { user, trackerUrl: "", version: "0.3.0", update: { current: "0.3.0", latest: "0.4.0", url: "https://example.com/r", behind: true } } },
    [`GET ${S}/api/sites`]: { body: { sites: [web, app] } },
    [`GET ${S}/api/breakdown*`]: { body: { breakdowns: { path: [{ name: "/", value: 3 }], event: [] } } },
    ...over,
  };
}
const signedIn = (user = owner, site = 7) => ({
  server: S,
  [`session:${S}`]: JSON.stringify({ token: "tok", user }),
  [`prefs:${S}`]: JSON.stringify({ site, range: "7d", compare: false }),
});
const wide = { width: 1280, height: 900, platform: "macos" } as const;
const hasText = (texts: string[], part: string) => texts.some((t) => t.includes(part));

async function openSettings(user = owner, site = 7, over: Routes = {}) {
  const a = await open("./App.tsx", { ...wide, storage: signedIn(user, site), network: server(user, over) });
  await a.waitFor("id:nav-settings");
  await a.press("id:nav-settings");
  await a.waitFor("id:screen-settings");
  return a;
}

describe("install", () => {
  test("a domain opens on Website with a prompt carrying the script tag; the site is Live", async () => {
    const a = await openSettings();
    await a.waitFor("id:install-website");
    await a.waitFor("text:Live");
    await a.press("id:copy-prompt-website");
    await a.waitUntil(() => (a.clipboard() ?? "").includes(`<script defer src="${S}/em.js" data-domain="example.com"></script>`));
    expect(a.clipboard() ?? "").toContain("Site key: example.com");
    expect(a.clipboard() ?? "").not.toContain("/api/events/batch"); // a website has no batching to do
    a.dispose();
  });

  test("Other (HTTP) prompts a batch client with the rules", async () => {
    const a = await openSettings();
    await a.press("id:install-tabs-http");
    await a.waitFor("id:install-http");
    await a.press("id:copy-prompt-http");
    await a.waitUntil(() => (a.clipboard() ?? "").includes(`${S}/api/events/batch`));
    expect(a.clipboard() ?? "").toContain("at most 50 per request");
    expect(a.clipboard() ?? "").not.toContain("nsh add nsmetry");
    a.dispose();
  });

  test("a bare name opens on Not sure, which covers every client; NSH and JavaScript narrow it", async () => {
    const a = await openSettings(owner, 8);
    await a.waitFor("id:install-any");
    await a.waitFor("text:Live");
    await a.press("id:copy-prompt-any");
    await a.waitUntil(() => (a.clipboard() ?? "").includes("Site key: disktree"));
    for (const part of ["nsh add nsmetry", "npm install nsmetry", "data-domain=\"disktree\"", "/api/events/batch"]) {
      expect(a.clipboard() ?? "").toContain(part);
    }
    await a.press("id:install-tabs-nsh");
    await a.waitFor("id:install-nsh");
    await a.press("id:copy-prompt-nsh");
    await a.waitUntil(() => (a.clipboard() ?? "").includes(`endpoint: "${S}", site: "disktree"`) && !(a.clipboard() ?? "").includes("npm install"));
    await a.press("id:install-tabs-js");
    await a.waitFor("id:install-js");
    expect(hasText(a.texts(), "npm install nsmetry")).toBe(true);
    a.dispose();
  });

  test("no events in the last week: the pill says so", async () => {
    const a = await openSettings(owner, 7, { [`GET ${S}/api/breakdown*`]: { body: { breakdowns: { path: [], event: [] } } } });
    await a.waitFor("text:No events in 7 days");
    a.dispose();
  });
});

describe("admin", () => {
  test("saving a script URL sends it and updates the snippet", async () => {
    let tracker = "";
    const a = await openSettings(owner, 7, {
      [`GET ${S}/api/me`]: () => ({ body: { user: owner, trackerUrl: tracker, version: "0.3.0", update: null } }),
      [`PUT ${S}/api/settings/tracker-url`]: (r) => {
        tracker = JSON.parse(r.body ?? "{}").url;
        return { body: { trackerUrl: tracker } };
      },
    });
    await a.waitFor("id:tracker-url");
    await a.type("id:tracker-url", "https://cdn.example.com/s.js");
    await a.press("id:tracker-url-save");
    await a.waitUntil(() => hasText(a.texts(), 'src="https://cdn.example.com/s.js" data-domain="example.com"'));
    const put = a.requests().find((r) => r.method === "PUT");
    expect(JSON.parse(put!.body!)).toEqual({ url: "https://cdn.example.com/s.js" });
    a.dispose();
  });

  test("a refused script URL shows the server's reason under the field", async () => {
    const a = await openSettings(owner, 7, {
      [`PUT ${S}/api/settings/tracker-url`]: { status: 400, body: { error: "enter a full URL ending in .js, or leave it empty" } },
    });
    await a.type("id:tracker-url", "https://cdn.example.com/s");
    await a.press("id:tracker-url-save");
    await a.waitUntil(() => hasText(a.texts(), "ending in .js"));
    a.dispose();
  });

  test("remove site asks, then deletes and moves to the next site", async () => {
    let sites = [web, app];
    const a = await openSettings(owner, 7, {
      [`GET ${S}/api/sites`]: () => ({ body: { sites } }),
      [`DELETE ${S}/api/sites/7`]: () => {
        sites = [app];
        return { body: { ok: true } };
      },
    });
    await a.press("id:remove-site");
    await a.waitFor("id:remove-site-dialog-confirm");
    expect(hasText(a.texts(), "Remove example.com?")).toBe(true);
    await a.press("id:remove-site-dialog-confirm");
    await a.waitUntil(() => a.requests().some((r) => r.method === "DELETE" && r.url === `${S}/api/sites/7`));
    await a.waitFor("id:install-any");
    a.dispose();
  });

  test("an update out is shown", async () => {
    const a = await openSettings();
    await a.waitFor("id:update-available");
    expect(hasText(a.texts(), "0.4.0 is out")).toBe(true);
    a.dispose();
  });
});

describe("viewer", () => {
  test("no script URL field and no remove", async () => {
    const a = await openSettings(viewer, 7);
    await a.waitFor("id:install-website");
    expect(a.shows("id:tracker-url")).toBe(false);
    expect(a.shows("id:remove-site")).toBe(false);
    expect(hasText(a.texts(), "Viewer")).toBe(true);
    a.dispose();
  });
});

test("on a phone: Settings is under More, and the install tabs still switch", async () => {
  const a = await open("./App.tsx", { storage: signedIn(owner, 8), network: server() });
  await a.waitFor("id:tab-more");
  await a.press("id:tab-more");
  await a.waitFor("id:more-settings");
  await a.press("id:more-settings");
  await a.waitFor("id:install-any");
  await a.press("id:install-tabs-nsh");
  await a.waitFor("id:install-nsh");
  // Touch targets: the copy button is at least the platform's minimum.
  const box = a.layout("id:copy-prompt-nsh");
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  a.dispose();
});
