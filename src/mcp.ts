/**
 * The MCP server: AI agents read the analytics through tools.
 *
 * Transport is Streamable HTTP (MCP 2025-06-18) in its simplest legal form:
 * every POST /mcp carries one JSON-RPC message and is answered with one JSON
 * body — no SSE stream, no Mcp-Session-Id. Nothing here pushes anything to the
 * client, so a session would be state with nothing to hold, and statelessness
 * means a request costs no row writes beyond the auth lookup. GET (the
 * server-to-client stream) answers 405, which the spec allows.
 *
 * Authorization is OAuth 2.1 (src/oauth.ts). Without a valid token the answer
 * is 401 with `WWW-Authenticate: Bearer resource_metadata=…`, which is how a
 * client discovers where to sign in. An app's own bearer session token is also
 * accepted, so a script or a CLI that already signed in can use the same
 * tools without a second flow.
 *
 * Every tool is read-only and goes through the same per-site check as the
 * HTTP API (reports.ts findSite): an agent sees exactly what the person who
 * approved it can see, and the reports are the very functions the app's
 * routes call, so the two can never disagree about a number.
 */

import { Hono } from 'hono';

import { adminEmail } from './auth';
import { BREAKDOWN_DIMS } from './dimensions';
import { resolveAccessToken, resourceMetadataUrl, originOf } from './oauth';
import { loadActiveUsers, loadEventProperties, loadEvents, loadRetention } from './app-analytics';
import { MAX_PEOPLE, loadPeople } from './people';
import {
  METRICS,
  RANGE_IDS,
  type Filter,
  filterSpanError,
  loadEventSeries,
  parseFilters,
  resolveRange,
  serializeFilters,
} from './query';
import {
  ReportError,
  type ReportQuery,
  MAX_BREAKDOWN_LIMIT,
  breakdownReport,
  findSite,
  realtimeReport,
  summaryReport,
  timeseriesReport,
} from './reports';
import { bearerToken, resolveSession } from './sessions';
import { type UserRow, accessibleSites, getUserById, withRole } from './users';
import { VERSION } from './version';

/** Newest first. The first is what a client with an unknown version is offered. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

export const MCP_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  // A browser-based client must be able to read the 401's pointer to the
  // resource metadata, or it can never find out where to sign in.
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '86400',
};

/** One JSON-RPC message is small; this only stops someone streaming megabytes at us. */
const MAX_BODY_BYTES = 256 * 1024;

type Json = Record<string, unknown>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...MCP_CORS, ...headers },
  });
}

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

/* ------------------------------------------------------------------ auth -- */

/**
 * The user behind the request's bearer token: an OAuth access token first
 * (they are prefixed, so this costs nothing for the other kind), then an app
 * session token.
 */
async function authenticate(env: Env, header: string | undefined): Promise<UserRow | null> {
  const token = bearerToken(header);
  if (!token) return null;
  const viaOAuth = await resolveAccessToken(env, token);
  if (viaOAuth) return viaOAuth.user;
  const userId = await resolveSession(env.DB, token);
  if (userId === null) return null;
  const row = await getUserById(env.DB, userId);
  return row ? withRole(row, adminEmail(env)) : null;
}

/* ----------------------------------------------------------------- tools -- */

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  run: (env: Env, user: UserRow, args: Json) => Promise<unknown>;
}

