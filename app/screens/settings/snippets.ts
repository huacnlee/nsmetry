/**
 * The install instructions the Settings screen shows, as plain strings built from this instance and
 * the current site. Pure functions, so tests can read them and every tab says the same thing.
 *
 * Everything here restates docs/api.md ("Ingest") and docs/sdk.md; when those change, change this.
 * The rules an app must follow to stay inside Cloudflare's free plan (batches of at most 50, one flush
 * per ~30 s or on background) are spelled out in every tab that sends events, because a client that
 * sends one request per event is the one thing that can exhaust the instance's daily budget.
 */

export interface InstallTarget {
  /** The instance's origin, no trailing slash (`https://stats.example.com`). */
  server: string;
  /** The site key as registered: a domain (`example.com`) or a bare name (`disktree`). */
  site: string;
  /** The tracker script's URL: the admin's override, or `<server>/em.js`. */
  trackerSrc: string;
}

/** A site key that looks like a hostname is probably a website; a bare name is probably an app. */
export const looksLikeDomain = (site: string) => site.includes(".");

/** The tracker's default URL on an instance: the Worker serves it from its own origin as `em.js`. */
export const defaultTrackerSrc = (server: string) => `${server}/em.js`;

/** A placeholder for the server while none is known (a test, an app not yet pointed anywhere). */
export const serverOr = (server: string) => server || "https://stats.example.com";

