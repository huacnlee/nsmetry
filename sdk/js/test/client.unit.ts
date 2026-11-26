import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { batchUrl, createClient, sanitizeProps, type KeyValueStorage, type Platform } from '../src/core.js';
import { createNsMetry } from '../src/index.js';

interface Sent {
  url: string;
  body: { site: string; events: Array<Record<string, unknown>> };
}

/**
 * A deterministic platform: a manual clock, timers we fire by hand, and a
 * fetch whose answers the test scripts. Nothing here waits on real time.
 */
function fakePlatform(statuses: Array<number | 'throw'> = []) {
  let now = Date.UTC(2026, 10, 26, 12, 0, 0);
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextTimer = 1;
  const sent: Sent[] = [];
  const beaconed: Sent[] = [];
  let hide: (() => void) | undefined;
  const answers = [...statuses];

  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const status = answers.shift() ?? 204;
    if (status === 'throw') throw new TypeError('network down');
    sent.push({ url, body: JSON.parse(String(init.body)) as Sent['body'] });
    return new Response(null, { status });
  });

  const platform: Platform = {
    fetch,
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
    onHide: (fn) => {
      hide = fn;
      return () => {
        hide = undefined;
      };
    },
    randomId: () => 'anon-1',
  };

  return {
    platform,
    fetch,
    sent,
    beaconed,
    hide: () => hide?.(),
    hasHideListener: () => hide !== undefined,
    pendingTimers: () => timers.size,
    /** Moves the clock and fires every timer that came due. */
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
      await settle();
    },
    withBeacon(ok = true) {
      platform.beacon = (url, body) => {
        if (ok) beaconed.push({ url, body: JSON.parse(body) as Sent['body'] });
        return ok;
      };
    },
  };
}

