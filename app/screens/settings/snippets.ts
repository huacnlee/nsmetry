/**
 * The install prompts the Settings screen shows, built from this instance and the current site. Pure
 * functions, so tests can read them and every tab says the same thing.
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

// ------------------------------------------------------------------------------------- AI agent

/** The kind of client a prompt is written for; `any` lets the agent pick from the project. */
export type PromptKind = "any" | "website" | "js" | "nsh" | "http";

function setupFor(kind: PromptKind, t: InstallTarget, server: string): string {
  const nsh = `   - NSH app (nsh.json present): run \`nsh add nsmetry\`, then
     createNsMetry({ endpoint: "${server}", site: "${t.site}", persistUserId: true }),
     call useNsMetry(client) and useScreenTracking(client, <reactive path>) in the root component.
     With a NavStack, pass navStackPath(nav, (r) => \`/\${r.name}\`) as the path.`;
  const js = `   - JavaScript / TypeScript (browser app, Node, Bun, Deno, Electron, React Native, Workers): \`npm install nsmetry\`, then
     createNsMetry({ endpoint: "${server}", site: "${t.site}", appVersion: <the app's version>, persistUserId: true });
     client.screen("/path") per screen or route, client.track("name", props) for custom events.
     On React Native pass AsyncStorage as storage and flush when AppState leaves "active".`;
  const website = `   - A website: add <script defer src="${t.trackerSrc}" data-domain="${t.site}"></script> to the <head> of every page
     (the layout or template every page shares). It counts page views by itself: no cookies, nothing stored about visitors.
     For a custom event, call window.nsmetry?.("signup") where it happens (a name only; the script sends no props).`;
  const http = `   - Any other language: POST JSON to ${server}/api/events/batch as
     {"site":"${t.site}","events":[{"name":"screen_view","url":"/path","ts":<unix s>,"user_id":"…","app_version":"…","ua":"…","props":{…}}]}
     with Content-Type text/plain. Write a small queue like the SDKs' (the batching rules below).`;
  switch (kind) {
    case "website": return `1. Set it up (this project is a website):\n${website}`;
    case "js": return `1. Set it up (this project is JavaScript / TypeScript):\n${js}`;
    case "nsh": return `1. Set it up (this project is an NSH app):\n${nsh}`;
    case "http": return `1. Set it up (this project has no NsMetry SDK; use the HTTP API):\n${http}`;
    default: return `1. Look at the project and pick the client that fits:\n${nsh}\n${js}\n${website}\n${http}`;
  }
}

/**
 * A prompt a coding agent (Claude Code, Codex, Cursor) follows to instrument a project with this
 * instance: the endpoint, the site key, the budget and privacy rules, and how to check the result.
 * `kind` narrows step 1 to one client; `any` (for someone unsure what the project is) lists them all.
 */
export function agentPrompt(t: InstallTarget, kind: PromptKind = "any"): string {
  const server = serverOr(t.server);
  const website = kind === "website";
  const batching = website ? "" : `
2. Batching (the instance runs on Cloudflare's free plan; requests are the budget):
   - Queue events in memory. Send at most 50 per request to /api/events/batch.
   - Flush every ~30 seconds while events are waiting, as soon as 50 are queued, and when the app goes to the background or quits. Never one request per event; never a timer that fires when the queue is empty.
   - 204 = stored. 400 or 404 = drop the batch (404 means the site key is wrong). Retry 429, 5xx and network errors with exponential backoff. Keep at most 1000 queued events, dropping the oldest.
`;
  const userId = website ? "" : `
4. user_id:
   - A random UUID generated once per install and persisted (the SDKs do this with persistUserId: true).
   - Never an email, account id, phone number, device serial or advertising id. The server hashes it per site and never stores it raw.
`;
  return `Add privacy-first analytics to this project with NsMetry, a self-hosted instance.

Instance: ${server}
Site key: ${t.site}  (send it exactly as "site"; it is already registered)

${setupFor(kind, t, server)}
${batching}
3. What to send:
   - A "screen_view" with url "/<screen>" for each screen or route${website ? " (the script does this for page views)" : ""}. Keep ids out of paths ("/message", not "/message/8812").
   - Custom events only for things worth reading later: a finished export, a purchase, an error. snake_case names.${website ? "" : `
   - props: flat, at most 10 keys, string / number / boolean values, strings up to 100 characters.
   - app_version: the app's own version. Native apps: ua like "AppName/1.2.3 (macOS 15.1)" or "AppName/1.2.3 (iPhone; iOS 18.1; Mobile)"; never include the words bot, monitor, preview or scanner.`}
${userId}
5. Privacy rules:
   - No personal data anywhere: no emails, names, IP addresses, tokens, file names, search text or other free text in event names, paths or props.
   - No cookies and no fingerprinting.${website ? "" : " If the app has an analytics opt-out, call setEnabled(false) when it is off."}

6. Verify:
   - Typecheck and run the project's tests.
   - ${website ? "Open the site, visit two or three pages" : "Run the app, open two or three screens, then send it to the background (or call flush())"}. Confirm the request to ${server} answered 204 (a 404 means the site key is wrong).
   - The events appear in the NsMetry app under Pages and Events for "${t.site}" within a minute. If the NsMetry MCP server (${server}/mcp) is connected, call get_breakdown for this site with dim "path" or "event" to check.
   - Do not send test events to check the endpoint: they would stay in the numbers.

Report which files you changed, which screens and events are tracked${website ? "" : ", and where the user id is stored"}.`.replace(/\n{3,}/g, "\n\n");
}
