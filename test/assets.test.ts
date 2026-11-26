/**
 * The app's web build and the tracker share one origin.
 *
 * wrangler.jsonc sends every `/*.js` to the Worker first, because the tracker
 * answers `GET /<any name>.js`; src/assets.ts then hands the app's own scripts
 * back to the asset store. These tests pin both halves: what the Worker
 * answers itself, and the asset logic against a fake store. (`SELF` reaches
 * the Worker directly, so the asset store's own matching — `/` serving
 * index.html — is checked with `wrangler dev`, not here.)
 */
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { serveAppAsset } from '../src/assets';

const BASE = 'https://stats.example.com';

describe('one origin for the app and the tracker', () => {
  it('serves the tracker at any single-segment .js name', async () => {
    for (const name of ['script.js', 'em.js', 'a1b2.js']) {
      const response = await SELF.fetch(`${BASE}/${name}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('javascript');
      expect(await response.text()).toContain('sendBeacon');
    }
  });

  it('still takes beacons at POST /<name> and the API', async () => {
    // The ingest handler's empty 2xx/404 — which proves the Worker, not the
    // asset store (405) or the app's index.html (200 with a body), got it.
    const beacon = await SELF.fetch(`${BASE}/e`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ d: 'nobody.example', n: 'pageview', u: 'https://nobody.example/' }),
    });
    expect([204, 404]).toContain(beacon.status);
    expect((await SELF.fetch(`${BASE}/api/me`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/health`)).status).toBe(200);
  });

  it('answers OAuth pages from the Worker, not the app', async () => {
    const response = await SELF.fetch(`${BASE}/oauth/authorize`, {
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    // The Worker's own error page for a request with no client_id, not the app.
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('nsh-app');
  });
});

describe('serveAppAsset', () => {
  /** A fake asset store holding a few files, as `nsh package` names them. */
  function store(files: Record<string, string>) {
    const seen: string[] = [];
    const fetcher = {
      async fetch(input: RequestInfo | URL): Promise<Response> {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        seen.push(path);
        const body = files[path];
        if (body === undefined) return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/plain', etag: '"x"' } });
      },
    };
    return { env: { ...env, ASSETS: fetcher as unknown as Fetcher } as Env, seen };
  }

  it('sends the Brotli copy of a hashed file when the browser takes it', async () => {
    const { env: e } = store({ '/app.0123456789.js': 'plain', '/app.0123456789.js.br': 'brotli' });
    const response = await serveAppAsset(
      new Request(`${BASE}/app.0123456789.js`, { headers: { 'accept-encoding': 'gzip, br' } }),
      e,
    );
    expect(response?.headers.get('content-encoding')).toBe('br');
    expect(response?.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response?.headers.get('cache-control')).toContain('immutable');
  });

  it('falls back to the plain file without a compressed copy', async () => {
    const { env: e } = store({ '/nsh.0123456789.wasm': 'wasm' });
    const response = await serveAppAsset(new Request(`${BASE}/nsh.0123456789.wasm`), e);
    expect(await response?.text()).toBe('wasm');
  });

  it('hands nested scripts to the asset store', async () => {
    const { env: e, seen } = store({ '/browser.de8aa0f5a1/dom.js': 'dom' });
    const response = await serveAppAsset(new Request(`${BASE}/browser.de8aa0f5a1/dom.js`), e);
    expect(await response?.text()).toBe('dom');
    expect(seen).toEqual(['/browser.de8aa0f5a1/dom.js']);
  });

  it('leaves tracker names, the API and non-GETs to the Worker', async () => {
    const { env: e } = store({});
    expect(await serveAppAsset(new Request(`${BASE}/script.js`), e)).toBeNull();
    // Looks hashed, but the build has no such file: still the tracker's.
    expect(await serveAppAsset(new Request(`${BASE}/t.0123456789.js`), e)).toBeNull();
    expect(await serveAppAsset(new Request(`${BASE}/api/x.js`), e)).toBeNull();
    expect(await serveAppAsset(new Request(`${BASE}/app.0123456789.js`, { method: 'POST' }), e)).toBeNull();
  });
});
