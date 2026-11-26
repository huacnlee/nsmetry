# NsMetry HTTP API

One contract for every client: the NSH app (web, desktop, mobile), scripts, and
the MCP server's tools. All responses are JSON. Errors are `{ "error": string }`
with a 4xx/5xx status.

## Authentication

There are no passwords. One administrator is named at deploy time by the
`ADMIN_EMAIL` variable; the administrator can invite other emails, who sign in
the same way and can read the sites they were granted.

Signing in is a code sent by email:

| Request | Body | Response |
| --- | --- | --- |
| `POST /api/auth/start` | `{ "email" }` | `{ "ok": true, "delivery": "smtp" \| "email" \| "log", "message"? }`. `403` if the email is neither the admin nor invited, `429` when rate-limited, `502` if the mail could not be sent, `503` until `ADMIN_EMAIL` is set. With `"delivery": "log"` no mail transport is configured and the code is in the Worker logs; `message` says where, for the app to show. |
| `POST /api/auth/verify` | `{ "email", "code" }` | `{ "token", "user": PublicUser }`. `401` for a wrong, spent or expired code (five tries per code), `429` once sign-in is locked for the UTC day. |
| `POST /api/auth/logout` | – (bearer) | `{ "ok": true }`, revokes that token |

Codes are 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, valid for 10
minutes; case, spaces and dashes are ignored. A new code for an address needs
a minute's wait, the instance mails at most 20 per hour, and after 20 wrong
codes in a UTC day nobody can verify until midnight UTC.

The administrator is whoever's email equals `ADMIN_EMAIL` (role `owner`);
every other account is a `viewer`. Accounts from the password era keep working
and sign in by code; any old owner that is not `ADMIN_EMAIL` is now a viewer
and sees only the sites granted to it.

Every other `/api/*` route (except `POST /api/event`, `POST /api/events/batch`
and `GET /api/world.json`) needs
`Authorization: Bearer <token>`. A token is valid for 90 days since its last
use. `401` means sign in again.

All `/api/*` routes answer CORS with `access-control-allow-origin: *` and allow
the `authorization` and `content-type` headers. No cookies are used, so this is
safe, and it lets a web build served from another origin talk to an instance.

## Types

```ts
type Role = "owner" | "viewer";
interface PublicUser { id: number; email: string; role: Role; created_at: number; siteIds: number[] }
interface Site { id: number; domain: string; created_at: number }   // `domain` is a domain or a bare name
type RangeId = "today" | "7d" | "30d" | "90d" | "12mo";
type Metric = "visitors" | "views" | "vpv" | "bounce" | "time";
type Dim = "path" | "entry" | "exit" | "referrer" | "country" | "browser" | "os" | "device" | "screen"
         | "app_version" | "utm_source" | "utm_medium" | "utm_campaign" | "event";
// `path` is a web page or an app screen. `screen` is the screen-size bucket.
interface Row { name: string; value: number }
```

Filters travel as `f=dim:value,dim:value` with each value `encodeURIComponent`ed.
Only column dimensions narrow anything: `event`, `entry` and `exit` can be
ranked but not filtered on, and a filter on them (or on an unknown name) is
dropped, not rejected. A filtered request covers at most 31 days (`today`,
`7d`, `30d`, or a custom window that short); a longer one is `400` with a
message saying so (`filters work on ranges of up to 31 days; …`), because a
filtered read walks every stored dimension combination of every day in the
window: a filtered 30 days of a 2,000-user app is already about 300,000 rows
read, and a filtered year would be more than the free plan's daily budget.
Unfiltered ranges have no such limit (they read one row per day and
dimension).

## Account and instance

- `GET /api/me` → `{ user: PublicUser, trackerUrl: string, version: string, update: { current, latest, url, behind } | null }`
- `PUT /api/settings/tracker-url` `{ url }` → `{ trackerUrl }` (owner)

## Sites

- `GET /api/sites` → `{ sites: Site[] }`, the sites this user can read
- `POST /api/sites` `{ domain }` → `{ site: Site }` (owner). A domain (`example.com`) or a bare name (`my-app`). Adding an existing one returns it.
- `DELETE /api/sites/:id` → `{ ok: true }` (owner)

## People (owner only)

