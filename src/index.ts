import { type Context, Hono } from 'hono';

import { adminEmail, clientKey, startSignIn, verifySignIn } from './auth';
import { serveAppAsset } from './assets';
import { SETTING_FOLD_SECRET, ensureSchema, getSetting, setSetting } from './db';
import { FAVICON_SVG } from './favicon';
import { clearSiteCache, corsPreflight, handleBatchIngest, handleIngest } from './ingest';
import { loadActiveUsers, loadEventProperties, loadEvents, loadRetention } from './app-analytics';
// The reports themselves live in src/reports.ts (shared with the MCP tools);
// these two are kept for routes that parse a range or filters of their own.
import { filterSpanError, loadEventSeries, parseFilters, resolveRange } from './query';
import { catchUpToday, scheduledRun } from './rollup';
import { blocksFrom, blocksFromDayNumber, foldUnit } from './state';
import { bearerToken, resolveSession, revokeSession } from './sessions';
import { getStats } from './stats';
import { dayOffset, isValidDay, partsFor } from './time';
import { trackerResponse } from './tracker';
import { checkForUpdate, readUpdateStatus } from './update';
import { VERSION } from './version';
import { WORLD_GEOMETRY } from './world';
import { mcpRoutes } from './mcp';
import { deleteGrant, listGrants, oauthRoutes } from './oauth';
import {
  ReportError,
  breakdownReport,
  findSite,
  realtimeReport,
  summaryReport,
  timeseriesReport,
} from './reports';
import {
  type UserRow,
  accessibleSites,
  createUser,
  deleteUser,
  getUserById,
  isOwner,
  isValidEmail,
  listUsers,
  normalizeEmail,
  setSiteAccess,
  siteIdsFor,
  toPublicUser,
  withRole,
} from './users';

/**
 * Paths the Worker owns. Everything else is fair game for the tracker script
 * and its matching ingest endpoint, which is what lets each deployment choose
 * its own unguessable path.
 */
const RESERVED_PATHS = new Set([
  'api',
  'setup',
  'login',
  'logout',
  'health',
  'robots.txt',
  'favicon.ico',
  'favicon.svg',
  // OAuth and MCP for AI agents (src/oauth.ts, src/mcp.ts). Reserved so a
  // POST /mcp or /oauth can never fall through to the tracker's ingest path.
  'oauth',
  'mcp',
  '.well-known',
]);

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * A site does not have to be a website. Apps, CLIs, games and backends have no
 * hostname to put in `data-domain`, so a site can also be a bare name — `noop`,
 * `ios-app`, `my_cli` — that the HTTP API sends as its `site`. The name is only
 * ever a lookup key: nothing treats it as a host, so there is nothing to
 * resolve or verify.
 */
const NAME_PATTERN = /^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/;

export function isValidSiteKey(value: string): boolean {
  return value.length <= 253 && (DOMAIN_PATTERN.test(value) || NAME_PATTERN.test(value));
}

/**
 * The `src` the console prints in its install snippet.
 *
 * An instance preference rather than a deployment variable, because the answer
 * only exists after the deployment does: it depends on the hostname you ended
 * up on, the filename you chose for the tracker, and whether you later put the
 * dashboard behind Access on a hostname of its own. Empty — the normal case —
 * means the console works it out from its own origin.
 */
const SETTING_TRACKER_URL = 'tracker_url';

type AppEnv = { Bindings: Env; Variables: { user: UserRow } };
type AppContext = Context<AppEnv>;

const app = new Hono<AppEnv>();

/** Writing the filter cube can be turned off on very high-traffic instances. */
function cubeEnabled(env: Env): boolean {
  return (env.FILTERS ?? 'on').toLowerCase() !== 'off';
}

function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

/**
 * Resolve the bearer token to an account, or null.
 *
 * The account is re-read from the database on every request, and its role
 * re-derived from ADMIN_EMAIL. That is what makes a removed account, a
 * signed-out token or a changed ADMIN_EMAIL take effect on the very next
 * request instead of whenever a token happens to expire.
 */
async function loadUser(env: Env, authorization: string | undefined): Promise<UserRow | null> {
  const userId = await resolveSession(env.DB, bearerToken(authorization));
  if (userId === null) return null;
  const user = await getUserById(env.DB, userId);
  return user ? withRole(user, adminEmail(env)) : null;
}

function parseSiteIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
}

app.use('*', async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

app.onError((err, c) => {
  // A report that cannot be answered — bad range, unreadable site — is the
  // caller's mistake, thrown by src/reports.ts so no handler can forget it.
  if (err instanceof ReportError) return c.json({ error: err.message }, err.status);
  console.error(JSON.stringify({ level: 'error', path: c.req.path, message: String(err) }));
  return c.json({ error: 'internal error' }, 500);
});

/* ------------------------------------------------------------------ CORS -- */

/**
 * Every /api/* answer is readable from any origin, per docs/api.md.
 *
 * That is safe only because nothing here is ambient: there are no cookies, so
 * a page on another origin can do nothing a caller could not already do with
 * the bearer token it holds. And it is needed — the NSH web build may be served
 * from somewhere other than the instance, and the desktop and mobile shells
 * have no origin of their own to share with it.
 *
 * Registered before every /api route, ingest included, so a preflight never
 * reaches a handler or the session check.
 */
const API_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

app.use('/api/*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: API_CORS });
  await next();
  try {
    for (const [name, value] of Object.entries(API_CORS)) c.res.headers.set(name, value);
  } catch {
    // A response built from a fetch() has immutable headers; copy it first.
    const copy = new Response(c.res.body, c.res);
    for (const [name, value] of Object.entries(API_CORS)) copy.headers.set(name, value);
    c.res = copy;
  }
});

/* ---------------------------------------------------------------- ingest -- */

app.options('/api/event', () => corsPreflight());
app.post('/api/event', (c) => handleIngest(c.req.raw, c.env));
// An app flushes its queue here: up to fifty events, one request. Requests
// are the free plan's binding limit for a fleet of apps, so this is the
// endpoint the SDKs use (see docs/api.md, "Ingest").
app.options('/api/events/batch', () => corsPreflight());
app.post('/api/events/batch', (c) => handleBatchIngest(c.req.raw, c.env));

/* -------------------------------------------------------------- sign-in -- */

/**
 * The /api routes that answer without a session: ingest, which other people's
 * visitors and apps call; sign-in itself; and the immutable world map.
 * Exact paths, or prefixes that carry their trailing slash, so the list cannot
 * widen to any other route by accident.
 */
const PUBLIC_API_PATHS = new Set(['/api/event', '/api/events/batch', '/api/world.json']);
const PUBLIC_API_PREFIXES = ['/api/auth/'];

app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  if (PUBLIC_API_PATHS.has(path) || PUBLIC_API_PREFIXES.some((p) => path.startsWith(p))) return next();

  const user = await loadUser(c.env, c.req.header('authorization'));
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  c.set('user', user);
  return next();
});

async function jsonBody(c: AppContext): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

app.post('/api/auth/start', async (c) => {
  const body = await jsonBody(c);
  const result = await startSignIn(c.env, body.email, clientKey(c.req));
  return c.json(result.body, result.status, NO_STORE);
});

app.post('/api/auth/verify', async (c) => {
  const body = await jsonBody(c);
  const result = await verifySignIn(
    c.env,
    body.email,
    body.code,
    c.req.header('user-agent') ?? '',
    clientKey(c.req),
  );
  return c.json(result.body, result.status, NO_STORE);
});

/** Always `ok`: signing out a token that is already gone has the same outcome. */
app.post('/api/auth/logout', async (c) => {
  await revokeSession(c.env.DB, bearerToken(c.req.header('authorization')));
  return c.json({ ok: true });
});

/* ----------------------------------------------------------- own account -- */

app.get('/api/me', async (c) => {
  const user = c.get('user');
  return c.json({
    user: toPublicUser(user, await siteIdsFor(c.env.DB, user.id)),
    // Empty unless the administrator set it, in which case the app shows this
    // instead of guessing the instance's origin. See PUT /api/settings/tracker-url.
    trackerUrl: (await getSetting(c.env.DB, SETTING_TRACKER_URL)) ?? '',
    // What this build calls itself, so the app can say so without a second
    // round trip. Everyone sees it; it is the answer to "which one am I on".
    version: VERSION,
    // Administrator only. A viewer cannot deploy anything, so telling them the
    // instance is behind is a nag pointed at the wrong person.
    update: isOwner(user) ? await readUpdateStatus(c.env.DB) : null,
  });
});

