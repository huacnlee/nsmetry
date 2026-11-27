/**
 * Headless tests of the foundation: sign-in against a fake server (NSH's network stubs stand in for
 * the transport, so the real `fetchTransport` and API client run), the move to signed-out on a 401,
 * adding and removing a shared filter, and switching the range.
 */
import { describe, expect, open, test, type StubRequest, type StubResponse } from "nsh/test";

const S = "https://stats.test";
const owner = { id: 1, email: "owner@example.com", role: "owner", created_at: 0, siteIds: [] };
const site = { id: 7, domain: "example.com", created_at: 0 };

type Routes = Record<string, StubResponse | ((r: StubRequest) => StubResponse)>;

/** A fake NsMetry instance; `over` replaces routes per test. */
function server(over: Routes = {}): Routes {
  return {
    [`POST ${S}/api/auth/start`]: { body: { ok: true, delivery: "email" } },
    [`POST ${S}/api/auth/verify`]: (r) =>
      JSON.parse(r.body ?? "{}").code === "123456"
        ? { body: { token: "tok-1", user: owner } }
        : { status: 401, body: { error: "that code is not right" } },
    [`POST ${S}/api/auth/logout`]: { body: { ok: true } },
    [`GET ${S}/api/me`]: { body: { user: owner, trackerUrl: `${S}/t.js`, version: "0.3.0", update: null } },
    [`GET ${S}/api/sites`]: { body: { sites: [site] } },
    [`GET ${S}/api/breakdown*`]: {
      body: {
        breakdowns: {
          path: [{ name: "/", value: 120 }, { name: "/pricing", value: 60 }],
          entry: [{ name: "/", value: 100 }],
          country: [{ name: "DE", value: 50 }, { name: "JP", value: 20 }],
        },
      },
    },
    ...over,
  };
}

/** Storage of an app that signed in to `S` before. */
const signedIn = (token = "tok-1") => ({
  server: S,
  [`session:${S}`]: JSON.stringify({ token, user: owner }),
});

const hasText = (texts: string[], part: string) => texts.some((t) => t.includes(part));