- `GET /api/users` → `{ users: PublicUser[] }` (the admin first)
- `POST /api/users` `{ email, siteIds: number[] }` → `{ user: PublicUser }` — invites a viewer (no mail is sent; they sign in with a code). `409` if already invited, `400` for the admin's own email. Unknown site ids are dropped.
- `PATCH /api/users/:id` `{ siteIds }` → `{ user: PublicUser }`
- `DELETE /api/users/:id` → `{ ok: true }` — also revokes their tokens and agent grants

## Analytics

All take `site=<id>&range=<RangeId>` and optional `f=` and `cmp=1`.

**Same-time comparison.** When the range ends today and its comparison falls
on days the fold owns (from the `blocks_from` cutover, see README "Upgrading
from the earlier storage"), the comparison's last day is cut at the current
ten-minute bucket: at 14:20, `range=today&cmp=1` compares with yesterday until
14:29:59, and `range=7d` with the previous seven days, the last of them cut the
same way. `/api/summary` says which it did in `comparison: "same_time" |
"whole_day"`. Filtered comparisons, and comparisons reaching days before the
cutover, are whole days (`"whole_day"`).

**Exact and approximate.** Totals, visits, bounce rate, time, events and every
series are exact. A ranking is exact unless one of its days had more than 500
values of the dimension (100 event names): then the rest is in `"(other)"` and
`/api/breakdown` adds `approx: true`. A page's `visits` in a ranking is the
visitors who viewed it, a profile value's (country, browser, referrer, …) the
visits that began with it; over a range both are per day, summed. Under a
filter, visitors are distinct per combination of dimensions and summed (an
upper bound), and visits are counted at their entry page.

- `GET /api/summary` → `{ site, range: { id, from, to, prevFrom, prevTo, granularity: "hour"|"day"|"week"|"month", prevLabel }, filters, totals: Record<Metric, number>, previous: Record<Metric, number> | null, series: { labels: string[], cur: Record<Metric, number[]>, prev: Record<Metric, number[]> | null } }`
- `GET /api/breakdown?dim=path,country&limit=10` → `{ breakdowns: Record<Dim, Row[]>, approx?: true }` (limit ≤ 50)
- `GET /api/timeseries?metric=visitors` → `{ granularity, points: { label, cur, prev }[] }`
- `GET /api/realtime?site=<id>[&since=<cursor>]` → `{ online: number, online_window_s: number, minutes: { label, cur }[], first_minute: number, recent: { ts, path, country }[], cursor: string, full: boolean }`
  Without `since`, the last 30 minutes (`full: true`). With `since` — the `cursor` of the previous answer, `<ts>.<k>` — only the views that arrived after it: `minutes` holds their counts by **event time** (minute *i* starts at `first_minute + 60·i`) and `recent` only them, and the client adds both to the window it holds. A `since` older than 30 minutes, or malformed, is answered in full (`full: true`): replace, do not merge. `online` is always the whole count: a web visitor for `online_window_s` (300) seconds after their last request, an app for 600 seconds after its last screen view (read from what arrived in the last 15 minutes).
- `GET /api/world.json` → `{ width, height, countries: Record<ISO2, svgPath> }` (public, immutable)

## App analytics

Sites that send a `user_id` (a stable, anonymous install id) get active-user
and retention numbers on top of everything above. The id is hashed with a
per-site secret before it is stored; the raw value never reaches the database.

- `GET /api/active-users?site&range` → `{ tracked: boolean, labels: string[], dau: number[], new: number[], totals: { active: number, new: number }, wau: number, mau: number }` — `tracked` is false when the site has never sent a `user_id`
  `dau`, `new` and `totals.new` are exact. On days the fold owns, `wau`, `mau` and `totals.active` are the union of the days' user sets, exact (a block with more than 100,000 users keeps a HyperLogLog sketch instead, about 1.6% error); a window reaching days before the cutover is merged from the older daily sketches, with that error.
- `GET /api/retention?site&cohort=day|week&periods=8` → `{ tracked, cohorts: { label, size, retained: number[] }[] }` — `retained[i]` is how many of the cohort were active `i` periods after their first one (`retained[0] === size`)
- `GET /api/events?site&range&f=` → `{ events: { name, count, users }[] }` — custom events (everything except page/screen views)
  `users` is distinct users per day, summed over the range. Unfiltered it is exact per day (today from its state, finished days from their blocks). Filtered, it comes from the filter cube, where users are distinct per combination of dimensions, so the number is an upper bound.
- `GET /api/event-properties?site&range&event=<name>` → `{ keys: { key, count }[] }`
- `GET /api/event-properties?site&range&event=<name>&key=<key>&limit=` → `{ values: Row[] }`
  Property values are counts, not filters: `f=` only takes the `Dim`s above, so a client shows them without a "filter by" action.
- `GET /api/event-series?site&range&event=<name>&f=` → `{ granularity: "hour"|"day"|"week"|"month", labels: string[], count: number[], users: number[] }` — one event over the range, one entry per bucket of the range's granularity (the same `labels` as `/api/summary`'s series). `count` is how often it fired; `users` is distinct daily users, summed over the days of a week or month bucket (per hour on an hourly series), with the same upper bounds as `/api/events`: today unfiltered is summed over its hours, and filtered finished days come from the cube. `event` is required (`400` without it), and a filter longer than 31 days is `400` like every filtered report. Finished days cost one row each unfiltered; today's folded hours read only this event's entry of each packed hour.

