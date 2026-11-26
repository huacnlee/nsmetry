/**
 * Agents, headless against a fake instance: connected grants are listed and push their page, a
 * disconnect asks first and deletes the grant, an empty account says so, and the connect panel gives
 * this server's MCP URL and a snippet per client.
 */
import { describe, expect, open, test, type StubRequest, type StubResponse } from "nsh/test";

const S = "https://stats.test";
const owner = { id: 1, email: "owner@example.com", role: "owner", created_at: 0, siteIds: [] };
const now = Math.floor(Date.now() / 1000);
const grant = { id: "g1", client_name: "Claude Code", created_at: now - 3 * 86_400, last_used_at: now - 7200 };

type Routes = Record<string, StubResponse | ((r: StubRequest) => StubResponse)>;

function server(over: Routes = {}): Routes {
  return {
    [`GET ${S}/api/me`]: { body: { user: owner, trackerUrl: "", version: "0.3.0", update: null } },
    [`GET ${S}/api/sites`]: { body: { sites: [{ id: 7, domain: "example.com", created_at: 0 }] } },
    [`GET ${S}/api/oauth/grants`]: { body: { grants: [grant] } },
    [`GET ${S}/api/breakdown*`]: { body: { breakdowns: {} } },
    ...over,
  };
}
const storage = { server: S, [`session:${S}`]: JSON.stringify({ token: "tok", user: owner }) };
const wide = { width: 1280, height: 900, platform: "macos" } as const;
const hasText = (texts: string[], part: string) => texts.some((t) => t.includes(part));

async function openAgents(over: Routes = {}) {
  const a = await open("./App.tsx", { ...wide, storage, network: server(over) });
  await a.waitFor("id:nav-agents");
  await a.press("id:nav-agents");
  await a.waitFor("id:screen-agents");
  return a;
}

describe("agents", () => {
  test("a grant is listed with when it connected and was last used; disconnect asks, then deletes", async () => {
    const a = await openAgents({ [`DELETE ${S}/api/oauth/grants/g1`]: { body: { ok: true } } });
    await a.waitFor("id:grants-table");
    expect(hasText(a.texts(), "Claude Code")).toBe(true);
    expect(hasText(a.texts(), "2h ago")).toBe(true);
    await a.press("role:button[Open Claude Code]");
    await a.waitFor("id:grant-disconnect");
    expect(hasText(a.texts(), "Read only")).toBe(true);
    await a.press("id:grant-disconnect");
    await a.waitFor("id:disconnect-dialog-confirm");
    expect(hasText(a.texts(), "Disconnect Claude Code?")).toBe(true);
    await a.press("id:disconnect-dialog-confirm");
    await a.waitUntil(() => a.requests().some((r) => r.method === "DELETE" && r.url === `${S}/api/oauth/grants/g1`));
    // The page pops once the agent is gone, back to the (now empty) list.
    await a.waitUntil(() => !a.shows("id:grant-page"));
    await a.waitFor("id:grants-empty");
    a.dispose();
  });

  test("no agents: the empty state, and the MCP URL to connect one", async () => {
    const a = await openAgents({ [`GET ${S}/api/oauth/grants`]: { body: { grants: [] } } });
    await a.waitFor("id:grants-empty");
    expect(hasText(a.texts(), `${S}/mcp`)).toBe(true);
    expect(hasText(a.texts(), `claude mcp add --transport http nsmetry ${S}/mcp`)).toBe(true);
    await a.press("id:mcp-url-copy");
    await a.waitUntil(() => a.clipboard() === `${S}/mcp`);
    a.dispose();
  });

  test("each client has its own snippet", async () => {
    const a = await openAgents();
    await a.press("id:connect-client-cursor");
    await a.waitFor("id:connect-cursor");
    expect(hasText(a.texts(), `"url": "${S}/mcp"`)).toBe(true);
    await a.press("id:connect-client-claude-desktop");
    await a.waitFor("id:connect-claude-desktop");
    expect(hasText(a.texts(), "mcp-remote")).toBe(true);
    a.dispose();
  });

  test("a failed load offers Try again", async () => {
    let fail = true;
    const a = await openAgents({
      [`GET ${S}/api/oauth/grants`]: () => (fail ? { status: 500, body: { error: "database unavailable" } } : { body: { grants: [grant] } }),
    });
    await a.waitUntil(() => hasText(a.texts(), "database unavailable"));
    fail = false;
    await a.press("role:button[Try again]");
    await a.waitFor("id:grants-table");
    a.dispose();
  });
});