/** Every tool only reads; telling the client so lets it skip the confirmation prompt. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const SITE_PROPERTY = {
  oneOf: [{ type: 'integer' }, { type: 'string' }],
  description: 'The site: its numeric id or its name/domain exactly as list_sites shows it (e.g. "example.com", "my-app").',
};

const RANGE_PROPERTIES = {
  range: {
    type: 'string',
    enum: RANGE_IDS,
    description:
      'Preset window ending today (UTC): today, 7d, 30d, 90d or 12mo. Default 30d. Ignored when from/to are given.',
  },
  from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Custom window start, YYYY-MM-DD (UTC).' },
  to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Custom window end, YYYY-MM-DD (UTC), inclusive.' },
  filters: {
    type: 'array',
    description:
      'Narrow to page/screen views matching every filter, e.g. [{"dim":"country","value":"DE"},{"dim":"path","value":"/pricing"}]. ' +
      'Countries are ISO 3166-1 alpha-2 codes.',
    items: {
      type: 'object',
      properties: {
        dim: {
          type: 'string',
          description: 'path, referrer, country, browser, os, device, screen, utm_source, utm_medium or utm_campaign.',
        },
        value: { type: 'string' },
      },
      required: ['dim', 'value'],
      additionalProperties: false,
    },
    maxItems: 12,
  },
  compare: { type: 'boolean', description: 'Also return the previous window of the same length. Default false.' },
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function siteRef(value: unknown): number | string | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

/** Tool arguments → the query the HTTP API would have received. */
function reportQuery(args: Json): ReportQuery {
  const filters: Filter[] = Array.isArray(args.filters)
    ? args.filters.flatMap((f: unknown) => {
        if (!f || typeof f !== 'object') return [];
        const { dim, value } = f as Json;
        return typeof dim === 'string' && typeof value === 'string' ? [{ dim, value }] : [];
      })
    : [];
  return {
    range: str(args.range),
    from: str(args.from),
    to: str(args.to),
    f: serializeFilters(filters),
    compare: args.compare === true,
  };
}

/**
 * The app tools' window, resolved the way the HTTP API's app routes resolve
 * theirs (src/index.ts, appRange). A bad window is the model's mistake to fix,
 * so it comes back as a tool error rather than a protocol one.
 */
function appWindow(args: Json, now: Date): { from: string; to: string } {
  const range = resolveRange(str(args.range) ?? '30d', str(args.from), str(args.to), now);
  if (!range) throw new ReportError(400, 'invalid range');
  return range;
}

