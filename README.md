<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="app/shots/insights-desktop-dark-overview.png">
    <img src="app/shots/insights-desktop-light-overview.png" alt="NsMetry's Overview: visitors, views and engagement for one app, with a live panel, top screens, sources, events and countries" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/huacnlee/nsmetry/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/huacnlee/nsmetry/ci.yml?branch=main&label=CI&style=flat-square&labelColor=1A1922" alt="CI"></a>
  <a href="https://github.com/huacnlee/nsmetry/releases"><img src="https://img.shields.io/github/package-json/v/huacnlee/nsmetry?label=version&color=5B54E8&style=flat-square&labelColor=1A1922" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square&labelColor=1A1922" alt="MIT license"></a>
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white&labelColor=1A1922" alt="Runs on Cloudflare Workers"></a>
  <img src="https://img.shields.io/badge/cookies-none-12A594?style=flat-square&labelColor=1A1922" alt="No cookies">
</p>

# NsMetry

Privacy-friendly analytics for **your own apps and websites**, self-hosted on
Cloudflare's free plan. One Worker and one D1 database in your Cloudflare
account: no cookies, no consent banner, no bill. Read it in the NsMetry app on
the web, macOS, Windows, Linux, Android and iOS, or ask your AI agent.

- **App analytics**: daily, weekly and monthly active users, new users,
  retention, custom events with their properties, and app versions, from an
  anonymous install id hashed per site before it is stored.
- **Web analytics**: visitors, page views, bounce rate and visit duration with a
  previous-period comparison, from a ~2 KB script served from your own instance.
- **Filters that stack**: press any row and every panel narrows at once.
- **Breakdowns** by page or screen, entry and exit page, referrer, country,
  browser, OS, device, screen size, app version and UTM tags; a world map; a
  realtime panel.
- **Email-code sign-in**, no passwords. One administrator invites viewers per
  site.
- **MCP server with OAuth**: Claude, Cursor or any MCP client reads your numbers
  with exactly the access of the person who connected it.