/* ----------------------------------------------------- instance settings -- */

/**
 * Validate a tracker URL, returning the value to store or `null` to reject.
 *
 * The `.js` suffix is required rather than merely conventional. The script
 * derives its beacon endpoint by stripping `.js` off its own `src`, so a URL
 * without one posts back to the script's own path and is answered with the
 * script — tracking that fails silently, which is the failure this whole
 * setting exists to prevent.
 */
export function normalizeTrackerUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return '';

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.pathname.endsWith('.js')) return null;
  return url.href;
}

const OWNER_ONLY = { error: 'only the administrator can do that' } as const;

app.put('/api/settings/tracker-url', async (c) => {
  if (!isOwner(c.get('user'))) return c.json(OWNER_ONLY, 403);

  const body = await jsonBody(c);
  const trackerUrl = normalizeTrackerUrl(String(body.url ?? ''));
  if (trackerUrl === null) {
    return c.json({ error: 'enter a full URL ending in .js, or leave it empty' }, 400);
  }

  await setSetting(c.env.DB, SETTING_TRACKER_URL, trackerUrl);
  return c.json({ trackerUrl });
});

/* ----------------------------------------------------------------- sites -- */

app.get('/api/sites', async (c) => c.json({ sites: await accessibleSites(c.env.DB, c.get('user')) }));