const TOOLS: Tool[] = [
  {
    name: 'list_sites',
    title: 'List sites',
    description:
      'List the sites and apps you can read, with their ids. A site is a website domain (example.com) or an app name ' +
      '(my-app). Call this first: every other tool needs a site.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (env, user) => ({ sites: await accessibleSites(env.DB, user) }),
  },
  {
    name: 'get_summary',
    title: 'Summary',
    description:
      'Headline numbers for one site over a window: visitors (unique per day), views (page or screen views), vpv ' +
      '(views per visit), bounce (% of single-view visits) and time (average visit seconds), as totals and as a ' +
      'series per hour/day/week/month. With compare=true, the previous window too.',
    inputSchema: {
      type: 'object',
      properties: { site: SITE_PROPERTY, ...RANGE_PROPERTIES },
      required: ['site'],
      additionalProperties: false,
    },
    run: async (env, user, args) => {
      const site = await findSite(env.DB, user, siteRef(args.site), false);
      return summaryReport(env.DB, site, reportQuery(args), new Date());
    },
  },
  {
    name: 'get_breakdown',
    title: 'Breakdown',
    description:
      'Top values of one or more dimensions for one site, ranked by visitors: pages or app screens (path), entry and ' +
      'exit pages, referrers, countries, browsers, operating systems, device types, screen sizes, UTM tags, and ' +
      'custom event names (event). Each row is { name, value, visits }.',
    inputSchema: {
      type: 'object',
      properties: {
        site: SITE_PROPERTY,
        dims: {
          type: 'array',
          items: { type: 'string', enum: [...BREAKDOWN_DIMS] },
          minItems: 1,
          description: 'Dimensions to rank. Default ["path"].',
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_BREAKDOWN_LIMIT, description: 'Rows per dimension. Default 10.' },
        ...RANGE_PROPERTIES,
      },
      required: ['site'],
      additionalProperties: false,
    },
    run: async (env, user, args) => {
      const site = await findSite(env.DB, user, siteRef(args.site), false);
      const dims = Array.isArray(args.dims) && args.dims.length ? args.dims.map(String) : ['path'];
      const limit = typeof args.limit === 'number' ? Math.trunc(args.limit) : undefined;
      const { breakdowns } = await breakdownReport(env.DB, site, { ...reportQuery(args), dims, limit }, new Date());
      return { breakdowns };
    },
  },
  {
    name: 'get_timeseries',
    title: 'Time series',
    description:
      'One metric for one site, point by point (hourly for one day, daily up to 45 days, weekly, then monthly). ' +
      'Each point is { label, cur, prev }; prev is set when compare=true.',
    inputSchema: {
      type: 'object',
      properties: {
        site: SITE_PROPERTY,
        metric: { type: 'string', enum: [...METRICS], description: 'Default visitors.' },
        ...RANGE_PROPERTIES,
      },
      required: ['site'],
      additionalProperties: false,
    },
    run: async (env, user, args) => {
      const site = await findSite(env.DB, user, siteRef(args.site), false);
      return timeseriesReport(env.DB, site, { ...reportQuery(args), metric: str(args.metric) }, new Date());
    },
  },
  {
    name: 'get_realtime',
    title: 'Realtime',
    description:
      'Who is on one site right now: visitors in the last 5 minutes (online), views per minute for the last half ' +
      'hour, and the most recent views with their path and country.',
    inputSchema: {
      type: 'object',
      properties: { site: SITE_PROPERTY },
      required: ['site'],
      additionalProperties: false,
    },
    run: async (env, user, args) => {
      const site = await findSite(env.DB, user, siteRef(args.site), false);
      return realtimeReport(env.DB, site, new Date());
    },
  },
  {
    name: 'get_active_users',
    title: 'Active users',
    description:
      'For an app (or any site that sends a user_id): daily active users and new users per day over the window, ' +
      'distinct users over it, and WAU/MAU ending on its last day. tracked=false means the site has never sent a ' +
      'user_id. dau and new are exact; wau, mau and multi-day totals are estimates (about 1.6% error).',
    inputSchema: {
      type: 'object',
      properties: { site: SITE_PROPERTY, range: RANGE_PROPERTIES.range, from: RANGE_PROPERTIES.from, to: RANGE_PROPERTIES.to },
      required: ['site'],
      additionalProperties: false,
    },
    run: async (env, user, args) => {
      const site = await findSite(env.DB, user, siteRef(args.site), false);
      const now = new Date();
      return loadActiveUsers(env.DB, site.id, appWindow(args, now), now);
    },
  },
  {
    name: 'get_retention',
    title: 'Retention',
    description:
      'Cohort retention for an app that sends a user_id: users grouped by the day or week they were first seen; ' +
      'retained[i] is how many of a cohort were active i periods later (retained[0] is the cohort size).',
    inputSchema: {
      type: 'object',
      properties: {
        site: SITE_PROPERTY,
        cohort: { type: 'string', enum: ['day', 'week'], description: 'Cohort size. Default week.' },
        periods: { type: 'integer', minimum: 1, maximum: 26, description: 'How many cohorts and periods. Default 8.' },
      },
      required: ['site'],
      additionalProperties: false,
    },
    run: async (env, user, args) => {
      const site = await findSite(env.DB, user, siteRef(args.site), false);
      const cohort = args.cohort === undefined ? 'week' : args.cohort;
      if (cohort !== 'day' && cohort !== 'week') throw new ReportError(400, 'cohort must be day or week');
      const periods = typeof args.periods === 'number' ? Math.trunc(args.periods) : 8;
      return loadRetention(env.DB, site.id, cohort, periods, new Date());
    },
  },
  {
    name: 'get_people',
    title: 'People',
    description:
      "For an app whose owner turned on keeping user ids: the people (the raw user_id the app sends, such as an " +
      'email) seen in the last `days` days, newest first, with first_seen and last_seen as Unix seconds (last_seen ' +
      'is accurate to an hour), and the total. enabled=false means the site does not keep user ids, so the list ' +
      'is empty.',
    inputSchema: {
      type: 'object',
      properties: {
        site: SITE_PROPERTY,
        days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window in days. Default 30.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_PEOPLE, description: `Most rows to list. Default ${MAX_PEOPLE}.` },
      },
      required: ['site'],
      additionalProperties: false,
    },
    run: async (env, user, args) => {
      const site = await findSite(env.DB, user, siteRef(args.site), false);
      const days = args.days === undefined ? 30 : args.days;
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) {
        throw new ReportError(400, 'days must be 1 to 365');
      }
      const limit = typeof args.limit === 'number' ? Math.trunc(args.limit) : MAX_PEOPLE;
      return loadPeople(env.DB, site.id, days, limit, Math.floor(Date.now() / 1000));
    },
  },
  {
    name: 'get_events',
    title: 'Custom events',
    description:
      'Custom events (everything except page and screen views) for one site over a window, most frequent first: ' +
      '{ name, count, users }. Filters narrow them like the other reports.',
    inputSchema: {
      type: 'object',
      properties: { site: SITE_PROPERTY, range: RANGE_PROPERTIES.range, from: RANGE_PROPERTIES.from, to: RANGE_PROPERTIES.to, filters: RANGE_PROPERTIES.filters },
      required: ['site'],
      additionalProperties: false,
    },
    run: async (env, user, args) => {
      const site = await findSite(env.DB, user, siteRef(args.site), false);
      const now = new Date();
      const window = appWindow(args, now);
      const filters = parseFilters(reportQuery(args).f);
      const spanError = filterSpanError(window.from, window.to, filters);
      if (spanError) throw new ReportError(400, spanError);
      return loadEvents(env.DB, site.id, window, filters, now);
    },
  },
  {
    name: 'get_event_properties',
    title: 'Event properties',
    description:
      "One custom event's properties over a window: without key, which property keys it carried and how often; " +
      "with key, that property's top values and their counts.",
    inputSchema: {
      type: 'object',
      properties: {
        site: SITE_PROPERTY,
        event: { type: 'string', description: 'The event name, as get_events lists it.' },
        key: { type: 'string', description: "A property key; omit to list the event's keys." },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Values to return for a key. Default 10.' },
        range: RANGE_PROPERTIES.range,
        from: RANGE_PROPERTIES.from,
        to: RANGE_PROPERTIES.to,
      },
      required: ['site', 'event'],
      additionalProperties: false,
    },
    run: async (env, user, args) => {
      const site = await findSite(env.DB, user, siteRef(args.site), false);
      const event = str(args.event);
      if (!event) throw new ReportError(400, 'event is required');
      const now = new Date();
      const limit = typeof args.limit === 'number' ? Math.trunc(args.limit) : 10;
      return loadEventProperties(env.DB, site.id, appWindow(args, now), event, str(args.key), limit, now);
    },
  },
  {
    name: 'get_event_series',
    title: 'Event over time',
    description:
      "One custom event's trend over a window: { granularity, labels, count, users }, one entry per bucket " +
      '(hours for today, then days, weeks or months as the window grows). count is how often it fired; users is ' +
      'distinct daily users who fired it, summed over the days of a bucket. Filters narrow it like the other reports.',
    inputSchema: {
      type: 'object',
      properties: {
        site: SITE_PROPERTY,
        event: { type: 'string', description: 'The event name, as get_events lists it.' },
        range: RANGE_PROPERTIES.range,
        from: RANGE_PROPERTIES.from,
        to: RANGE_PROPERTIES.to,
        filters: RANGE_PROPERTIES.filters,
      },
      required: ['site', 'event'],
      additionalProperties: false,
    },
    run: async (env, user, args) => {
      const site = await findSite(env.DB, user, siteRef(args.site), false);
      const event = str(args.event);
      if (!event) throw new ReportError(400, 'event is required');
      const now = new Date();
      const range = resolveRange(str(args.range) ?? '30d', str(args.from), str(args.to), now);
      if (!range) throw new ReportError(400, 'invalid range');
      const filters = parseFilters(reportQuery(args).f);
      const spanError = filterSpanError(range.from, range.to, filters);
      if (spanError) throw new ReportError(400, spanError);
      return loadEventSeries(env.DB, site.id, range, event, filters, now);
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function publicTool(tool: Tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.title, ...READ_ONLY },
  };
}

