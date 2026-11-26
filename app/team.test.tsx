/**
 * Team, headless against a fake instance: the admin sees everyone (admin first), invites an email
 * with a choice of sites, sees a refusal in the server's words, edits a viewer's sites and removes
 * them after a confirmation. A viewer has no Team section at all.
 */
import { describe, expect, open, test, type StubRequest, type StubResponse } from "nsh/test";

const S = "https://stats.test";
interface User { id: number; email: string; role: string; created_at: number; siteIds: number[] }
const owner: User = { id: 1, email: "owner@example.com", role: "owner", created_at: 1_700_000_000, siteIds: [] };
const grace: User = { id: 2, email: "grace@example.com", role: "viewer", created_at: 1_700_000_000, siteIds: [7] };
const sites = [{ id: 7, domain: "example.com", created_at: 0 }, { id: 8, domain: "disktree", created_at: 0 }];

type Routes = Record<string, StubResponse | ((r: StubRequest) => StubResponse)>;

function server(user = owner, over: Routes = {}): Routes {
  return {
    [`GET ${S}/api/me`]: { body: { user, trackerUrl: "", version: "0.3.0", update: null } },
    [`GET ${S}/api/sites`]: { body: { sites } },
    [`GET ${S}/api/users`]: { body: { users: [owner, grace] } },
    [`GET ${S}/api/breakdown*`]: { body: { breakdowns: {} } },
    ...over,
  };
}
const signedIn = (user = owner) => ({ server: S, [`session:${S}`]: JSON.stringify({ token: "tok", user }) });
const wide = { width: 1280, height: 900, platform: "macos" } as const;
const hasText = (texts: string[], part: string) => texts.some((t) => t.includes(part));
const bodyOf = (r: StubRequest | undefined) => JSON.parse(r?.body ?? "{}");

async function openTeam(over: Routes = {}) {
  const a = await open("./App.tsx", { ...wide, storage: signedIn(), network: server(owner, over) });
  await a.waitFor("id:nav-team");
  await a.press("id:nav-team");
  await a.waitFor("id:team-table");
  await a.waitFor("text:grace@example.com");
  return a;
}

describe("team", () => {
  test("lists the admin and the viewers, with their sites", async () => {
    const a = await openTeam();
    expect(hasText(a.texts(), "owner@example.com")).toBe(true);
    expect(hasText(a.texts(), "All sites")).toBe(true);
    // A viewer with one site shows that site's name.
    expect(a.count("text:example.com")).toBeGreaterThan(0);
    expect(a.shows("id:team-empty")).toBe(false);
    a.dispose();
  });

  test("invite an email with a site; the person appears", async () => {
    const a = await openTeam({
      [`POST ${S}/api/users`]: (r) => ({ body: { user: { id: 3, email: bodyOf(r).email, role: "viewer", created_at: 1_700_000_100, siteIds: bodyOf(r).siteIds } } }),
    });
    await a.press("id:invite");
    await a.waitFor("id:invite-email");
    await a.type("id:invite-email", "linus@example.com");
    await a.press("id:invite-sites-8");
    await a.press("id:invite-submit");
    await a.waitFor("text:linus@example.com");
    const post = a.requests().find((r) => r.method === "POST" && r.url === `${S}/api/users`);
    expect(bodyOf(post)).toEqual({ email: "linus@example.com", siteIds: [8] });
    expect(hasText(a.texts(), "tell them to sign in at")).toBe(true);
    a.dispose();
  });

  test("an invite refused is explained in the dialog", async () => {
    const a = await openTeam({ [`POST ${S}/api/users`]: { status: 409, body: { error: "that email is already invited" } } });
    await a.press("id:invite");
    await a.type("id:invite-email", "grace@example.com");
    await a.press("id:invite-submit");
    await a.waitUntil(() => hasText(a.texts(), "already invited"));
    expect(a.shows("id:invite-email")).toBe(true);
    a.dispose();
  });

  test("edit a viewer's sites, then remove them after confirming", async () => {
    const a = await openTeam({
      [`PATCH ${S}/api/users/2`]: (r) => ({ body: { user: { ...grace, siteIds: bodyOf(r).siteIds } } }),
      [`DELETE ${S}/api/users/2`]: { body: { ok: true } },
    });
    await a.press("role:button[Open grace@example.com]");
    await a.waitFor("id:person-sites");
    expect(a.enabled("id:person-save")).toBe(false);
    await a.press("id:person-sites-8");
    await a.press("id:person-save");
    await a.waitUntil(() => a.requests().some((r) => r.method === "PATCH"));
    expect(bodyOf(a.requests().find((r) => r.method === "PATCH"))).toEqual({ siteIds: [7, 8] });
    await a.press("id:person-remove");
    await a.waitFor("id:remove-person-dialog-confirm");
    await a.press("id:remove-person-dialog-confirm");
    await a.waitUntil(() => a.requests().some((r) => r.method === "DELETE" && r.url === `${S}/api/users/2`));
    await a.waitUntil(() => !a.shows("id:person-page"));
    await a.waitUntil(() => !hasText(a.texts(), "grace@example.com") || a.shows("id:team-empty"));
    await a.waitFor("id:team-empty");
    a.dispose();
  });

  test("the admin's own page has nothing to edit", async () => {
    const a = await openTeam();
    await a.press("role:button[Open owner@example.com]");
    await a.waitUntil(() => hasText(a.texts(), "The administrator reads every site"));
    expect(a.shows("id:person-remove")).toBe(false);
    a.dispose();
  });
});

test("a viewer has no Team section", async () => {
  const a = await open("./App.tsx", { ...wide, storage: signedIn(grace), network: server(grace) });
  await a.waitFor("id:nav-settings");
  expect(a.shows("id:nav-team")).toBe(false);
  expect(a.requests().some((r) => r.url === `${S}/api/users`)).toBe(false);
  a.dispose();
});