app.post('/api/sites', async (c) => {
  if (!isOwner(c.get('user'))) return c.json(OWNER_ONLY, 403);

  const body = await jsonBody(c);
  const domain = normalizeDomain(String(body.domain ?? ''));
  if (!isValidSiteKey(domain)) {
    return c.json({ error: 'use a domain like example.com or a name like my-app' }, 400);
  }

  // Adding a site that already exists answers with that site: the caller
  // wanted it to exist, and it does.
  // The id is chosen explicitly, above both every live site and the highest id
  // ever deleted (the site_id_high setting). sites.id is a plain INTEGER
  // PRIMARY KEY, so SQLite would otherwise hand a deleted site's id to the next
  // one — and that new site would inherit the old site's rollups, which are
  // kept on deletion, showing a viewer history they were never granted.
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO sites (id, domain, created_at)
     SELECT MAX(
              COALESCE((SELECT MAX(id) FROM sites), 0),
              COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'site_id_high'), 0)
            ) + 1, ?, ?`,
  )
    .bind(domain, Math.floor(Date.now() / 1000))
    .run();
  const site = await c.env.DB.prepare('SELECT id, domain, created_at FROM sites WHERE domain = ?')
    .bind(domain)
    .first<SiteRow>();
  clearSiteCache();
  return c.json({ site });
});

app.delete('/api/sites/:id', async (c) => {
  if (!isOwner(c.get('user'))) return c.json(OWNER_ONLY, 403);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

  // Rollups are left in place deliberately — deleting a site should not silently
  // burn a large slice of the daily row-write budget. Its id is recorded as the
  // high-water mark instead, so no later site is ever given it (see POST above).
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM site_access WHERE site_id = ?').bind(id),
    c.env.DB.prepare(
      `INSERT INTO settings (key, value) SELECT 'site_id_high', CAST(id AS TEXT) FROM sites WHERE id = ?
       ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`,
    ).bind(id),
    c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id),
    // Every isolate's ingest cache rereads this within a minute (src/ingest.ts).
    c.env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('sites_gen', '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    ),
  ]);
  clearSiteCache();
  return c.json({ ok: true });
});

/* ---------------------------------------------------------------- people -- */

/** The account named by `:id`, with its role derived, or null. */
async function targetUser(c: AppContext): Promise<UserRow | null> {
  const id = Number.parseInt(c.req.param('id') ?? '', 10);
  const row = Number.isInteger(id) ? await getUserById(c.env.DB, id) : null;
  return row ? withRole(row, adminEmail(c.env)) : null;
}

async function publicUser(db: D1Database, user: UserRow) {
  return toPublicUser(user, await siteIdsFor(db, user.id));
}

app.get('/api/users', async (c) => {
  if (!isOwner(c.get('user'))) return c.json(OWNER_ONLY, 403);
  return c.json({ users: await listUsers(c.env.DB, adminEmail(c.env)) });
});

/**
 * Invite a viewer. No mail goes out here: an invitation is only permission to
 * sign in, and the invitee asks for their own code when they open the app.
 * That keeps this endpoint from being a way to send mail at all.
 */
app.post('/api/users', async (c) => {
  if (!isOwner(c.get('user'))) return c.json(OWNER_ONLY, 403);

  const body = await jsonBody(c);
  const email = normalizeEmail(String(body.email ?? ''));
  if (!isValidEmail(email)) return c.json({ error: 'enter a valid email address' }, 400);
  if (email === adminEmail(c.env)) {
    return c.json({ error: 'that is the administrator, who can already see everything' }, 400);
  }

  const created = await createUser(c.env.DB, { email, siteIds: parseSiteIds(body.siteIds) });
  if (!created) return c.json({ error: 'that email has already been invited' }, 409);

  return c.json({ user: await publicUser(c.env.DB, withRole(created, adminEmail(c.env))) });
});

app.patch('/api/users/:id', async (c) => {
  if (!isOwner(c.get('user'))) return c.json(OWNER_ONLY, 403);

  const target = await targetUser(c);
  if (!target) return c.json({ error: 'no such user' }, 404);
  if (isOwner(target)) {
    return c.json({ error: 'the administrator sees every site; there is nothing to grant' }, 400);
  }

  const body = await jsonBody(c);
  if (!Array.isArray(body.siteIds)) return c.json({ error: 'siteIds must be an array of site ids' }, 400);

  await setSiteAccess(c.env.DB, target.id, parseSiteIds(body.siteIds));
  return c.json({ user: await publicUser(c.env.DB, target) });
});

/** Removing someone also signs them out everywhere and disconnects their agents. */
app.delete('/api/users/:id', async (c) => {
  if (!isOwner(c.get('user'))) return c.json(OWNER_ONLY, 403);

  const target = await targetUser(c);
  if (!target) return c.json({ error: 'no such user' }, 404);
  // Admin rights come from ADMIN_EMAIL; deleting the row would only be undone
  // by their next sign-in, and would sign them out meanwhile.
  if (isOwner(target)) {
    return c.json({ error: 'the administrator is set by ADMIN_EMAIL and cannot be removed here' }, 400);
  }

  await deleteUser(c.env.DB, target);
  return c.json({ ok: true });
});

/* ------------------------------------------------------ connected agents -- */

// Each person manages only their own agents: a grant reads with its user's
// access, so it is theirs to see and to disconnect. The administrator ends
// someone else's agents by removing that person, which deletes their grants.
app.get('/api/oauth/grants', async (c) =>
  c.json({ grants: await listGrants(c.env.DB, c.get('user').id) }, 200, NO_STORE),
);

app.delete('/api/oauth/grants/:id', async (c) => {
  const removed = await deleteGrant(c.env.DB, c.get('user').id, c.req.param('id'));
  return removed ? c.json({ ok: true }) : c.json({ error: 'no such connected agent' }, 404);
});

/* ----------------------------------------------------------------- stats -- */

type SiteRow = Awaited<ReturnType<typeof accessibleSites>>[number];

/**
 * The site the request is asking about. Shared with the MCP tools through
 * reports.ts findSite, which checks the grant table rather than the list we
 * happen to have rendered, so a crafted site id cannot read another tenant's
 * numbers. A refusal is thrown as a ReportError and answered by onError; the
 * Response in the return type is kept for callers written against the older
 * shape.
 *
 * Without a numeric `site` the first readable site is the answer — the app
 * opens on "whatever you have".
 */
async function resolveSite(c: AppContext): Promise<SiteRow | Response> {
  const requested = Number.parseInt(c.req.query('site') ?? '', 10);
  const user = c.get('user');
  // The owner can read every site, so a numeric id needs only that one row.
  // findSite lists every site the caller can see, which for the owner of a
  // full fleet is a hundred rows read on every report — and the realtime
  // panel asks every thirty seconds.
  if (Number.isInteger(requested) && isOwner(user)) {
    const site = await c.env.DB.prepare('SELECT id, domain, created_at FROM sites WHERE id = ?')
      .bind(requested)
      .first<SiteRow>();
    if (!site) throw new ReportError(404, 'no such site');
    return site;
  }
  return findSite(c.env.DB, user, Number.isInteger(requested) ? requested : undefined, true);
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

app.get('/api/stats', async (c) => {
  const site = await resolveSite(c);
  if (site instanceof Response) return site;

  const now = new Date();
  const today = partsFor(now).day;
  const from = c.req.query('from') ?? dayOffset(now, -6);
  const to = c.req.query('to') ?? today;

  if (!isValidDay(from) || !isValidDay(to) || from > to) {
    return c.json({ error: 'invalid date range' }, 400);
  }

  await catchUpToday(c.env.DB, now);

  const stats = await getStats(c.env.DB, site.id, from, to, now);
  return c.json({ site, stats }, 200, NO_STORE);
});

/**
 * The ReportQuery the HTTP API's query string describes. The reports
 * themselves live in src/reports.ts, shared with the MCP tools, so the app and
 * an agent can never disagree about a number.
 */
function reportQuery(c: AppContext) {
  return {
    range: c.req.query('range'),
    from: c.req.query('from'),
    to: c.req.query('to'),
    f: c.req.query('f'),
    compare: c.req.query('cmp') === '1',
  };
}

/**
 * Everything the console's header and hero need, in one request: totals and
 * the per-bucket series for all five metrics (see summaryReport for why all
 * five).
 */
app.get('/api/summary', async (c) => {
  const site = await resolveSite(c);
  if (site instanceof Response) return site;

  const started = Date.now();
  const report = await summaryReport(c.env.DB, site, reportQuery(c), new Date());
  return c.json(
    {
      ...report,
      // Shown in the header. Being able to see what a page cost is the whole
      // reason this design keeps a query time in the chrome.
      meta: { ms: Date.now() - started, colo: (c.req.raw.cf?.colo as string | undefined) ?? '' },
    },
    200,
    NO_STORE,
  );
});

/** The documented single-metric series, for anything scripting against this. */
app.get('/api/timeseries', async (c) => {
  const site = await resolveSite(c);
  if (site instanceof Response) return site;
  const query = { ...reportQuery(c), metric: c.req.query('metric') };
  return c.json(await timeseriesReport(c.env.DB, site, query, new Date()), 200, NO_STORE);
});

/**
 * Rank one or more dimensions. `?dim=path,country` answers both in one trip,
 * which is what the console does — six panels, one request.
 */
app.get('/api/breakdown', async (c) => {
  const site = await resolveSite(c);
  if (site instanceof Response) return site;

  const parsed = Number.parseInt(c.req.query('limit') ?? '', 10);
  const query = {
    ...reportQuery(c),
    dims: (c.req.query('dim') ?? 'path').split(','),
    limit: Number.isInteger(parsed) ? parsed : undefined,
  };
  return c.json(await breakdownReport(c.env.DB, site, query, new Date()), 200, NO_STORE);
});

/* ---- analytics-track routes: app analytics endpoints are mounted here ---- */

/**
 * App analytics (docs/api.md, "App analytics"). Same site resolution and
 * access check as every other report; the loaders live in
 * src/app-analytics.ts, shared with the MCP tools.
 */
function appRange(c: AppContext, now: Date): { from: string; to: string } | null {
  return resolveRange(c.req.query('range'), c.req.query('from'), c.req.query('to'), now);
}

app.get('/api/active-users', async (c) => {
  const site = await resolveSite(c);
  if (site instanceof Response) return site;
  const now = new Date();
  const range = appRange(c, now);
  if (!range) return c.json({ error: 'invalid range' }, 400);
  return c.json(await loadActiveUsers(c.env.DB, site.id, range, now), 200, NO_STORE);
});

app.get('/api/retention', async (c) => {
  const site = await resolveSite(c);
  if (site instanceof Response) return site;
  const cohort = c.req.query('cohort') ?? 'day';
  if (cohort !== 'day' && cohort !== 'week') return c.json({ error: 'cohort must be day or week' }, 400);
  const periods = Number.parseInt(c.req.query('periods') ?? '8', 10);
  return c.json(await loadRetention(c.env.DB, site.id, cohort, periods, new Date()), 200, NO_STORE);
});

app.get('/api/events', async (c) => {
  const site = await resolveSite(c);
  if (site instanceof Response) return site;
  const now = new Date();
  const range = appRange(c, now);
  if (!range) return c.json({ error: 'invalid range' }, 400);
  const filters = parseFilters(c.req.query('f'));
  const spanError = filterSpanError(range.from, range.to, filters);
  if (spanError) return c.json({ error: spanError }, 400);
  return c.json(await loadEvents(c.env.DB, site.id, range, filters, now), 200, NO_STORE);
});

app.get('/api/event-properties', async (c) => {
  const site = await resolveSite(c);
  if (site instanceof Response) return site;
  const now = new Date();
  const range = appRange(c, now);
  if (!range) return c.json({ error: 'invalid range' }, 400);
  const event = c.req.query('event');
  if (!event) return c.json({ error: 'event is required' }, 400);
  const limit = Number.parseInt(c.req.query('limit') ?? '10', 10);
  return c.json(
    await loadEventProperties(c.env.DB, site.id, range, event, c.req.query('key') || undefined, limit, now),
    200,
    NO_STORE,
  );
});

app.get('/api/event-series', async (c) => {
  const site = await resolveSite(c);
  if (site instanceof Response) return site;
  const now = new Date();
  const range = resolveRange(c.req.query('range'), c.req.query('from'), c.req.query('to'), now);
  if (!range) return c.json({ error: 'invalid range' }, 400);
  const event = c.req.query('event');
  if (!event) return c.json({ error: 'event is required' }, 400);
  const filters = parseFilters(c.req.query('f'));
  const spanError = filterSpanError(range.from, range.to, filters);
  if (spanError) return c.json({ error: spanError }, 400);
  return c.json(await loadEventSeries(c.env.DB, site.id, range, event, filters, now), 200, NO_STORE);
});

app.get('/api/realtime', async (c) => {
  const site = await resolveSite(c);
  if (site instanceof Response) return site;
  return c.json(await realtimeReport(c.env.DB, site, new Date(), c.req.query('since')), 200, NO_STORE);
});

/**
 * Country outlines for the geography panel.
 *
 * Shipped with the Worker and served from our own origin rather than pulled
 * from a CDN: a dashboard that phones out to a third party to draw a privacy
 * tool would be an odd look, and it keeps the console working on a locked-down
 * network. Immutable, so a browser fetches it once.
 */
app.get('/api/world.json', (c) =>
  c.json(WORLD_GEOMETRY, 200, { 'cache-control': 'public, max-age=31536000, immutable' }),
);

/* --------------------------------------------------- OAuth + MCP (agents) -- */

// Mounted before the tracker's catch-all `/:name` routes below: Hono answers
// with the first route that matches, and `POST /mcp` must reach the MCP server,
// not the ingest endpoint (RESERVED_PATHS is the second line of defence).
// Outside /api on purpose — their paths are fixed by the OAuth and MCP specs,
// and they carry their own CORS and their own token checks.
app.route('/', oauthRoutes);
app.route('/', mcpRoutes);

app.get('/health', (c) => c.json({ ok: true }));

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

/* ----------------------------------------------------------------- icon -- */

// Served on both names. `/favicon.svg` is what the pages link to; `/favicon.ico`
// is what a browser asks for on its own before it has parsed any markup, and
// answering that with the SVG — which browsers accept, since they go by the
// content type rather than the extension — is cheaper than a second asset and
// quieter than a 404 on every cold load.
//
// Public and cacheable, unlike every HTML surface here: the mark is the same
// bytes for everyone and says nothing about who asked for it.
const faviconResponse = (c: AppContext) =>
  c.body(FAVICON_SVG, 200, {
    'content-type': 'image/svg+xml',
    'cache-control': 'public, max-age=86400',
  });

app.get('/favicon.svg', faviconResponse);
app.get('/favicon.ico', faviconResponse);

/* ------------------------------------- tracker script + matching endpoint -- */

// `GET /anything.js` serves the tracker; `POST /anything` receives its beacons.
// Keeping the pair in lockstep means changing the path is a one-word edit in the
// snippet, with no server-side configuration at all.
app.get('/:file{[A-Za-z0-9._-]+\\.js}', (c) => {
  if (RESERVED_PATHS.has(c.req.param('file'))) return c.notFound();
  return trackerResponse();
});

app.options('/:name{[A-Za-z0-9._-]+}', (c) => {
  if (RESERVED_PATHS.has(c.req.param('name'))) return c.notFound();
  return corsPreflight();
});

/**
 * One fold unit, sent by the scheduled run through the SELF service binding
 * so that every unit gets a request's own CPU budget (src/rollup.ts). Not part
 * of the API: it answers only a caller holding the install's fold secret,
 * which lives in `settings` and never leaves the Worker.
 */
app.post('/internal/fold', async (c) => {
  const secret = await foldSecret(c.env.DB);
  if (!secret || c.req.header('x-fold-secret') !== secret) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { sites?: unknown } | null;
  const sites = Array.isArray(body?.sites) ? body.sites.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 64) : [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const from = blocksFromDayNumber(await blocksFrom(c.env.DB));
  const results = await foldUnit(c.env.DB, sites, nowSeconds, from);
  return c.json({ results }, 200, NO_STORE);
});

app.post('/:name{[A-Za-z0-9._-]+}', (c) => {
  if (RESERVED_PATHS.has(c.req.param('name'))) return c.notFound();
  return handleIngest(c.req.raw, c.env);
});

export default {
  /**
   * The front door. Static assets (the NSH web build, see wrangler.jsonc
   * "assets") are matched by Cloudflare before the Worker runs, except for the
   * paths listed in `run_worker_first` — and `/*.js` has to be one of them,
   * because the tracker answers `GET /<anything>.js`. So the app's own
   * JavaScript arrives here too, and goes back to the asset store before Hono
   * ever sees it; everything else is the API, OAuth, MCP and the tracker.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const asset = await serveAppAsset(request, env);
    return asset ?? app.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const run = async (): Promise<void> => {
      await ensureSchema(env.DB);
      const now = new Date(controller.scheduledTime);
      const retention = Number.parseInt(env.HOURLY_RETENTION_DAYS ?? '', 10);
      // The once-a-day trigger: a backstop for the nightly work, and the update check.
      const backstop = controller.cron.startsWith('25 0 ');

      try {
        await scheduledRun(env.DB, now, {
          retentionDays: Number.isFinite(retention) ? retention : 7,
          cube: cubeEnabled(env),
          nightly: backstop,
          dispatch: await selfDispatch(env),
        });
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', job: controller.cron, message: String(error) }));
        throw error;
      }

      // Deliberately after the rollup and in its own try: GitHub being
      // unreachable is not a reason to lose a day of stats, and a thrown error
      // here would retry the whole invocation, rollup included.
      if (backstop) {
        try {
          await checkForUpdate(env);
        } catch (error) {
          console.error(JSON.stringify({ level: 'warn', job: 'update-check', message: String(error) }));
        }
      }
    };

    ctx.waitUntil(run());
  },
};

/* ------------------------------------------------------------ fold units -- */

let secretCache: string | null = null;

/** The install's fold secret, created on first use (one row, once). */
async function foldSecret(db: D1Database): Promise<string | null> {
  if (secretCache) return secretCache;
  secretCache = await getSetting(db, SETTING_FOLD_SECRET);
  return secretCache;
}

/**
 * Units go out through the SELF binding (wrangler.jsonc "services"), which
 * must name this Worker: a renamed Worker needs the binding renamed with it,
 * or the cron falls back to folding one unit per run inline (README).
 */
async function selfDispatch(env: Env): Promise<((sites: number[]) => Promise<void>) | undefined> {
  const self = (env as Env & { SELF?: Fetcher }).SELF;
  if (!self) return undefined;
  let secret = await foldSecret(env.DB);
  if (!secret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const fresh = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .bind(SETTING_FOLD_SECRET, fresh)
      .run();
    secretCache = null;
    secret = await foldSecret(env.DB);
  }
  const key = secret ?? '';
  return async (sites) => {
    const res = await self.fetch('https://self/internal/fold', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fold-secret': key },
      body: JSON.stringify({ sites }),
    });
    if (!res.ok) throw new Error(`fold unit answered ${res.status}`);
    await res.body?.cancel();
  };
}
