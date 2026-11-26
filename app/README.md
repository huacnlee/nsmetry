# NsMetry app

> **Rule for screen authors.** Screens compose only `app/ui` components and tokens; no local styling
> of controls; a missing look becomes a new `ui` variant first. A screen may lay out (`flex-row`,
> `gap-*`, padding on its own containers) but never sets a control's color, size, radius, border or
> state style; import controls from `app/ui`, never from `nsh/base`. Review every new look in the
> gallery (`nsh run app/gallery.tsx`) in light and dark before a screen uses it.

The NSH (TSX) client of NsMetry for the web, desktops and phones. The manifest is the repo root's
`nsh.json` (entry `app/App.tsx`, theme `app/theme.json`); run every `nsh` command from the repo root.

```sh
nsh check                                   # types
nsh build                                   # bundler: text outside Text, unknown classes
nsh test                                    # app/*.test.tsx, headless
nsh run                                     # the app; --target web | ios | android | macos
nsh run app/gallery.tsx                     # the ui gallery alone, no server needed
nsh test app/gallery.test.tsx --target macos  # gallery screenshots → app/shots/
nsh test app/gallery-shots.test.tsx --target macos  # every gallery page, desktop and 390pt, light and dark
nsh package --target web                    # the web build
```

The first `nsh test` builds the headless runner of the icon packages (about 10 minutes); later runs
take seconds.

## Layout of the code

| Path | What |
| --- | --- |
| `App.tsx` | Mounts `shell/root.tsx`. Nothing else. |
| `api.ts` | Typed client of every endpoint in `docs/api.md`, with a pluggable transport. |
| `store.ts` | Shared state: session, sites, range, compare, filters, section, appearance. |
| `signin.tsx` | Server (native only) → email → code → signed in. |
| `shell/` | Root, sidebar, tab bar, the shared controls (site switcher, range, compare, filter bar, account menu). |
| `ui/` | The design system: every styled control. See `DESIGN.md`. |
| `components/` | Data-bound pieces shared by screens (`BreakdownList`). |
| `screens/` | One file per section. **Placeholders**, each owned by a later agent. |
| `format.ts` | `formatCount`, `formatPercent`, `formatDuration`, `change`. |
| `fixtures/` | Test entries that put a shared component inside the real shell. |
| `DESIGN.md` | Tokens, components, the motion inventory. |

## Writing a screen

Replace the placeholder in `screens/<name>.tsx`, keep its export name and its
`ScreenFrame testID="screen-<name>"`, and add the screen's motion inventory to `DESIGN.md` first.

Rules:

- Import controls from `../ui` only, never from `nsh/base`, and never style a control in a screen.
  A look the ui layer lacks becomes a variant there (tell the other agents: it is shared).
- Colors are theme tokens (`bg-hover`, `text-muted-foreground`, `token("brand")`), sizes come
  from `size` / `type` in `ui/tokens.ts`. No raw hex.
- Charts only through `TimeSeries`, `Bars`, `Sparkline` (`nsh/base/plot` underneath).
- Read props and signals where they are used (components run once).

### Reading the shared state

```ts
import { api, scope, currentSite, currentRange, comparing, currentFilters, isOwner } from "../store";
```

`scope()` is `{ site, range, filters, compare }`, or null before a site is chosen. Pass it as a
`resource` source so a change of site, range, compare or filters reloads the screen:

```tsx
const summary = resource(() => scope(), (s) => api.summary(s));
// summary() is undefined while loading; summary.error() holds an ApiError; summary.refetch()
```

Endpoints that do not take a range use the site alone: `api.realtime(scope()!.site)`,
`api.retention(site, "week", 8)`. Account-level calls: `api.users()`, `api.grants()`,
`api.inviteUser(email, siteIds)`, … (all of `docs/api.md`; see `api.ts`).

### Errors

Calls throw `ApiError { status, message, unauthorized, offline }`; `message` is the server's own
`{ error }`. A 401 from any call already signs the app out (the store handles it) — screens only
show the others, typically with `EmptyState icon="error"` and a "Try again" action that calls
`refetch()`, or `toast(message, { tone: "error" })` after an action.

### Filters

Filters are shared by every screen, one value per dimension:

```ts
import { addFilter, removeFilter, clearFilters, filterFor } from "../store";
addFilter("country", "DE");     // replaces a country filter if there was one
filterFor("country");           // "DE" or null
```

A pressable `BarRow` (as `BreakdownList` does) is the usual way to add one. The filter bar above
every screen shows them as chips and offers "+ X" pickers for `quickFilterDims`
(`shell/controls.tsx`). Selecting another site clears the filters.

### Shared building blocks

- `BreakdownList` (`components/breakdown-list.tsx`): a top-N panel of one or more dimensions as pill
  tabs, loading / empty / error states, rows that add filters. Props: `title`, `dims`, `labels`,
  `limit`, `formatName`, `leading`.
- `MetricTile` (`ui/metric-tile.tsx`): label, value, delta (`change(cur, prev)` from `format.ts`,
  colored by `better`), a `chart` slot for a `Sparkline`, pressable / selected for metric switching.
- Charts: `TimeSeries` (`points: { label, cur, prev? }[]`, a dashed comparison when `prev` is set;
  change `generation` to redraw it in), `Bars`, `Sparkline`.
- Detail views: a page pushed on the content area's stack (`openDetail` from the store, drawn by
  `PageStack` / `StackPage` / `PageHeader` in `ui/stack.tsx`), with `PropertyList`, `Timeline`, `StatusPill`, `Tag`, `DataTable`,
  `GroupSection`, `UnderlineTabs`, `ShareBar`, `CodeBlock`, `ConfirmDialog`, `toast`.

### Navigation

`go(section)` and `currentSection()` from the store; sections and their order are in
`shell/nav.ts` (Team is owner-only).

Under the top bar is one `NavStack` (`shell/pages.tsx`, state `pageStack` in `store.ts`): its root
page is the current section's screen, and a record's detail is a page pushed over it with
`openDetail({ title, meta, actions, content, testID })` (never a sheet). Back is the page header's
"‹ Section" button, Escape and the back keys on desktops and the web, the system back and swipe on
iOS and Android; the list beneath keeps its scroll, tab and loads. `go()`, a site change and
sign-out reset the stack; range, compare and filter changes keep it (the page reloads for the new
scope). Push and pop use `NavStack`'s own transition. Details in `DESIGN.md`, "Navigation model".

## Demo mode / other transports

`api.ts` sends every request through a `Transport`
(`(req: { method, url, headers, body }) => Promise<{ status, json }>`). `setTransport(t)` from the
store swaps it (an on-device demo dataset, a test double); `setTransport(undefined)` restores the
network. Nothing else changes.

## Persistence

NSH `Storage` (async), per server: `server`, `session:<server>` (`{ token, user }`),
`prefs:<server>` (`{ site, range, compare }`), and `appearance`. On the web build the server is
the page's origin and the sign-in form hides the server field.

## Tests

`App.test.tsx` runs the real app against a fake instance (NSH network stubs): sign-in, every
sign-in refusal, signed-out on 401, sign-out, adding / removing a filter, the range switch,
compare. `gallery.test.tsx` checks the ui gallery. Add each screen's tests in its own
`<name>.test.tsx`, opening `./App.tsx` with `storage` of a signed-in session (see `signedIn()` in
`App.test.tsx`) or a fixture under `fixtures/`.
