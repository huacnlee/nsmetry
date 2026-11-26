# nsmetry for NSH

Event analytics for [Native Shell (NSH)](https://nsh.dev) apps, sent to your own
[NsMetry](https://github.com/hayaran/edgemetry) instance on Cloudflare's free
plan. One TypeScript API on iOS, Android, macOS, Windows, Linux and the web.

- Batches events: one request per ~5 minutes while the app has something to send (and one when it goes to the background), at most 50 events each.
- Flushes when the app goes to the background, retries with backoff, keeps a bounded queue offline.
- Never throws into the app.
- Keeps an anonymous install id in NSH `Storage` (opt-in), reads the app's version from `nsh.json`, and
  describes the OS and device class so the dashboard's OS and Device breakdowns are right.
- Turns `<NavStack>` navigation (or any reactive path) into screen views.

The API is the same as the [`nsmetry` npm package](../js/README.md); the queue
code is shared verbatim.

## Install

```sh
nsh add nsmetry
```

The package is published as a crate so `nsh add` can fetch it from crates.io.
Its native part (`nsmetry/native`) is empty: NSH builds it once with the app, and
nothing in it runs. NSH 0.7 or later.

## Use

Register the app in your NsMetry dashboard as a site — a bare name such as
`my-app` is fine — then create one client for the app:

```ts
// analytics.ts
import { createNsMetry } from "nsmetry";

export const nsmetry = createNsMetry({
  endpoint: "https://stats.example.com",
  site: "my-app",
  persistUserId: true, // active users and retention; the id is random and hashed by the server
});
```

Wire it once in the root component:

```tsx
// App.tsx
import { navStackPath, useNsMetry, useScreenTracking } from "nsmetry";
import { nsmetry } from "./analytics";
import { nav } from "./nav";

function App() {
  useNsMetry(nsmetry); // flush when the app goes to the background
  useScreenTracking(nsmetry, navStackPath(nav, (route) => `/${route.name}`));
  return <NavStack state={nav} class="flex-1">{/* ... */}</NavStack>;
}
```

and track what matters anywhere:

```ts
nsmetry.track("export", { format: "csv" });
```

`useScreenTracking` takes any accessor, so tabs or a hand-rolled router work too:
``useScreenTracking(nsmetry, () => `/${tab()}`)``. Keep ids out of paths
(`/message`, not `/message/8812`): each distinct path is a row in the dashboard
and in the database.

## API

| | |
| --- | --- |
| `createNsMetry(options)` | A client. Options as in the npm package: `endpoint`, `site`, `userId`, `persistUserId`, `appVersion` (default: the app's), `ua` (default: `describePlatform(platform)`), `flushInterval` (300 000 ms), `maxBatch` (50), `maxQueue` (1000), `disabled`, `fetch`, `storage`, `onError` |
| `client.track(name, props?)` | A custom event on the current screen. Props: ≤ 10 keys, string/number/boolean |
| `client.screen(path, props?)` | A screen view |
| `client.identify(userId)` | Use this id from now on; `null` returns to the anonymous id |
| `client.flush()`, `client.shutdown()` | Send now; send and stop. Never reject |
| `client.setEnabled(enabled)` | Opt out (drops the queue) or back in |
| `useNsMetry(client)` | In a component: flush when `lifecycle()` becomes `"background"`, and (best effort, NSH allows 200 ms) when a desktop app quits |
| `useScreenTracking(client, path)` | In a component: a screen view whenever `path()` changes |
| `navStackPath(stack, toPath)` | The path of a `<NavStack>`'s top page |
| `describePlatform(platform)` | The `ua` sent: `NsMetry-NSH/0.1.0 (iPhone; iOS 17.5; Mobile)`, `(Android 35; Tablet)`, `(macOS 15.1)`, `(Windows NT 10.0)`, `(Linux)`; undefined on the web, where the browser's header is used |

Desktop windows changing focus (`"inactive"`) do not flush: that would spend a
request on every Cmd-Tab.

## Example and tests

`example/` is an app that depends on this package by path:

```sh
cd example
nsh check
nsh test   # headless: navigation becomes screen views, backgrounding sends them
nsh run
```

`src/core.ts` is a copy of `sdk/js/src/core.ts`; change it there and run
`npm run sync:nsh` in `sdk/js` (a test fails when they differ).