- **Unlimited history** and **no personal data at rest**.
- The app shares anonymous usage data about itself, which you can turn off
  ([details](#the-nsmetry-apps-own-usage-data)).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/huacnlee/nsmetry)

## Getting started

### 1. Deploy your instance

**With the button above.** Cloudflare signs you in, copies this repository into
your GitHub or GitLab account, creates the D1 database and deploys the Worker.
Every push to your copy redeploys. There is no API token to paste.

**Or from a terminal** (Node.js 22.9 or later; run `npx wrangler login` once):

```bash
git clone https://github.com/huacnlee/nsmetry && cd nsmetry
npm install
cat > .env <<'EOF'
ADMIN_EMAIL=you@example.com
# MAIL_FROM=noreply@example.com       # optional: Cloudflare Email Sending, see step 3
# CLOUDFLARE_ACCOUNT_ID=...            # optional: when your login has several accounts
EOF
npm run deploy
```

`.env` is not committed; `npm run deploy` passes its values to the Worker, so
`wrangler.jsonc` stays as it is. The first deploy creates the D1 database.

### 2. Give it a hostname and an administrator

In the Cloudflare dashboard: your Worker › **Settings** › **Domains & Routes** ›
**Add custom domain**, for example `stats.example.com`. Use a domain you own
rather than `*.workers.dev`, which ad blockers block wholesale; then set
`"workers_dev": false` in `wrangler.jsonc` and deploy again.

The administrator is whoever reads the mailbox named by `ADMIN_EMAIL`. With the
terminal deploy it is in `.env`. With the button, set it in `wrangler.jsonc` in
your copy of the repository and commit (a value set only in the dashboard is
reset by the next deploy). Until it is set, sign-in says the server is not set
up yet, and nobody can claim the instance.

### 3. Set up email

Sign-in codes go out by the first of these that is configured:

1. **SMTP**, from any mail provider (Fastmail, Gmail with an app password, SES):

   ```bash
   npx wrangler secret put SMTP
   # {"host":"smtp.example.com","port":465,"secure":true,"user":"me@example.com","pass":"…","from":"NsMetry <me@example.com>"}
   ```

2. **Cloudflare Email Sending**: onboard your domain once, then deploy with
   `MAIL_FROM` set to an address on it.

   ```bash
   npx wrangler email sending enable example.com
   ```

   `npm run deploy` turns on the `EMAIL` binding when `MAIL_FROM` is in `.env`.
   With the button, uncomment the `send_email` binding in `wrangler.jsonc` and
   set `MAIL_FROM` there.

3. **Nothing**: the code is written to the Worker's logs and the sign-in screen
   says so. Read it with `npx wrangler tail` or under your Worker › **Logs**.
   That is enough to start; only viewers you invite need real email.

### 4. Sign in and add a site

Open your hostname, enter `ADMIN_EMAIL` and type the code. Add a site from the
site switcher: a website's domain (`example.com`) or an app's name (`my-app`).
**Settings** shows how to install it, filled in for your instance.

Then read **[POST-DEPLOY.md](POST-DEPLOY.md)**: the short checklist that makes
sure you can always get a code, the rollups run, and the instance is hardened.

## Install the app

The web app needs no install: it is your instance's address. For the desktop:

```sh
# macOS (Apple silicon) and Linux (x86_64)
curl -fsSL https://raw.githubusercontent.com/huacnlee/nsmetry/main/scripts/install.sh | sh
```

```powershell
# Windows (x86_64)
irm https://raw.githubusercontent.com/huacnlee/nsmetry/main/scripts/install.ps1 | iex
```

The installers check every download against the release's `sha256sums` and need
no administrator access. For phones, take from the
[latest release](https://github.com/huacnlee/nsmetry/releases/latest)
`nsmetry-android.apk`, or `nsmetry-ios-unsigned.ipa` to sideload with your own
Apple ID (AltStore, Sideloadly). [docs/install.md](docs/install.md) covers
pinning a version, the install folder, upgrading, uninstalling and the macOS
first-open prompt.

In the app, type your instance's address once and sign in with an emailed code.
Typing `demo` as the address, or pressing **Try the demo**, opens a demo that
runs on your device with made-up traffic.

## Track a site

Each site's **Settings** has an install panel with these snippets filled in.

**A website**: add one tag. It counts page views, single-page apps included.

```html
<script defer src="https://stats.example.com/em.js" data-domain="example.com"></script>
```

Custom events: `nsmetry('signup')`. Any `/<name>.js` on your instance serves the
script and it reports to `/<name>`, so pick your own name to stay off ad-block
lists.

**An app**: register it by name (`my-app`), then pick a client.

- **NSH apps**: `nsh add nsmetry`. Screen views from your navigation, an
  anonymous install id, the app version from `nsh.json`, and a flush when the
  app goes to the background. See [sdk/nsh](sdk/nsh/README.md).
- **JavaScript** (browser, Node, Bun, Deno, Electron, React Native, Workers):
  `npm install nsmetry`. See [sdk/js](sdk/js/README.md).
- **Anything else**: the HTTP API, one request per batch of up to 50 events.

  ```bash
  curl -X POST https://stats.example.com/api/events/batch \
    -H 'content-type: text/plain' \
    -d '{"site":"my-app","events":[{"name":"screen_view","url":"/settings","user_id":"<install id>","app_version":"2.4.1"}]}'
  ```

Send a `user_id`, a random id made once per install, to get active users and
retention. [docs/sdk.md](docs/sdk.md) has the batching rules that keep you
inside the free plan and clients in Swift and Kotlin;
[docs/api.md](docs/api.md) is the full API.

**With an AI agent**: **Settings › Install › AI agent** gives you a prompt for
Claude Code, Codex or Cursor that wires the right client into your project.

## Invite people

Under **Team**, the administrator invites an email and ticks the sites it may
read. Nothing is mailed: tell them your instance's address, and they sign in
with a code. Viewers see only their sites, read-only, in the apps and through
their agents. Removing someone signs them out everywhere and disconnects their
agents.

## Connect AI agents

Your instance is an MCP server at `https://stats.example.com/mcp`, protected by
OAuth 2.1. Connecting opens a browser where you sign in with an emailed code;
the agent then reads, and only reads, the sites you can see.

```bash
claude mcp add --transport http nsmetry https://stats.example.com/mcp
```

**Agents** in the app has ready-to-paste configs for Cursor, Claude Desktop and
others, and lists and disconnects what is connected. The tools cover sites,
summaries, breakdowns, time series, realtime, active users, retention, and
events with their properties and trends.

## How it stays free

The Cloudflare free plan allows, per UTC day, 100,000 Worker requests, 100,000
D1 rows written and 5,000,000 D1 rows read. NsMetry aims at half of each, and a
test replays a whole fleet's day against a metered D1 to hold it there:

| A measured day | Requests | Rows written | Rows read |
|---|---|---|---|
| 6 apps with 6,300 daily users, 6 websites, 88 quiet sites, and you watching | 31,703 | 33,263 | 91,077 |
| Target: half the free plan | 50,000 | 50,000 | 2,500,000 |

Clients batch events (the SDKs send about one request per five minutes while an
app is in use), raw rows are folded into compact daily rollups every ten
minutes, and expired raw data is dropped as whole tables, which costs no writes.
In practice: a handful of apps with a few thousand daily users, a few websites
and a long tail of side projects, about a hundred sites, on one free account.
POST-DEPLOY.md shows how to [watch your usage](POST-DEPLOY.md#6-watch-the-d1-write-budget).

## Configuration

Set under `vars` in `wrangler.jsonc` (or `ADMIN_EMAIL` and `MAIL_FROM` in `.env`
for `npm run deploy`):

| Variable | Default | |
|---|---|---|
| `ADMIN_EMAIL` | *(empty)* | **Required.** The administrator. Changing it and redeploying moves the role to another address. |
| `MAIL_FROM` | *(empty)* | Sender for Cloudflare Email Sending, with the `EMAIL` binding. |
| `HOURLY_RETENTION_DAYS` | `7` | How long hour-resolution data is kept. Daily data is kept forever. |
| `FILTERS` | `on` | Only affects days stored by the older Edgemetry releases this project grew from; leave it on. |
| `UPDATE_CHECK` | `on` | Once a day the Worker asks GitHub for the newest release, so **Settings** can tell you when you are behind. `off` makes no request. |

Secret: `SMTP` (see [email](#3-set-up-email)). If you rename the Worker, rename
the `SELF` service binding in `wrangler.jsonc` to match.

## Updating

Deploys never touch your data: the D1 database is separate, and the schema
migrates itself on the first request. **Settings › This instance** shows your
version and whether a newer one is out.

### Taking the update

The deploy button imports this repository rather than forking it, so GitHub
never says your copy is behind. In your copy: **Actions › Update NsMetry › Run
workflow**. It opens a pull request with the new version as one commit; merging
it deploys. Set the repository variable `AUTO_UPDATE_PR` to `on` to have it open
the pull request by itself. The commit replaces every tracked file, so if you
edited one (`ADMIN_EMAIL` in `wrangler.jsonc`, say), put it back before merging.

From a terminal deploy: `git pull` and `npm run deploy`.

Desktop apps: run the installer again. The web app updates with your instance.

## Privacy

No cookies and no `localStorage` on your websites. A web visitor is a hash of a
daily random salt, the site, the IP address and the user agent; the salt is
deleted two days later, the IP address is never stored, raw events are dropped
within 24 to 48 hours, and only the referrer's hostname is kept. App install ids
are stored as a per-site hash. The tracker and the SDKs talk only to your
instance, and the only request the instance makes is the daily update check.
This is designed to need no consent banner under GDPR, but it is not legal
advice.

### The NsMetry app's own usage data

The NsMetry app, including the web app your instance serves and the desktop and
mobile releases, reports how it is used to the project's own NsMetry instance
(`nsmetry.huacnlee-account.workers.dev`), with the same SDK, so we can see which screens
matter. It sends the screens you open (such as `/overview` or `/users/detail`),
the app version and platform, and a few actions: signing in, adding a site (a
domain or an app), changing the date range, turning on comparison, and adding a
filter (which dimension, not its value). The user id is an anonymous install id,
hashed by the server. It never sends your instance's address, the numbers it
holds, site names or your email.

It is on by default. Turn it off under **Settings › This instance › Share
anonymous usage data**; the choice is kept on each device. Development builds
never send anything.

Security reports and what is in scope: [SECURITY.md](SECURITY.md).

## Limitations

- All days are UTC.
- Web visitors across several days are summed daily counts, because the salt
  rotates daily. App users with a `user_id` are counted exactly.
- Time on site leaves out the last page of a visit.
- The ingest endpoint is public, as it must be. Known bots are dropped; a
  Cloudflare rate-limiting rule handles deliberate junk.

## Contributing

Developing NsMetry: [CONTRIBUTING.md](CONTRIBUTING.md).

## Prior art

[Counterscale](https://github.com/benvinegar/counterscale) established this
category. NsMetry uses D1 instead of Workers Analytics Engine, which keeps
history indefinitely and needs no API token at install, and adds app analytics,
the native apps and the MCP server.

## Author

Built by Nitin Hayaran ([@nitinhayaran](https://x.com/nitinhayaran) on X).

## License

MIT. See [LICENSE](LICENSE).