describe("sign-in", () => {
  test("email, code, signed in; the token is kept for the server and sent as a bearer", async () => {
    const app = await open("./App.tsx", { network: server() });
    await app.waitFor("id:send-code");
    await app.type("id:server", "stats.test");
    await app.type("id:email", "owner@example.com");
    await app.press("id:send-code");
    await app.waitFor("id:code");
    expect(hasText(app.texts(), "We sent a sign-in code")).toBe(true);
    await app.type("id:code", "123456");
    await app.press("id:verify");
    await app.waitFor("id:screen-overview");
    expect(app.storage()[`session:${S}`]).toContain("tok-1");
    expect(app.storage().server).toBe(S);
    const me = app.requests().find((r) => r.url === `${S}/api/me`);
    expect(me?.headers.authorization).toBe("Bearer tok-1");
    app.dispose();
  });

  test("an 8-character code goes into cells, upper-cased, and signs in as soon as the last one fills", async () => {
    const letters = server({
      [`POST ${S}/api/auth/start`]: { body: { ok: true, delivery: "email", codeLength: 8 } },
      [`POST ${S}/api/auth/verify`]: (r) =>
        JSON.parse(r.body ?? "{}").code === "AB2CDE34"
          ? { body: { token: "tok-1", user: owner } }
          : { status: 401, body: { error: "that code is not right" } },
    });
    const app = await open("./App.tsx", { network: letters, storage: { server: S } });
    await app.type("id:email", "owner@example.com");
    await app.press("id:send-code");
    await app.waitFor("id:code");
    await app.type("id:code", "ab2-cde34");
    await app.waitFor("id:screen-overview");
    const verify = app.requests().find((r) => r.url === `${S}/api/auth/verify`);
    expect(JSON.parse(verify?.body ?? "{}").code).toBe("AB2CDE34");
    app.dispose();
  });

  test("a server's digits-only code (0.1.2, 0.1.3) goes into digit cells", async () => {
    const digits = server({
      [`POST ${S}/api/auth/start`]: { body: { ok: true, delivery: "email", codeDigits: 8 } },
      [`POST ${S}/api/auth/verify`]: (r) =>
        JSON.parse(r.body ?? "{}").code === "12345678"
          ? { body: { token: "tok-1", user: owner } }
          : { status: 401, body: { error: "that code is not right" } },
    });
    const app = await open("./App.tsx", { network: digits, storage: { server: S } });
    await app.type("id:email", "owner@example.com");
    await app.press("id:send-code");
    await app.waitFor("id:code");
    await app.type("id:code", "1234abcd5678");
    await app.waitFor("id:screen-overview");
    app.dispose();
  });

  test("a wrong code says so and empties the cells for another try", async () => {
    const app = await open("./App.tsx", {
      storage: { server: S },
      network: server({ [`POST ${S}/api/auth/start`]: { body: { ok: true, delivery: "email", codeLength: 8 } } }),
    });
    await app.type("id:email", "owner@example.com");
    await app.press("id:send-code");
    await app.waitFor("id:code");
    await app.type("id:code", "AAAAAAAA");
    await app.waitUntil(() => hasText(app.texts(), "that code is not right"));
    expect(app.shows("id:screen-overview")).toBe(false);
    // The cells were emptied: a fresh code fills them again and goes out as a second try.
    await app.type("id:code", "BBBBBBBB");
    await app.waitUntil(() => app.requests().filter((r) => r.url === `${S}/api/auth/verify`).length === 2);
    const tries = app.requests().filter((r) => r.url === `${S}/api/auth/verify`).map((r) => JSON.parse(r.body ?? "{}").code);
    expect(tries).toEqual(["AAAAAAAA", "BBBBBBBB"]);
    app.dispose();
  });

  test("a wrong code says so and stays on the code step", async () => {
    const app = await open("./App.tsx", { network: server(), storage: { server: S } });
    await app.type("id:email", "owner@example.com");
    await app.press("id:send-code");
    await app.waitFor("id:code");
    await app.type("id:code", "000000");
    await app.press("id:verify");
    await app.waitUntil(() => hasText(app.texts(), "that code is not right"));
    expect(app.shows("id:screen-overview")).toBe(false);
    app.dispose();
  });

  test("403: not invited", async () => {
    const app = await open("./App.tsx", {
      storage: { server: S },
      network: server({ [`POST ${S}/api/auth/start`]: { status: 403, body: { error: "this email has not been invited to this instance" } } }),
    });
    await app.type("id:email", "stranger@example.com");
    await app.press("id:send-code");
    await app.waitUntil(() => hasText(app.texts(), "has not been invited"));
    expect(app.shows("id:code")).toBe(false);
    app.dispose();
  });

  test("429: rate limited, in the server's words", async () => {
    const app = await open("./App.tsx", {
      storage: { server: S },
      network: server({ [`POST ${S}/api/auth/start`]: { status: 429, body: { error: "Wait a minute before asking for another code." } } }),
    });
    await app.type("id:email", "owner@example.com");
    await app.press("id:send-code");
    await app.waitUntil(() => hasText(app.texts(), "Wait a minute before asking for another code."));
    app.dispose();
  });

  test("no mail configured: the code is in the Worker logs", async () => {
    const app = await open("./App.tsx", {
      storage: { server: S },
      network: server({
        [`POST ${S}/api/auth/start`]: { body: { ok: true, delivery: "log", message: "Read it with `wrangler tail`." } },
      }),
    });
    await app.type("id:email", "owner@example.com");
    await app.press("id:send-code");
    await app.waitFor("id:code");
    expect(hasText(app.texts(), "the code is in your Worker logs")).toBe(true);
    app.dispose();
  });

  test("an unreachable server says it could not be reached", async () => {
    const app = await open("./App.tsx", {
      storage: { server: S },
      network: server({ [`POST ${S}/api/auth/start`]: { error: "connection refused" } }),
    });
    await app.type("id:email", "owner@example.com");
    await app.press("id:send-code");
    await app.waitUntil(() => hasText(app.texts(), "Could not reach"));
    app.dispose();
  });
});

