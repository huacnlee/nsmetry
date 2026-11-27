/**
 * The install prompts the Settings screen shows, built from this instance and the current site. Pure
 * functions, so tests can read them and every tab says the same thing.
 *
 * The prompts stay short: what to install, the endpoint and site, the few rules an agent would get
 * wrong on its own, and how to check. Everything else (batching, retries, the queue) is the SDK's job
 * and is in its README, which the prompt links. Only the HTTP prompt states the batching rules, since
 * there the agent writes the queue itself; they restate docs/sdk.md ("Any other language").
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

const docs = "https://github.com/huacnlee/nsmetry/blob/main";
const nshDocs = `${docs}/sdk/nsh/README.md`;
const jsDocs = `${docs}/sdk/js/README.md`;
const httpDocs = `${docs}/docs/sdk.md#any-other-language`;

const scriptTag = (t: InstallTarget) => `<script defer src="${t.trackerSrc}" data-domain="${t.site}"></script>`;
const client = (server: string, t: InstallTarget, extra = "") =>
  `createNsMetry({ endpoint: "${server}", site: "${t.site}",${extra} persistUserId: true })`;

/** The rules for anything that sends app events; a website's script follows them by itself. */
const appRules = `Rules:
- One screen view per screen or route. No ids in paths ("/message", not "/message/8812").
- Custom events only for actions worth counting, snake_case names.
- No personal data (emails, names, file names, search text) in event names, paths or props.`;

const verify = (server: string, what: string) =>
  `Verify: ${what}; the request to ${server} should return 204 (404 means the site is wrong). Don't send test events: they stay in the numbers.`;

const verifyApp = (server: string) => verify(server, "run the app, open a few screens and send it to the background");

function websitePrompt(t: InstallTarget, server: string): string {
  return `Add NsMetry analytics to this website.

Add this to the <head> of every page (the layout all pages share):
${scriptTag(t)}

It counts page views by itself, with no cookies. For a custom event, call window.nsmetry?.("signup") where it happens.

${verify(server, "open a few pages")}`;
}

function nshPrompt(t: InstallTarget, server: string): string {
  return `Add NsMetry analytics to this NSH app.

1. Run \`nsh add nsmetry\`.
2. Create one client: ${client(server, t)}
3. In the root component call useNsMetry(client) and useScreenTracking(client, <current path>). With a NavStack, pass navStackPath(nav, (r) => \`/\${r.name}\`).
4. Track custom events with client.track("name", props).

${appRules}

Docs: ${nshDocs}
${verifyApp(server)}`;
}

function jsPrompt(t: InstallTarget, server: string): string {
  return `Add NsMetry analytics to this JavaScript / TypeScript app.

1. Run \`npm install nsmetry\`.
2. Create one client: ${client(server, t, " appVersion: <the app's version>,")}
3. Call client.screen("/path") on each screen or route, client.track("name", props) for custom events.

${appRules}

Docs (React Native, Workers and other runtimes): ${jsDocs}
${verifyApp(server)}`;
}

function httpPrompt(t: InstallTarget, server: string): string {
  return `Add NsMetry analytics to this app over HTTP (there is no SDK for its language).

POST batches to ${server}/api/events/batch:
{"site":"${t.site}","events":[{"name":"screen_view","url":"/settings","ts":<unix seconds>,"user_id":"<random id, made once per install>","app_version":"1.2.3","ua":"AppName/1.2.3 (macOS 15.1)"}]}

Batching: queue events and send at most 50 per request, about every 5 minutes and when the app goes to the background; never one request per event. 204 = stored; drop the batch on 400 or 404; retry 429, 5xx and network errors with backoff.

${appRules}
- user_id is never an email or account id.

Docs (all fields, Swift and Kotlin clients): ${httpDocs}
${verifyApp(server)}`;
}

function anyPrompt(t: InstallTarget, server: string): string {
  return `Add NsMetry analytics to this project.

Endpoint: ${server}
Site: ${t.site}

Pick the setup that fits the project:
- NSH app (nsh.json): \`nsh add nsmetry\`, then ${client(server, t)}. Docs: ${nshDocs}
- JavaScript / TypeScript: \`npm install nsmetry\`, same client. Docs: ${jsDocs}
- Website: add ${scriptTag(t)} to the <head> of every page.
- Anything else: POST batches to ${server}/api/events/batch. Docs: ${httpDocs}

${appRules}

${verify(server, "run it and open a few screens or pages")}`;
}

/**
 * A prompt a coding agent (Claude Code, Codex, Cursor) follows to instrument a project with this
 * instance. `kind` writes it for one client; `any` (for someone unsure what the project is) lists
 * them all, one line each, and lets the agent pick.
 */
export function agentPrompt(t: InstallTarget, kind: PromptKind = "any"): string {
  const server = serverOr(t.server);
  switch (kind) {
    case "website": return websitePrompt(t, server);
    case "nsh": return nshPrompt(t, server);
    case "js": return jsPrompt(t, server);
    case "http": return httpPrompt(t, server);
    default: return anyPrompt(t, server);
  }
}