## Connected agents (OAuth grants)

- `GET /api/oauth/grants` → `{ grants: { id, client_name, created_at, last_used_at }[] }`
- `DELETE /api/oauth/grants/:id` → `{ ok: true }`, `404` if it is not one of the caller's grants

Each person sees and disconnects only their own agents. Removing a person deletes their grants.

## Ingest (public)

`POST /api/event` (and `POST /<anything>` paired with the tracker script's
path). Body, JSON:

| Field | Also accepted as | Meaning |
| --- | --- | --- |
| `site` | `domain`, `d` | The site's domain or name, as registered |
| `name` | `n` | Event name. Default `pageview` |
| `url` | `path`, `u` | Full URL, or a path such as `/settings`. Default `/` |
| `referrer` | `r` | Referrer URL; only its host is kept |
| `screen_width` | `w` | Screen width in px; bucketed, never stored exactly |
| `ua` | `user_agent` | Overrides the User-Agent header (native apps) |
| `user_id` | `uid` | Stable anonymous install/user id. Enables active users and retention; hashed per site, never stored raw |
| `app_version` | `v` | App version, e.g. `2.3.1` |
| `props` | `p` | Flat object of event properties: ≤ 10 keys, string/number/boolean values (≤ 100 chars) |

Event names: `pageview` and `screen_view` both count as a page/screen view
(stored as `pageview`); any other name is a custom event.

`POST /api/events/batch` takes `{ "site", "events": [ ...up to 50 bodies as above, each may carry "ts" (unix seconds; honoured when it falls in the current UTC day, otherwise the receive time is used) ] }` so an app can flush a queue in one request.

Answers `204`, `400` for a malformed body, `404` for an unknown site.

## MCP

`POST /mcp`, Streamable HTTP, protected by OAuth 2.1 (`/.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`,
`/oauth/token`, `/oauth/revoke`). Sign-in on the authorize page is the same email code.
Tools: `list_sites`, `get_summary`, `get_breakdown`, `get_timeseries`, `get_realtime`, and for apps
`get_active_users`, `get_retention`, `get_events`, `get_event_properties`, `get_event_series` (the App analytics endpoints above).

- Stateless: each POST carries one JSON-RPC message and gets one JSON answer (no SSE, no
  `Mcp-Session-Id`); notifications get `202`; `GET /mcp` is `405`. Protocol versions
  `2025-11-25`, `2025-06-18`, `2025-03-26`.
- Without a valid token: `401` with
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
  An app session token (from `/api/auth/verify`) is accepted too.
- Clients register dynamically (RFC 7591, public clients, PKCE S256 required, redirect URIs:
  https, http on loopback, or a private-use scheme). Scope is `read`. Access tokens last 1 hour;
  refresh tokens rotate on every use and last 90 days since their last use. Revoking either
  token ends the grant.
- Every tool is read-only and sees exactly the sites the approving person can see; a refused
  site comes back as a tool result with `isError: true`.