describe("session", () => {
  test("a 401 moves the app to signed-out and forgets the token", async () => {
    const app = await open("./App.tsx", {
      storage: signedIn("expired"),
      network: server({ [`GET ${S}/api/me`]: { status: 401, body: { error: "sign in again" } } }),
    });
    await app.waitFor("id:send-code");
    expect(hasText(app.texts(), "Your session expired")).toBe(true);
    await app.waitUntil(() => app.storage()[`session:${S}`] === undefined);
    // The server is kept: signing in again goes to the same instance.
    expect(app.storage().server).toBe(S);
    app.dispose();
  });

  test("a restored session opens the shell; sign out returns to sign-in", async () => {
    const app = await open("./App.tsx", { storage: signedIn(), network: server() });
    await app.waitFor("id:screen-overview");
    await app.press("id:account");
    await app.press("id:sign-out");
    await app.waitFor("id:send-code");
    expect(app.requests().some((r) => r.method === "POST" && r.url === `${S}/api/auth/logout`)).toBe(true);
    expect(app.storage()[`session:${S}`]).toBeUndefined();
    app.dispose();
  });
});

describe("shared state", () => {
  const breakdowns = (app: { requests(): StubRequest[] }) => app.requests().filter((r) => r.url.startsWith(`${S}/api/breakdown`));

  test("pressing a row adds a filter every request carries; its chip removes it", async () => {
    const app = await open("./fixtures/breakdown.fixture.tsx", { storage: signedIn(), network: server() });
    await app.waitFor("text:/pricing");
    expect(app.shows("id:filters")).toBe(false);
    await app.press("text:/pricing");
    await app.waitFor("id:remove-filter-path");
    await app.waitUntil(() => breakdowns(app).some((r) => r.url.includes("f=path:%2Fpricing")));
    await app.press("id:remove-filter-path");
    await app.waitUntil(() => !app.shows("id:filters"));
    const last = breakdowns(app).at(-1)!;
    expect(last.url.includes("f=")).toBe(false);
    app.dispose();
  });

  test("a + Country chip loads values and adds the picked one", async () => {
    const app = await open("./fixtures/breakdown.fixture.tsx", { storage: signedIn(), network: server() });
    await app.waitFor("text:/pricing");
    await app.press("id:add-filter-country");
    await app.waitFor("role:button[JP]");
    await app.press("role:button[JP]");
    await app.waitFor("id:remove-filter-country");
    expect(app.shows("id:add-filter-country")).toBe(false);
    await app.waitUntil(() => breakdowns(app).some((r) => r.url.includes("f=country:JP")));
    app.dispose();
  });

  test("switching the range reloads with the new range and remembers it", async () => {
    const app = await open("./fixtures/breakdown.fixture.tsx", { storage: signedIn(), network: server() });
    await app.waitFor("text:/pricing");
    expect(breakdowns(app).at(-1)!.url).toContain("range=7d");
    await app.press("id:range-30d");
    await app.waitUntil(() => breakdowns(app).some((r) => r.url.includes("range=30d")));
    await app.waitUntil(() => (app.storage()[`prefs:${S}`] ?? "").includes('"range":"30d"'));
    app.dispose();
  });

  test("compare adds cmp=1", async () => {
    const app = await open("./fixtures/breakdown.fixture.tsx", { storage: signedIn(), network: server() });
    await app.waitFor("text:/pricing");
    await app.press("id:compare");
    await app.waitUntil(() => breakdowns(app).some((r) => r.url.includes("cmp=1")));
    app.dispose();
  });
});
