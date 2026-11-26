# nsmetry

The JavaScript client for [NsMetry](https://github.com/huacnlee/nsmetry), the
privacy-first analytics you host yourself on Cloudflare's free plan.

- Zero dependencies, ESM with types, about 8 KB minified (3 KB gzipped).
- One build for browsers, Node, Bun, Deno, React Native, Electron and Workers.
- Batches events: one request per ~5 minutes per running app (and one when it goes to the background), at most 50 events each.
- Retries with backoff, keeps a bounded queue while offline, and never throws into your app.
- Flushes when the page is hidden (with `sendBeacon`) or the process is about to exit.

For NSH apps use the `nsmetry` nshm instead (`nsh add nsmetry`); for other
languages, [docs/sdk.md](../../docs/sdk.md) shows the HTTP API.

## Install

```sh
npm install nsmetry
```

## Use

Register the site in your NsMetry dashboard first — a domain (`example.com`) or
a bare name (`my-app`) — then:

```ts
import { createNsMetry } from 'nsmetry';

const nsmetry = createNsMetry({
  endpoint: 'https://stats.example.com', // your instance
  site: 'my-app',
  appVersion: '2.3.1',
  persistUserId: true, // an anonymous install id, for active users and retention
});

nsmetry.screen('/settings');                     // a screen or page view
nsmetry.track('export', { format: 'csv', rows: 120 }); // a custom event
await nsmetry.flush();                           // send now (optional)
```

### Options

| Option | Default | |
| --- | --- | --- |
| `endpoint` | – | The instance's base URL, or the full `…/api/events/batch` URL |
| `site` | – | The site as registered |
| `userId` | – | A stable, anonymous id you already have. The server hashes it per site and never stores it raw |
| `persistUserId` | `false` | Generate a random id and keep it in `localStorage` (or `storage`) across launches |
| `appVersion` | – | Shown in the "App version" breakdown |
| `ua` | auto | How the client describes itself. Browsers send nothing (the header is right); other runtimes send `NsMetry-JS/0.1.0 (macOS)` and so on |
| `flushInterval` | `300000` | Milliseconds from the first waiting event to the automatic flush |
| `maxBatch` | `50` | Events per request, and the queue length that flushes at once (≤ 50) |
| `maxQueue` | `1000` | Events kept while offline; the oldest are dropped first |
| `disabled` | `false` | Start as a no-op, e.g. until the user consents |
| `flushOnHide` | `true` | Flush on page hide / process exit |
| `fetch`, `storage` | platform's | Bring your own transport or key-value store (sync or async) |
| `onError` | – | Hears errors the client swallowed |

### Methods

- `track(name, props?)` — a custom event, attributed to the last `screen()` (or `location.pathname` in a browser).
- `screen(path, props?)` — a screen or page view.
- `identify(userId)` — use this id from now on; `identify(null)` goes back to the anonymous id.
- `flush()` — send what is queued; resolves when done, never rejects.
- `shutdown()` — flush, then stop timers and listeners.
- `setEnabled(enabled)` — opt out (drops the queue) or back in.

Properties are flat: at most 10 keys made of `A-Z a-z 0-9 _ . -` (up to 40
characters), each a string, number or boolean, strings up to 100 characters.
Anything else is dropped before sending, and event names (64), app versions
(32) and user ids (256) are trimmed to the server's limits, so one bad value
never costs a whole batch.

## Platforms

**Browser / single-page app.** The `<script>` tracker already counts page
views; use the SDK for custom events, or call `screen(location.pathname)` on
route changes if you skip the script. Requests go as `text/plain`, so a browser
sends no CORS preflight — one request per flush, not two.

**Node, Bun, Deno, CLIs.** Timers do not keep the process alive; pending events
go out on `beforeExit`. In a long-lived server call `await nsmetry.shutdown()`
on SIGTERM.

**Electron.** Use it in the renderer (browser behavior), or in the main process
(Node behavior) — not both for the same events.

**React Native.** Pass storage and flush when the app leaves the foreground:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import { createNsMetry } from 'nsmetry';

export const nsmetry = createNsMetry({
  endpoint: 'https://stats.example.com',
  site: 'my-app',
  appVersion: '2.3.1',
  persistUserId: true,
  storage: AsyncStorage,
  // The server reads the OS and device class from this (see docs/sdk.md).
  ua: `MyApp/2.3.1 (${Platform.OS === 'ios' ? 'iOS' : 'Android'} ${Platform.Version}; ${Platform.isPad ? 'Tablet' : 'Mobile'})`,
});

AppState.addEventListener('change', (state) => {
  if (state !== 'active') void nsmetry.flush();
});
```

Without `ua`, Android's networking announces itself as `okhttp`, which the
server drops as a bot; the SDK always sends a `ua` outside browsers for that
reason.

**Cloudflare Workers.** Nothing runs after the response, so flush inside it:

```ts
ctx.waitUntil(nsmetry.flush());
```

## Budget

Each flush is one Worker request on your instance. A desktop app used for
eight hours a day flushes at most ~96 times (every 5 minutes, only while
events are waiting); a phone session of a few minutes costs one or two. See [docs/sdk.md](../../docs/sdk.md#budget).

## Develop

```sh
npm test          # vitest, in Node (not the Workers pool)
npm run typecheck
npm run build     # dist/
npm run sync:nsh  # copy src/core.ts into the NSH package (a test checks they match)
```