/** Lets queued promise callbacks run. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const base = { endpoint: 'https://stats.example.com/', site: 'my-app' };

describe('batching', () => {
  it('sends nothing until the interval, then one request for everything', async () => {
    const p = fakePlatform();
    const client = createClient({ ...base, appVersion: '1.2.0', ua: 'Test/1 (macOS)' }, p.platform);
    client.screen('/home');
    client.track('click', { button: 'save' });
    await settle();
    expect(p.fetch).not.toHaveBeenCalled();
    expect(client.queued).toBe(2);

    await p.advance(300_000);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.url).toBe('https://stats.example.com/api/events/batch');
    expect(p.sent[0]!.body.site).toBe('my-app');
    expect(p.sent[0]!.body.events).toEqual([
      { name: 'screen_view', url: '/home', ts: 1_795_694_400, app_version: '1.2.0', ua: 'Test/1 (macOS)' },
      { name: 'click', url: '/home', ts: 1_795_694_400, app_version: '1.2.0', ua: 'Test/1 (macOS)', props: { button: 'save' } },
    ]);
    expect(client.queued).toBe(0);
  });

  it('flushes as soon as maxBatch events are queued', async () => {
    const p = fakePlatform();
    const client = createClient({ ...base, maxBatch: 3 }, p.platform);
    client.track('a');
    client.track('b');
    await settle();
    expect(p.fetch).not.toHaveBeenCalled();
    client.track('c');
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.body.events).toHaveLength(3);
  });

  it('never puts more than 50 events in one request', async () => {
    const p = fakePlatform();
    const client = createClient({ ...base, maxBatch: 500, flushInterval: 60_000 }, p.platform);
    // maxBatch is capped at the server's 50, so these go out as 50 + 50 + 20.
    for (let i = 0; i < 120; i += 1) client.track(`e${i}`);
    await client.flush();
    expect(p.sent.map((s) => s.body.events.length)).toEqual([50, 50, 20]);
  });

  it('idle costs nothing: no timer, no request', async () => {
    const p = fakePlatform();
    createClient(base, p.platform);
    await p.advance(10 * 60_000);
    expect(p.fetch).not.toHaveBeenCalled();
    expect(p.pendingTimers()).toBe(0);
  });

  it('accepts a full batch URL as the endpoint', () => {
    expect(batchUrl('https://x.dev/api/events/batch')).toBe('https://x.dev/api/events/batch');
    expect(batchUrl(' https://x.dev// ')).toBe('https://x.dev/api/events/batch');
  });
});

describe('failures', () => {
  it('keeps events and retries with backoff after a network error', async () => {
    const p = fakePlatform(['throw', 503]);
    const errors: unknown[] = [];
    const client = createClient({ ...base, onError: (e) => errors.push(e) }, p.platform);
    client.track('a');
    await p.advance(300_000);
    expect(client.queued).toBe(1);
    expect(errors).toHaveLength(1);

    // The first retry waits 1–2 s (2 s base, jittered).
    await p.advance(2_000);
    expect(p.fetch).toHaveBeenCalledTimes(2);
    expect(client.queued).toBe(1); // 503: still queued

    await p.advance(4_000); // second backoff ≤ 4 s
    expect(p.sent).toHaveLength(2);
    expect(client.queued).toBe(0);
  });

  it('drops a batch the server refuses as malformed instead of retrying it forever', async () => {
    const p = fakePlatform([400]);
    const errors: unknown[] = [];
    const client = createClient({ ...base, onError: (e) => errors.push(e) }, p.platform);
    client.track('a');
    await client.flush();
    expect(client.queued).toBe(0);
    expect(errors).toHaveLength(1);
    await p.advance(60 * 60_000);
    expect(p.fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds the queue, dropping the oldest', async () => {
    const p = fakePlatform();
    const client = createClient({ ...base, maxBatch: 50, maxQueue: 60, fetch: async () => { throw new Error('offline'); } }, p.platform);
    for (let i = 0; i < 200; i += 1) client.track(`e${i}`);
    await settle();
    expect(client.queued).toBeLessThanOrEqual(60);
  });

  it('never throws into the host', async () => {
    const p = fakePlatform();
    const client = createClient({ ...base, onError: () => { throw new Error('bad hook'); } }, p.platform);
    expect(() => client.track(undefined as unknown as string)).not.toThrow();
    expect(() => client.screen(42 as unknown as string)).not.toThrow();
    expect(() => client.track('x', 'nope' as unknown as Record<string, string>)).not.toThrow();
    const broken = createClient({ endpoint: 'x' } as unknown as typeof base, p.platform);
    expect(() => broken.track('x')).not.toThrow();
    await expect(broken.flush()).resolves.toBeUndefined();
  });

  it('survives a platform without fetch', async () => {
    const p = fakePlatform();
    p.platform.fetch = undefined;
    const client = createClient(base, p.platform);
    client.track('x');
    await expect(client.flush()).resolves.toBeUndefined();
  });
});

describe('user ids', () => {
  function memoryStorage(initial?: string): KeyValueStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    if (initial) data.set('nsmetry.uid', initial);
    return {
      data,
      getItem: async (k) => data.get(k) ?? null,
      setItem: async (k, v) => {
        data.set(k, v);
      },
    };
  }

  it('sends no user id unless asked', async () => {
    const p = fakePlatform();
    const client = createClient(base, p.platform);
    client.track('a');
    await client.flush();
    expect(p.sent[0]!.body.events[0]).not.toHaveProperty('user_id');
  });

  it('generates and persists an anonymous id when persistUserId is on', async () => {
    const p = fakePlatform();
    const storage = memoryStorage();
    const client = createClient({ ...base, persistUserId: true, storage }, p.platform);
    client.track('a');
    await client.flush();
    expect(p.sent[0]!.body.events[0]!.user_id).toBe('anon-1');
    expect(storage.data.get('nsmetry.uid')).toBe('anon-1');
  });

  it('reuses a stored anonymous id', async () => {
    const p = fakePlatform();
    const client = createClient({ ...base, persistUserId: true, storage: memoryStorage('kept') }, p.platform);
    client.track('a');
    await client.flush();
    expect(p.sent[0]!.body.events[0]!.user_id).toBe('kept');
  });

  it('identify() overrides, and identify(null) falls back to the anonymous id', async () => {
    const p = fakePlatform();
    const client = createClient({ ...base, persistUserId: true, storage: memoryStorage('kept') }, p.platform);
    client.identify('u-42');
    client.track('a');
    client.identify(null);
    client.track('b');
    await client.flush();
    expect(p.sent[0]!.body.events.map((e) => e.user_id)).toEqual(['u-42', 'kept']);
  });
});

describe('page hide and shutdown', () => {
  it('uses the beacon when the page is hidden', async () => {
    const p = fakePlatform();
    p.withBeacon();
    const client = createClient(base, p.platform);
    client.screen('/a');
    p.hide();
    expect(p.beaconed).toHaveLength(1);
    expect(p.beaconed[0]!.body.events[0]!.url).toBe('/a');
    expect(client.queued).toBe(0);
    expect(p.fetch).not.toHaveBeenCalled();
  });

  it('falls back to fetch when the beacon refuses', async () => {
    const p = fakePlatform();
    p.withBeacon(false);
    const client = createClient(base, p.platform);
    client.track('a');
    p.hide();
    await settle();
    expect(p.sent).toHaveLength(1);
  });

  it('without a beacon (apps), hiding flushes with fetch', async () => {
    const p = fakePlatform();
    const client = createClient(base, p.platform);
    client.track('a');
    p.hide();
    await settle();
    expect(p.sent).toHaveLength(1);
  });

  it('shutdown flushes, then stops listening and tracking', async () => {
    const p = fakePlatform();
    const client = createClient(base, p.platform);
    client.track('a');
    await client.shutdown();
    expect(p.sent).toHaveLength(1);
    expect(p.hasHideListener()).toBe(false);
    client.track('b');
    expect(client.queued).toBe(0);
    expect(p.pendingTimers()).toBe(0);
  });
});

describe('disabling', () => {
  it('disabled: true makes every call a no-op', async () => {
    const p = fakePlatform();
    const client = createClient({ ...base, disabled: true }, p.platform);
    client.track('a');
    await client.flush();
    expect(p.fetch).not.toHaveBeenCalled();
  });

  it('setEnabled(false) drops the queue; setEnabled(true) resumes', async () => {
    const p = fakePlatform();
    const client = createClient(base, p.platform);
    client.track('a');
    client.setEnabled(false);
    expect(client.queued).toBe(0);
    client.track('b');
    client.setEnabled(true);
    client.track('c');
    await client.flush();
    expect(p.sent[0]!.body.events.map((e) => e.name)).toEqual(['c']);
  });
});

describe('props', () => {
  it('keeps what the server keeps', () => {
    const long = 'x'.repeat(150);
    const props: Record<string, unknown> = { s: long, n: 3, b: false, bad: { nested: 1 }, nan: Number.NaN, nil: null };
    for (let i = 0; i < 20; i += 1) props[`k${i}`] = i;
    const clean = sanitizeProps(props as Record<string, string>)!;
    expect(Object.keys(clean)).toHaveLength(10);
    expect(clean.s).toHaveLength(100);
    expect(clean.n).toBe(3);
    expect(clean.b).toBe(false);
    expect(clean).not.toHaveProperty('bad');
    expect(clean).not.toHaveProperty('nan');
  });

  it('skips keys the server would drop, so they do not take a valid key\'s slot', () => {
    const props: Record<string, string> = { 'has space': 'x', ['k'.repeat(41)]: 'x', 'é': 'x' };
    for (let i = 0; i < 10; i += 1) props[`ok.${i}`] = 'y';
    const clean = sanitizeProps(props)!;
    expect(Object.keys(clean)).toEqual(Array.from({ length: 10 }, (_, i) => `ok.${i}`));
  });

  it('trims names, versions and user ids to the server\'s limits instead of losing the batch', async () => {
    const p = fakePlatform();
    const client = createClient({ ...base, appVersion: '1'.repeat(40), userId: 'u'.repeat(300) }, p.platform);
    client.track('e'.repeat(100));
    await client.flush();
    const event = p.sent[0]!.body.events[0]!;
    expect(event.name).toHaveLength(64);
    expect(event.app_version).toHaveLength(32);
    expect(event.user_id).toHaveLength(256);
  });
});

describe('createNsMetry (Node)', () => {
  it('describes itself in the body so the server does not take Node for a bot', async () => {
    const bodies: string[] = [];
    const client = createNsMetry({
      ...base,
      flushOnHide: false,
      fetch: async (_url, init) => {
        bodies.push(String(init.body));
        return new Response(null, { status: 204 });
      },
    });
    client.track('cli_run');
    await client.shutdown();
    const event = (JSON.parse(bodies[0]!) as Sent['body']).events[0]!;
    expect(event.ua).toMatch(/^NsMetry-JS\/0\.1\.0 \((macOS|Windows NT|Linux)\)$/);
    expect(event.url).toBe('/');
  });
});

describe('the NSH copy', () => {
  it('sdk/nsh/src/core.ts is identical to sdk/js/src/core.ts (run `npm run sync:nsh`)', () => {
    const js = readFileSync(new URL('../src/core.ts', import.meta.url), 'utf8');
    const nsh = readFileSync(new URL('../../nsh/src/core.ts', import.meta.url), 'utf8');
    expect(nsh).toBe(js);
  });
});