/**
 * A tool's answer. The JSON goes in a text block, which every client reads,
 * and again as structuredContent for clients on 2025-06-18 and later.
 */
function toolResult(data: unknown) {
  const structured = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : { result: data };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: structured };
}

/**
 * A failure the model should see and can act on — a wrong site, a bad range —
 * goes back as a tool result with isError, per the spec, rather than as a
 * protocol error the client would hide from it.
 */
function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/* --------------------------------------------------------------- JSON-RPC -- */

const INSTRUCTIONS =
  'NsMetry is privacy-first analytics for websites and native apps. All tools are read-only. ' +
  'Start with list_sites, then pass a site id or name to get_summary (headline numbers), get_breakdown ' +
  '(top pages/screens, referrers, countries, devices, events), get_timeseries (one metric over time) or ' +
  'get_realtime. For apps that send a user_id, get_active_users and get_retention; for custom events, ' +
  'get_events and get_event_properties. Days are UTC. Visitors are counted per day without cookies, so they are not de-duplicated ' +
  'across days.';

async function handleMessage(env: Env, user: UserRow, message: Json): Promise<Json | null> {
  const id = message.id;
  const isNotification = !('id' in message);
  const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Json;
  const ok = (result: unknown) => (isNotification ? null : { jsonrpc: '2.0', id, result });

  switch (message.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      const version = (PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'nsmetry', title: 'NsMetry', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS.map(publicTool) });
    case 'tools/call': {
      const tool = TOOLS_BY_NAME.get(String(params.name ?? ''));
      if (!tool) return isNotification ? null : rpcError(id, -32602, `unknown tool: ${String(params.name)}`);
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Json;
      try {
        return ok(toolResult(await tool.run(env, user, args)));
      } catch (error) {
        if (error instanceof ReportError) return ok(toolError(error.message));
        throw error;
      }
    }
    default:
      if (typeof message.method === 'string' && message.method.startsWith('notifications/')) return null;
      return isNotification ? null : rpcError(id, -32601, `method not found: ${String(message.method)}`);
  }
}

