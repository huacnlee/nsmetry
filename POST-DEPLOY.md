# After you deploy

Deploying gets you a running Worker. It does not get you a safe one, and a few of
the gaps are only obvious once someone has walked into them.

Every step below is labelled:

- **Required** — do it before the instance collects anything you care about, or
  before you leave it running unattended.
- **Recommended** — you will want it eventually. Skipping it costs you something
  real, but not immediately.
- **Optional** — depends on your traffic, your plan, or your taste.

| # | Step | |
|---|---|---|
| 1 | [Make sure you can always get a code](#1-make-sure-you-can-always-get-a-code) | **Required** |
| 2 | [Know how to cut access off](#2-know-how-to-cut-access-off) | **Required** |
| 3 | [Check that the rollups are running](#3-check-that-the-rollups-are-running) | **Required** |
| 4 | [Keep `database_id` out of a public fork](#4-keep-database_id-out-of-a-public-fork) | Required *if public* |
| 5 | [Rate-limit sign-in at the edge](#5-rate-limit-sign-in-at-the-edge) | Recommended |
| 6 | [Watch the D1 budget](#6-watch-the-d1-write-budget) | Recommended |
| 7 | [Rename the tracker file](#7-rename-the-tracker-file) | Recommended |
| 8 | [Ignore your own visits](#8-ignore-your-own-visits) | Recommended |
| 9 | [Back up beyond Time Travel](#9-back-up-beyond-time-travel) | Optional |
| 10 | [Tune the configuration vars](#10-tune-the-configuration-vars) | Optional |
| 11 | [Add more sites and viewers](#11-add-more-sites-and-viewers) | Optional |

---

## First, confirm what Getting started already did

[Getting started](README.md#getting-started) put the instance on a hostname you
own and named its administrator. Both fail silently, so verify rather than assume.

**`ADMIN_EMAIL` is set.** Open the app on your hostname and ask for a code for
your address. *"This server is not set up yet"* means it is still empty. Nobody
else can take the instance over in the meantime — there is no setup form to
claim — but nobody can sign in either.

**It is on your own domain, and `workers.dev` is off.** `*.workers.dev` is a
shared hostname that ad blockers and DNS filters block wholesale, so beacons
vanish and the numbers come in low; and WAF rules cannot attach to it, so step 5
is impossible there. An extra live hostname also bypasses whatever you attach to
the real one. Set `"workers_dev": false` in `wrangler.jsonc`, redeploy, and
check:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://nsmetry.<your-subdomain>.workers.dev/health
```

Anything other than a connection failure or a 404 means it is still live.

When you move to a new hostname later, update the snippet on your sites and the
server address in the desktop and mobile apps. The tracker derives its beacon
endpoint from its own `src`, so there is no server-side setting to match.

---

## 1. Make sure you can always get a code

**Required. Two minutes now, or an afternoon later.**

There are no passwords, so there is nothing to forget — but sign-in is only as
available as the code's delivery. Codes go out by the first configured of: the
`SMTP` secret, the Cloudflare Email Sending binding (`EMAIL` + `MAIL_FROM`), or,
with neither, the Worker's logs.

- **Send yourself a code now**, and check it lands in the inbox rather than spam.
  Add the sender to your contacts.
- **If mail breaks later** (an expired app password, a provider outage), sign-in
  answers *"could not send the email"*. You do not need mail to get back in:

  ```bash
  npx wrangler secret delete SMTP          # or comment out the EMAIL binding and redeploy
  npx wrangler tail                         # then ask for a code; it is printed here
  ```

  With no transport configured the code goes to the logs (also under your Worker
  → **Logs** in the dashboard). Only someone with your Cloudflare account can read
  them — the same person who could edit `ADMIN_EMAIL` anyway.
- **If you lose the mailbox itself**, set `ADMIN_EMAIL` to another address in
  `wrangler.jsonc` and redeploy. Administrator rights follow the variable, not an
  account in the database.

The instance throttles sign-in on its own: one code per address per minute, at
most 20 emails an hour, five tries per code, and after 20 wrong codes in a UTC
day nobody can sign in until midnight UTC. That last rule turns guessing into, at
worst, a one-day lockout — never a way in. Sessions you already have keep
working through it, and the logs route above does not help during it, so step 5
is what keeps a stranger from triggering it.

## 2. Know how to cut access off

**Required reading. Nothing to do until you need it.**

The app and scripts hold a **bearer token** from sign-in, valid for 90 days since
its last use. An agent connected over MCP holds an **OAuth grant**: a one-hour
access token and a refresh token that rotates on every use. Tokens are stored
only as hashes.

- **A viewer leaving**: remove them under **Team**. That revokes their tokens and
  disconnects their agents on their next request.
- **An agent you no longer trust**: disconnect it under **Agents**. Each person
  sees and disconnects their own.
- **A lost phone or laptop**, or anything worse: revoke every session and every
  agent at once, then sign in again:

  ```bash
  npx wrangler d1 execute nsmetry --remote --command \
    "DELETE FROM sessions; DELETE FROM oauth_grants; DELETE FROM oauth_codes;"
  ```

## 3. Check that the rollups are running

**Required, once, a day or two after you deploy.**

Two cron triggers do the housekeeping. The hourly one folds finished hours into
the rollup tables; the daily one at 00:20 UTC folds finished days and then
**drops the raw hour tables**. Dropping them is what keeps the write budget small,
because DDL costs no row writes at all.

If the daily job never fires, nothing errors and the dashboard keeps working —
raw tables just pile up, and every rollup pass re-reads more of them. You find out
when you hit the D1 daily limit.

Check directly:

```bash
npx wrangler d1 execute nsmetry --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ev\_%' ESCAPE '\' ORDER BY name"
```

The table names carry their hour as `ev_YYYYMMDDHH`. You should only ever see
today's, and possibly yesterday's. Anything older than that means the daily job is
not running — check the Worker's cron triggers are registered and look at its logs.

## 4. Keep `database_id` out of a public fork

**Required if you are publishing your fork. Skip if it stays private.**

On your first `wrangler deploy`, Wrangler creates the D1 database and writes the
new `database_id` back into `wrangler.jsonc`. Do not commit that line to a public
template. Anyone deploying your repo afterwards gets a config pointing at an id
that does not exist in their account, and automatic provisioning will not kick in,
because the field is no longer empty.

Revert it after deploying. Cloudflare keeps your Worker linked to the database it
already created:

```bash
git checkout wrangler.jsonc
```

## 5. Rate-limit sign-in at the edge

**Recommended. Free, on a hostname you own.**

The Worker's own limits make guessing a code useless, but anyone can still spend
them: request codes for your address until the hourly mail limit is hit, or send
20 wrong codes and lock sign-in for the rest of the UTC day. An edge rule stops
that before the Worker runs.

1. In the Cloudflare dashboard, select the **zone** your Worker runs on and open
   **Security rules** (older navigation: **Security** → **WAF** → **Rate limiting
   rules**).
2. **Create rule** → **Rate limiting rules**.
3. Match **URI Path** *starts with* `/api/auth/` (on the free plan, which only
   offers *equals*, use `/api/auth/verify`).
4. Count by **IP**. Rate: **5 requests** per **10 seconds**. Action **Block** for
   **10 seconds**.

The free plan includes exactly one rate limiting rule, with a 10-second period
and block. That removes the cheap burst; it is not a lockout. If you also want
SSO in front of the app, Cloudflare Access works — but give the tracker its own
hostname (`t.example.com`) first, because visitors on your sites must reach the
tracker and its beacon anonymously, and set that hostname as the script address
under **Settings** so the install snippets use it. Access in front of `/mcp`,
`/oauth/*` and `/api/*` breaks the desktop and mobile apps and every agent, which
cannot pass an Access login; keep it to the web app's own pages if you use it.

## 6. Watch the D1 write budget

**Recommended.**

The Workers Free plan allows **100,000 rows written per day** and 5 million read.
Exceeding either does not degrade gracefully: D1 starts returning errors, which
means beacons fail and **you silently lose traffic** until the counter resets.

The design target is half of every free-plan limit for a fleet of about a
hundred sites and apps — the README's [How it stays free](README.md#how-it-stays-free)
has the measured numbers. Rows *read* is the limit that binds, and it is spent by
the app (a realtime panel left open all day, many dashboard loads), not by
ingest.

Check usage in the Cloudflare dashboard under your D1 database. If you are running
close, `FILTERS=off` (step 10) is the biggest single lever.

## 7. Rename the tracker file

**Recommended.**

The endpoint follows the filename. Request `/xyz.js` and the script posts its
beacons to `/xyz`. No server-side configuration is involved, so every deployment
can use a different path and no single path-based blocklist rule matches them all.
Change the `src` in your snippet; nothing else needs to know.

The app cannot guess which name you picked — the Worker answers to all of
them — so put the new one in the app under **Settings** (the script address) and
the snippets it shows stay copy-pasteable.

Pick this before step 5 if you are using Access with path bypasses.

## 8. Ignore your own visits

**Recommended, or your own reloads will be a meaningful share of a small site.**

`localStorage` is per-origin, so this has to be set on the site being tracked. In
your browser's console, on your own site:

```js
localStorage.setItem('em-ignore', '1')
```

## 9. Back up beyond Time Travel

**Optional.**

D1's Time Travel is automatic, always on, and costs nothing — it restores the
database to any minute within the last **7 days on the Free plan**, 30 days on
Paid. You do not need to enable anything.

That covers accidents. It does not cover wanting your data somewhere Cloudflare is
not, which matters here because daily rollups are the permanent record and there
is no export button in the app:

```bash
npx wrangler d1 export nsmetry --remote --output nsmetry-backup.sql
```

Worth doing on a schedule if the history matters to you.

## 10. Tune the configuration vars

**Optional.** All of these live under `vars` in `wrangler.jsonc`.

| Variable | Default | When to change it |
|---|---|---|
| `FILTERS` | `on` | Set to `off` on an unusually diverse instance to trade the filters for a smaller budget. |
| `HOURLY_RETENTION_DAYS` | `7` | How long hour-resolution data is kept. Daily rollups are permanent regardless. |
| `UPDATE_CHECK` | `on` | `off` stops the nightly release check, the only request the instance makes to anyone. |

Two more that are not `vars`:

- `observability.head_sampling_rate` is `1`, meaning every request is logged.
  That is right for a new instance — and it is where sign-in codes go when no mail
  is configured — but turn it down once traffic grows. Code lines are written on
  every send, so a lower rate can drop one; configure mail before lowering it.
- **The script address** lives in the app under **Settings**, not in
  `wrangler.jsonc`, because it depends on the hostname and filename you chose
  after deploying. It is stored in D1, so a redeploy does not reset it.

## 11. Add more sites and viewers

**Optional.**

One deployment serves as many sites and apps as you like — add them from the
site switcher. Each gets its own install instructions, and traffic is fully
isolated: the same visitor hashes differently per site, so cross-site correlation
is impossible by construction. Site count costs nothing; only total traffic
counts against the free plan.

Under **Team**, the administrator invites an email and ticks which sites it sees.
No mail is sent: they sign in with a code at your instance's address, in the web
app or the desktop and mobile apps. Permissions are enforced server-side, not by
hiding buttons, and apply to their agents too.