/** The `ua` an example sends: the app's name from its site key, so the snippet is ready to edit. */
function appName(site: string) {
  const base = site.split(".")[0] || "MyApp";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// ------------------------------------------------------------------------------------- website

export const websiteSnippet = (t: InstallTarget) => `<script defer src="${t.trackerSrc}" data-domain="${t.site}"></script>`;

/** Run once in the browser console on the site: the tracker then skips this browser. */
export const ignoreSnippet = `localStorage.setItem('em-ignore', '1')`;

// ------------------------------------------------------------------------------------- HTTP API

export function curlEvent(t: InstallTarget): string {
  const body = JSON.stringify({
    site: t.site,
    name: "screen_view",
    url: "/settings",
    user_id: "6f1c2a90-3b1e-4d7a-9c55-2f0e8b1d4a77",
    app_version: "1.0.0",
    ua: `${appName(t.site)}/1.0.0 (macOS 15.1)`,
  });
  return `curl -X POST ${serverOr(t.server)}/api/event \\\n  -H 'content-type: text/plain' \\\n  -d '${body}'`;
}

export function curlBatch(t: InstallTarget): string {
  const common = { user_id: "6f1c2a90-3b1e-4d7a-9c55-2f0e8b1d4a77", app_version: "1.0.0", ua: `${appName(t.site)}/1.0.0 (iPhone; iOS 18.1; Mobile)` };
  const events = [
    { name: "screen_view", url: "/inbox", ...common },
    { name: "export", url: "/inbox", ...common, props: { format: "csv", rows: 120 } },
  ];
  const lines = events.map((e) => `    ${JSON.stringify(e)}`).join(",\n");
  return `curl -X POST ${serverOr(t.server)}/api/events/batch \\\n  -H 'content-type: text/plain' \\\n  -d '{\n  "site": "${t.site}",\n  "events": [\n${lines}\n  ]\n}'`;
}

/** The rules every HTTP client follows, one per line (shown as a list). */
export const httpRules: readonly string[] = [
  "At most 50 events per batch. Flush every ~30 s while events wait, and when the app goes to the background.",
  "204 means stored. 400 (malformed) and 404 (unknown site) will fail again: drop the batch. Retry 429, 5xx and network errors with backoff.",
  "user_id: a random id made once per install and kept. Never an email or account id; the server hashes it per site.",
  "Native apps always send ua (\"MyApp/1.2.3 (macOS 15.1)\"): the OS and device come from it.",
  "props: flat, at most 10 keys, string / number / boolean values, strings up to 100 characters.",
  "ts (unix seconds) is honoured within the current UTC day; screen_view and pageview count as views.",
];

// ------------------------------------------------------------------------------------- NSH app

export const nshAdd = "nsh add nsmetry";

export function nshUsage(t: InstallTarget): string {
  return [
    `import { createNsMetry, useNsMetry, useScreenTracking } from "nsmetry";`,
    `export const nsmetry = createNsMetry({ endpoint: "${serverOr(t.server)}", site: "${t.site}", persistUserId: true });`,
    `useNsMetry(nsmetry);                                  // in the root component: flush on background / quit`,
    "useScreenTracking(nsmetry, () => `/${tab()}`);       // a screen view whenever the path changes",
    `nsmetry.track("export", { format: "csv" });          // a custom event, anywhere`,
  ].join("\n");
}

// ------------------------------------------------------------------------------------- JavaScript

export const npmInstall = "npm install nsmetry";

export function jsUsage(t: InstallTarget): string {
  return [
    `import { createNsMetry } from "nsmetry";`,
    ``,
    `const nsmetry = createNsMetry({`,
    `  endpoint: "${serverOr(t.server)}",`,
    `  site: "${t.site}",`,
    `  appVersion: "1.0.0",`,
    `  persistUserId: true, // an anonymous install id: active users and retention`,
    `});`,
    ``,
    `nsmetry.screen("/settings");                // a screen or page view`,
    `nsmetry.track("export", { format: "csv" }); // a custom event`,
  ].join("\n");
}

// ------------------------------------------------------------------------------------- AI agent

/**
 * A prompt a coding agent (Claude Code, Codex, Cursor) can follow to instrument a project with this
 * instance. It carries everything the agent cannot know: the endpoint, the site key, the budget rules
 * and the privacy rules, and how to check the result without polluting the data.
 */
export function agentPrompt(t: InstallTarget): string {
  const server = serverOr(t.server);
  return `Add privacy-first analytics to this project with NsMetry, a self-hosted instance.

Instance: ${server}
Site key: ${t.site}  (send it exactly as "site"; it is already registered)

1. Pick the client for this project:
   - NSH app (nsh.json present): run \`nsh add nsmetry\`, then
     createNsMetry({ endpoint: "${server}", site: "${t.site}", persistUserId: true }),
     call useNsMetry(client) and useScreenTracking(client, <reactive path>) in the root component.
   - JavaScript / TypeScript (browser app, Node, Electron, React Native, Workers): \`npm install nsmetry\`,
     same createNsMetry options; on React Native pass AsyncStorage as storage and flush when AppState leaves "active".
   - A website only: add <script defer src="${t.trackerSrc}" data-domain="${t.site}"></script> to <head>; it counts page views by itself.
   - Any other language: POST JSON to ${server}/api/events/batch as
     {"site":"${t.site}","events":[{"name":"screen_view","url":"/path","ts":<unix s>,"user_id":"…","app_version":"…","ua":"…","props":{…}}]}
     with Content-Type text/plain. Write a small queue like the SDKs' (see the rules below).

2. Batching (the instance runs on Cloudflare's free plan; requests are the budget):
   - Queue events in memory. Send at most 50 per request to /api/events/batch.
   - Flush every ~30 seconds while events are waiting, as soon as 50 are queued, and when the app goes to the background or quits. Never one request per event; never a timer that fires when the queue is empty.
   - 204 = stored. 400 or 404 = drop the batch (404 means the site key is wrong). Retry 429, 5xx and network errors with exponential backoff. Keep at most 1000 queued events, dropping the oldest.

3. What to send:
   - A "screen_view" with url "/<screen>" for each screen or route. Keep ids out of paths ("/message", not "/message/8812").
   - Custom events only for things worth reading later: a finished export, a purchase, an error. snake_case names.
   - props: flat, at most 10 keys, string / number / boolean values, strings up to 100 characters.
   - app_version: the app's own version. Native apps: ua like "AppName/1.2.3 (macOS 15.1)" or "AppName/1.2.3 (iPhone; iOS 18.1; Mobile)"; never include the words bot, monitor, preview or scanner.

4. user_id:
   - A random UUID generated once per install and persisted (the SDKs do this with persistUserId: true).
   - Never an email, account id, phone number, device serial or advertising id. The server hashes it per site and never stores it raw.

5. Privacy rules:
   - No personal data anywhere: no emails, names, IP addresses, tokens, file names, search text or other free text in event names, paths or props.
   - No cookies and no fingerprinting. If the app has an analytics opt-out, call setEnabled(false) when it is off.

6. Verify:
   - Typecheck and run the project's tests.
   - Run the app, open two or three screens, then send it to the background (or call flush()). Confirm the request to ${server}/api/events/batch answered 204 (a 404 means the site key is wrong).
   - The events appear in the NsMetry app under Pages and Events for "${t.site}" within a minute. If the NsMetry MCP server (${server}/mcp) is connected, call get_breakdown for this site with dim "event" to check.
   - Do not send test events to check the endpoint: they would stay in the numbers.

Report which files you changed, which screens and events are tracked, and where the user id is stored.`;
}
