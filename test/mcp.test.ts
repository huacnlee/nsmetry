/**
 * The MCP server (src/mcp.ts): Streamable HTTP, stateless JSON answers,
 * authorized by OAuth access tokens (or an app session token), with the same
 * per-site access as the HTTP API.
 *
 * Access tokens are minted directly as grant rows here — the authorize flow
 * that produces them is covered end to end in test/oauth.test.ts.
 */

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { randomHex, sha256Hex } from '../src/auth';
import { ensureSchema } from '../src/db';
import { PROTOCOL_VERSIONS } from '../src/mcp';
import { createSession } from '../src/sessions';
import { createUser, ensureAdminAccount } from '../src/users';

const db = env.DB;
const ADMIN = 'owner@example.com';
const BASE = 'https://nsmetry.test';

async function reset(): Promise<void> {
  await ensureSchema(db);
  for (const table of ['sessions', 'auth_codes', 'auth_limits', 'site_access', 'users', 'sites', 'settings', 'oauth_grants', 'oauth_codes']) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.batch([
    db.prepare("INSERT INTO sites (id, domain, created_at) VALUES (1, 'example.com', 0)"),
    db.prepare("INSERT INTO sites (id, domain, created_at) VALUES (2, 'my-app', 0)"),
  ]);
}

beforeEach(reset);

/** A grant row and its access token, as /oauth/token would have issued them. */
async function accessTokenFor(userId: number, tokenVersion = 1): Promise<string> {
  const id = randomHex(8);
  const access = `nsa_${id}_${randomHex(32)}`;
  const at = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO oauth_grants (id, user_id, client_id, client_name, scope, token_version, access_hash,
                                 access_expires_at, refresh_hash, refresh_expires_at, created_at, last_used_at)
       VALUES (?, ?, 'nsc1.test', 'Test Agent', 'read', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, tokenVersion, await sha256Hex(access), at + 3600, 'x', at + 86400, at, at)
    .run();
  return access;
}

async function adminToken(): Promise<string> {
  const admin = (await ensureAdminAccount(db, ADMIN))!;
  return accessTokenFor(admin.id, admin.token_version);
}

async function viewerToken(siteIds: number[]): Promise<string> {
  const viewer = await createUser(db, { email: 'viewer@example.com', siteIds });
  return accessTokenFor(viewer!.id, viewer!.token_version);
}

let nextId = 1;

async function rpc(
  token: string | null,
  method: string,
  params?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
  });
}

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const response = await rpc(token, 'tools/call', { name, arguments: args });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: ToolResult };
  return body.result;
}

