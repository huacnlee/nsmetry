# Contributing to NsMetry

This is the developer's guide: how the repository is laid out, how to run and
test it, the rules a change has to keep, and how a release is made. Using
NsMetry is in the [README](README.md).

## Layout

| Path | What |
| --- | --- |
| `src/` | The Worker (TypeScript, [Hono](https://hono.dev)): ingest, the fold and rollups, the HTTP API, email-code sign-in, OAuth 2.1 and the MCP server. `src/index.ts` is the entry. |
| `app/` | The NSH app (TSX) for the web, macOS, Windows, Linux, iOS and Android. `app/README.md` and `app/DESIGN.md` are its guides. |
| `sdk/js/` | The `nsmetry` npm package. |
| `sdk/nsh/` | The `nsmetry` NSH package (`nsh add nsmetry`), with an example app in `sdk/nsh/example/`. |
| `test/` | The Worker's tests, run inside the Workers runtime against a real D1, and the budget test. |
| `scripts/` | `deploy.mjs` (`npm run deploy`), `web-package.mjs` (the web app before each deploy), `seed.mjs`, `build-map.mjs`, and the app installers `install.sh` / `install.ps1` with their tests. |
| `docs/` | The HTTP API (`api.md`), the SDK contract (`sdk.md`), installing the app (`install.md`). |
| `nsh.json` | The app's manifest, at the repository root: run every `nsh` command from there. |
| `wrangler.jsonc` | The Worker's configuration; the template every deployment starts from. |

## Setup

You need Node.js 24 (what CI uses) and, for the app, the [NSH CLI](https://nsh.dev)
at the version CI pins: `version` in `.github/actions/setup-nsh/action.yml`,
currently 0.7.1. The Worker side needs no NSH.

```bash
npm install
echo 'ADMIN_EMAIL=you@example.com' > .dev.vars
npm run dev          # the Worker and the web app on http://localhost:8787
```

With no mail configured, the sign-in code is printed in the terminal. Or press
**Try the demo**: the app then talks to an NsMetry that lives on the device
(`app/demo.ts`), seeded so everyone sees the same numbers. That is also what the
public demo runs (`.github/workflows/demo.yml`).

The app on its own, from the repository root:

```bash
nsh run                       # desktop; --target web | ios | android | macos
nsh run app/gallery.tsx       # the ui gallery alone, no server needed
```

## Checks

Run what CI runs (`.github/workflows/ci.yml`) before you open a pull request:

```bash
npm run typecheck
npm test                                   # the Worker, in the Workers runtime against D1
(cd sdk/js && npm install && npm run typecheck && npm test)
nsh check && nsh build && nsh test         # the app; the first nsh test builds the icon runner (~10 min)
(cd sdk/nsh/example && nsh check && nsh build && nsh test)
npm run build:web                          # the web build the Worker serves (needs nsh)
npx wrangler deploy --dry-run              # the Worker bundles
sh scripts/test-install.sh                 # the macOS/Linux installer, against local fixtures
```

`npm test` needs `app/.nsh/tsconfig.json`, which `nsh check` writes; without
NSH, `mkdir -p app/.nsh && echo '{}' > app/.nsh/tsconfig.json` is enough, as in
CI. `scripts/test-install.ps1` tests the Windows installer and runs on Windows
only.

### Data to look at

```bash
npm run seed                                                   # synthetic traffic through the real ingest
npm run seed -- --url https://stats.example.com --domain example.com --events 500
npm run seed -- --days 45 --domain example.com                 # history, written directly
npx wrangler d1 execute nsmetry --local --file .seed.sql
```

Cron triggers do not fire under `wrangler dev`. Fire them by hand:

```bash
curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*'   # the fold
curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=25+0+*+*+*'     # the nightly backstop and update check
```

## The free-plan budget

NsMetry must run a fleet on one free Cloudflare account. `src/budget.ts` sets
`TARGET` at half the free plan's daily limits (50,000 requests, 50,000 rows
written, 2,500,000 rows read) and `DESIGN_CAPS` lower still.
`test/budget.test.ts` replays a full fleet's day (6 apps with 6,300 daily users,
6 websites, 88 quiet sites, a realtime panel open all working day, dashboard
loads over two years of history) through the real Worker against a metered D1
and fails if any total reaches the target or passes a cap.

**Never raise `TARGET` or `DESIGN_CAPS` to make that test pass. Make the change
cheaper.** Run it on its own with `npx vitest run test/budget.test.ts`; it
prints the day's measured totals.

What keeps it cheap, and what a change must not undo:

- **One raw row per request.** `/api/events/batch` stores a flush of up to 50
  events as one row. D1 bills writes per row.
- **Raw tables are per hour, keyed `(site_id, ts, k)`, and expire by `DROP
  TABLE`**, which writes no rows.
- **Each site keeps one `day_state` row for today.** Every ten minutes the cron
  plans units of at most 300 raw rows and hands each to the Worker itself
  (`POST /internal/fold` through the `SELF` service binding), folds them into
  the state, and writes it back only if no one else moved its cursor.
- **Finished days become dyadic blocks** (level *k* covers 2^*k* days), so any
  range is at most two blocks per level, about 20 rows for two years.
- **Readers fold the tail in memory**; no report writes a row. Realtime asks
  only for rows after the previous answer's cursor.
- **Clients batch.** The SDKs flush about every five minutes, at 50 events, and
  when the app goes to the background. `docs/sdk.md` is the contract for any
  client.

## The app's design system

`app/DESIGN.md` is normative; `app/README.md` has the rules for screen authors.
In short:

- Screens compose `app/ui` only. They import controls from `app/ui`, never from
  `nsh/base`, and never set a control's color, size, radius, border or state
  style. A look the ui layer lacks becomes a variant there first.
- Colors are theme tokens (`app/theme.json`: `bg-hover`, `text-muted-foreground`,
  `token("brand")`); sizes, spacing, radii and motion come from
  `app/ui/tokens.ts`. No raw hex, no literal sizes.
- Charts go through `TimeSeries`, `Bars` and `Sparkline` (`nsh/base/plot`
  underneath).
- Touch targets are at least 44pt (iOS) / 48dp (Android); every control keeps a
  visible focus ring.
- Review a new look in the gallery (`nsh run app/gallery.tsx`) in light and dark
  before a screen uses it, and record a screen's motion in `DESIGN.md`.

## The app's own usage data

`app/telemetry.ts` sends the app's anonymous usage to the project's instance
(`https://nsmetry.huacnlee-account.workers.dev`, site `nsmetry`) with the NSH
SDK in `sdk/nsh`: screen views per section, the app version and platform, and
the events `sign_in`, `add_site {kind}`, `range {range}`, `compare` and
`filter {dim}` (called from `app/store.ts`). Only release builds send
(`appInfo().development` is false); `nsh run` and `nsh test` never do. Users turn
it off under **Settings › This instance** and the choice is kept per device.

When you add an event through `track()`:

- Never send personal or instance data: no email, instance URL, site name,
  filter value, metric or anything a user typed. A property is a small fixed
  vocabulary (a kind, a range, a dimension name).
- Keep it rare: an action a person takes, not something that fires per render.
- Update the list above and the README's "The NsMetry app's own usage data", so
  users read exactly what is sent.

## Releasing

1. Bump the version in `package.json`, `nsh.json` and `src/version.ts` together.
   CI fails when `package.json` and `src/version.ts` differ; the release
   workflow fails when the tag differs from `package.json` or `nsh.json`.
2. Merge, then tag `vX.Y.Z` on `main` and push the tag.
3. `.github/workflows/release.yml` builds and publishes: `nsmetry-web.tar.gz`
   (which deployments without NSH download, so every release needs it),
   `nsmetry-macos-arm64.zip`, `nsmetry-windows-x86_64.zip`,
   `nsmetry-linux-x86_64.tar.gz`, `nsmetry-android.apk`,
   `nsmetry-ios-unsigned.ipa`, `nsmetry-ios-simulator.zip` and `sha256sums`.
   Asset names carry no version, so `releases/latest/download/<asset>` always
   resolves; `scripts/install.sh` and `install.ps1` depend on these names.
   `.github/workflows/release-notes.yml` then appends the update instructions.
4. The `crate` job publishes the `nsmetry` nshm (`sdk/nsh`) to crates.io only
   when `sdk/nsh/Cargo.toml` has a version crates.io does not have yet. Leave
   that version alone to skip it (the usual case); bump it, with
   `sdk/nsh/nsh.json`, to publish the SDK with the release.
5. The `npm` job publishes the `nsmetry` package (`sdk/js`) to npm the same
   way: only when `sdk/js/package.json` has a version npm does not have yet.
   Bump it together with `SDK_VERSION` in `sdk/js/src/core.ts` (CI checks they
   agree) to publish the SDK with the release.

Secrets (repository settings › Secrets and variables › Actions):

- `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEYSTORE_PASSWORD`:
  the Android release key. Without them a tag ships a debug-signed APK, which a
  later release-signed APK cannot update in place. Set them before relying on
  Android updates.
- `CARGO_REGISTRY_TOKEN` (optional): a crates.io token for the `crate` job.
  Without it a new SDK version is skipped with a warning.
- `NPM_TOKEN` (optional): an npm granular access token that may publish
  `nsmetry`, for the `npm` job. Without it the job skips.
- `NSH_PACKAGE_KEY`, `NSH_PACKAGE_CERT` (optional): sign an `.nshpkg` and an
  update manifest for NSH's in-app updater.

The NSH version every build uses is the `version` input of
`.github/actions/setup-nsh/action.yml`. Raise it there (CI, the demo and the
release all read it) and check `nsh check`, `nsh build` and `nsh test` pass on
it.

## Commits and pull requests

Look at `git log` for the house style: a short subject in plain English that
says what the change does for someone, in the imperative and sentence case, with
no type prefix ("Keep the realtime panel actually live", "Bound the ingest body
by bytes read, not by what it claims"). A version bump is "Call this X.Y.Z".
The body, when there is one, says why. One change per pull request; CI must
pass, including the budget test.

Security problems go through the private advisory form in
[SECURITY.md](SECURITY.md), not a public issue.
