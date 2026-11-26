# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it through GitHub's private advisory form —
[**Report a vulnerability**](https://github.com/huacnlee/nsmetry/security/advisories/new)
— which is visible only to the maintainers until a fix is published.

Include what you did, what happened, and what you expected. A minimal
reproduction against a local `wrangler dev` instance is worth more than a
description.

Expect a first response within a week. This is a side project, not a product
with an on-call rotation; if a fix is going to take longer than that, you will be
told so rather than left waiting.

## What is in scope

Each NsMetry deployment is a self-hosted Worker on someone's own Cloudflare
account. There is no service to attack, so "in scope" means the code in this
repository: the Worker, the apps in `app/`, and the SDKs in `sdk/`. Things worth
reporting:

- Reading another site's statistics without a grant for it, or any other way a
  viewer, or an agent a viewer connected, reaches data the administrator did not
  give them
- Signing in without the emailed code: a code that can be guessed, replayed,
  used for another address, or used after it was spent or expired; or a way
  around the per-address, per-hour and per-day limits that is more than a
  denial of service
- Forging, replaying or outliving a **bearer token** (sign-in sessions, 90 days
  since last use, stored only as SHA-256), or one that survives the person's
  removal or sign-out
- The **OAuth 2.1 server** behind `/mcp`: a redirect URI it should refuse, PKCE
  that can be skipped or downgraded, an authorization code or refresh token
  that works twice, a grant that survives revocation or its owner's removal, or
  a token issued with more access than the approving person has
- SQL injection — every dynamic identifier is supposed to come from a fixed
  allowlist and every value is supposed to be bound
- Injected markup or script in the OAuth sign-in and consent pages, which the
  Worker renders. Paths, referrers, UTM values, event names and properties are
  all attacker-controlled by design — anyone can post them to the public ingest
  endpoint — and the apps render them as text. A place where one is interpreted
  counts
- Anything that makes the visitor hash or the stored app `user_id` hash
  reversible, correlatable across days or sites, or stable enough to track
  someone with
- Any path by which a raw IP address or a raw `user_id` is written to storage or
  returned by an API

## What is not in scope

These are known and documented, not oversights:

- **The ingest endpoint is public and unauthenticated.** It has to be — it is
  called by browsers and apps you do not control. Anyone who knows a registered
  site can post junk events and spend the daily budget. Mitigation is an edge
  rate-limiting rule, covered in [POST-DEPLOY.md](POST-DEPLOY.md).
- **Sign-in can be locked for a day.** Twenty wrong codes in a UTC day stop every
  new sign-in until midnight UTC, by design: a lockout, never a way in. An edge
  rate limit on `/api/auth/` is the mitigation.
- **With no mail configured, codes are written to the Worker's logs.** Whoever
  can read those logs controls the Cloudflare account, and could change
  `ADMIN_EMAIL` anyway.
- **The administrator is whoever reads `ADMIN_EMAIL`'s mailbox.** Taking over
  that mailbox, or the Cloudflare account, is taking over the instance.
- **Each day keeps the set of its app users, for as long as the day's blocks
  are kept (forever, like the daily rollups).** A finished day's level-0 block,
  and every higher block built from it, stores the uid64 of each user active in
  it: the first 8 bytes of the stored `user_id` hash, which is already a keyed
  hash (per-site secret) of the id the app sent. Today's `day_state` holds the
  same, plus a 12-character prefix of each visitor hash seen in the last 15
  minutes, for the realtime count. That is what makes WAU and MAU exact, and it
  means the database can say *which* (hashed) users were active on a day, which
  `app_daily` already could. None of it is returned by any API, and above
  100,000 users a block keeps a HyperLogLog sketch instead. The fold's
  `/internal/fold` endpoint is answered only with the per-install secret in
  `settings` (`fold_secret`), and is 404 to anything else.
- **The API answers CORS with `*`.** It uses bearer tokens and no cookies, so
  another origin can only make requests with a token it already has.
- Findings that require an attacker to already hold the administrator's
  mailbox, Cloudflare account, or a valid token.
- Reports from an automated scanner with no demonstrated impact.

## For operators

If you run an instance, [POST-DEPLOY.md](POST-DEPLOY.md) is the hardening
checklist. The ones that matter most: keep the instance on a domain you control
with the `workers.dev` route off, make sure you can always get a sign-in code,
know how to revoke every session and agent at once, and put an edge rate limit
in front of `/api/auth/`.