type McpEnv = { Bindings: Env };
export const mcpRoutes = new Hono<McpEnv>();

mcpRoutes.options('/mcp', () => new Response(null, { status: 204, headers: MCP_CORS }));

/** No server-to-client stream here; the spec's answer for that is 405. */
const notAllowed = () => json({ error: 'method not allowed' }, 405, { allow: 'POST, OPTIONS' });
mcpRoutes.get('/mcp', notAllowed);
mcpRoutes.delete('/mcp', notAllowed);

mcpRoutes.post('/mcp', async (c) => {
  const env = c.env;
  const base = originOf(c.req.raw);

  const user = await authenticate(env, c.req.header('authorization'));
  if (!user) {
    const presented = bearerToken(c.req.header('authorization')) !== '';
    return json(rpcError(null, -32001, 'unauthorized'), 401, {
      'www-authenticate':
        `Bearer resource_metadata="${resourceMetadataUrl(base)}", scope="read"` +
        (presented ? ', error="invalid_token"' : ''),
    });
  }

  // Absent means 2025-03-26 per the spec; present and unknown is refused so
  // the client learns now rather than through a subtly different exchange.
  const version = c.req.header('mcp-protocol-version');
  if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return json(rpcError(null, -32600, `unsupported MCP-Protocol-Version ${version}; use ${PROTOCOL_VERSIONS.join(', ')}`), 400);
  }

  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return json(rpcError(null, -32600, 'request too large'), 413);
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return json(rpcError(null, -32700, 'parse error'), 400);
  }
  // Batches were dropped from the protocol in 2025-06-18.
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return json(rpcError(null, -32600, 'send one JSON-RPC message per request'), 400);
  }
  const rpc = message as Json;

  // A response or notification from the client needs no answer: 202, no body.
  if (!('method' in rpc) || !('id' in rpc)) {
    if ('method' in rpc) await handleMessage(env, user, rpc);
    return new Response(null, { status: 202, headers: MCP_CORS });
  }
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return json(rpcError(rpc.id, -32600, 'invalid request'), 400);
  }

  const reply = await handleMessage(env, user, rpc);
  return reply ? json(reply) : new Response(null, { status: 202, headers: MCP_CORS });
});