describe('authorization', () => {
  it('answers 401 with a pointer to the resource metadata', async () => {
    const response = await rpc(null, 'initialize', { protocolVersion: '2025-06-18' });
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate')!;
    expect(challenge).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect(response.headers.get('access-control-expose-headers')).toContain('www-authenticate');
  });

  it('flags a bad token as invalid_token', async () => {
    const response = await rpc('nsa_0000000000000000_' + '0'.repeat(64), 'ping');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('refuses an expired access token', async () => {
    const admin = (await ensureAdminAccount(db, ADMIN))!;
    const token = await accessTokenFor(admin.id, admin.token_version);
    await db.prepare('UPDATE oauth_grants SET access_expires_at = 1').run();
    expect((await rpc(token, 'ping')).status).toBe(401);
  });

  it('accepts an app session token too', async () => {
    const admin = (await ensureAdminAccount(db, ADMIN))!;
    const session = await createSession(db, admin.id, 'cli');
    const response = await rpc(session, 'ping');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', result: {} });
  });

  it('answers CORS preflight', async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toContain('mcp-protocol-version');
  });

  it('answers 405 to GET: there is no server-to-client stream', async () => {
    expect((await SELF.fetch(`${BASE}/mcp`)).status).toBe(405);
  });
});

describe('protocol', () => {
  it('negotiates the protocol version on initialize', async () => {
    const token = await adminToken();
    const response = await rpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = (await response.json()) as { result: Record<string, unknown> };
    expect(body.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'nsmetry' },
    });
    expect(body.result.instructions).toEqual(expect.any(String));

    // An unknown version is answered with the newest this server speaks.
    const other = (await (await rpc(token, 'initialize', { protocolVersion: '1999-01-01' })).json()) as {
      result: { protocolVersion: string };
    };
    expect(other.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it('answers notifications with 202 and no body', async () => {
    const token = await adminToken();
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('refuses an unsupported MCP-Protocol-Version header', async () => {
    const token = await adminToken();
    const response = await rpc(token, 'ping', undefined, { 'mcp-protocol-version': '1999-01-01' });
    expect(response.status).toBe(400);
  });

  it('reports parse errors, batches and unknown methods as JSON-RPC errors', async () => {
    const token = await adminToken();
    const send = (body: string) =>
      SELF.fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
      });
    expect(((await (await send('{nope')).json()) as { error: { code: number } }).error.code).toBe(-32700);
    expect((await send('[]')).status).toBe(400);
    const unknown = (await (await rpc(token, 'resources/list')).json()) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
  });
});

describe('tools', () => {
  it('lists read-only tools with JSON Schemas', async () => {
    const token = await adminToken();
    const body = (await (await rpc(token, 'tools/list')).json()) as {
      result: { tools: { name: string; description: string; inputSchema: { type: string }; annotations: Record<string, unknown> }[] };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_sites', 'get_summary', 'get_breakdown', 'get_timeseries', 'get_realtime',
        'get_active_users', 'get_retention', 'get_events', 'get_event_properties', 'get_event_series',
      ]),
    );
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it('lists every site for the administrator', async () => {
    const result = await callTool(await adminToken(), 'list_sites');
    expect(result.isError).toBeUndefined();
    const sites = (result.structuredContent as { sites: { domain: string }[] }).sites.map((s) => s.domain);
    expect(sites.sort()).toEqual(['example.com', 'my-app']);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it('runs the reports for a site, by name or by id', async () => {
    const token = await adminToken();
    const summary = await callTool(token, 'get_summary', { site: 'my-app', range: '7d' });
    expect(summary.isError).toBeUndefined();
    expect(summary.structuredContent).toBeTypeOf('object');

    const breakdown = await callTool(token, 'get_breakdown', { site: 1, dims: ['path', 'country'], limit: 5 });
    expect(breakdown.isError).toBeUndefined();
    expect(breakdown.structuredContent).toHaveProperty('breakdowns');

    const series = await callTool(token, 'get_timeseries', { site: 'example.com', metric: 'views', range: '30d' });
    expect(series.isError).toBeUndefined();

    const realtime = await callTool(token, 'get_realtime', { site: 'example.com' });
    expect(realtime.isError).toBeUndefined();
  });

  it('runs the app reports', async () => {
    const token = await adminToken();
    const users = await callTool(token, 'get_active_users', { site: 'my-app', range: '7d' });
    expect(users.isError).toBeUndefined();
    expect(users.structuredContent).toHaveProperty('tracked');

    const retention = await callTool(token, 'get_retention', { site: 'my-app', cohort: 'day', periods: 4 });
    expect(retention.isError).toBeUndefined();
    expect(retention.structuredContent).toHaveProperty('cohorts');

    const events = await callTool(token, 'get_events', { site: 'my-app' });
    expect(events.structuredContent).toHaveProperty('events');

    const keys = await callTool(token, 'get_event_properties', { site: 'my-app', event: 'purchase' });
    expect(keys.structuredContent).toHaveProperty('keys');
    const values = await callTool(token, 'get_event_properties', { site: 'my-app', event: 'purchase', key: 'plan' });
    expect(values.structuredContent).toHaveProperty('values');

    const trend = await callTool(token, 'get_event_series', { site: 'my-app', event: 'purchase', range: '7d' });
    expect(trend.isError).toBeUndefined();
    expect(trend.structuredContent).toMatchObject({ granularity: 'day' });
    expect((trend.structuredContent as { labels: string[] }).labels).toHaveLength(7);
    expect((await callTool(token, 'get_event_series', { site: 'my-app' })).isError).toBe(true);

    // The model's own mistakes come back as tool errors it can read.
    expect((await callTool(token, 'get_retention', { site: 'my-app', cohort: 'month' })).isError).toBe(true);
    expect((await callTool(token, 'get_active_users', { site: 'my-app', from: '2026-13-01' })).isError).toBe(true);
    expect((await callTool(token, 'get_event_properties', { site: 'my-app' })).isError).toBe(true);
  });

  it('gives a viewer only the sites they were granted', async () => {
    const token = await viewerToken([2]);
    const listed = await callTool(token, 'list_sites');
    expect((listed.structuredContent as { sites: { domain: string }[] }).sites.map((s) => s.domain)).toEqual(['my-app']);

    const allowed = await callTool(token, 'get_summary', { site: 'my-app' });
    expect(allowed.isError).toBeUndefined();

    // Refused the same way whether the site exists or not, so it cannot probe.
    for (const site of ['example.com', 1, 'nope.example']) {
      const forbidden = await callTool(token, 'get_summary', { site });
      expect(forbidden.isError).toBe(true);
      expect(forbidden.content[0]!.text).toBe('forbidden');
    }
  });

  it('returns a tool error the model can read for a missing site or a bad range', async () => {
    const token = await adminToken();
    const missing = await callTool(token, 'get_summary', {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toMatch(/list_sites/);
  });

  it('answers an unknown tool with a JSON-RPC error', async () => {
    const body = (await (await rpc(await adminToken(), 'tools/call', { name: 'drop_tables' })).json()) as {
      error: { code: number };
    };
    expect(body.error.code).toBe(-32602);
  });
});
