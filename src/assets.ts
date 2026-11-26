/**
 * The NSH web build, served beside the API.
 *
 * The app (app/, built by app/build-web.sh into app/dist/web/nsmetry) is a set
 * of static files that Cloudflare serves from the Worker's asset store
 * (wrangler.jsonc, "assets"). Most of them never reach this code: the asset
 * store answers them before the Worker runs, which costs nothing against the
 * free plan's 100,000 Worker requests a day.
 *
 * Two kinds of path do reach it, because they are listed in `run_worker_first`:
 *
 *  - `/*.js`, because the tracker answers `GET /<anything>.js` — the filename is
 *    each deployment's own choice, so it cannot be enumerated in the config.
 *    The app's JavaScript lives under the same pattern, so it is told apart
 *    here: everything `nsh package` writes is either content-hashed
 *    (`app.554678de12.js`) or inside a directory (`browser.de8aa0f5a1/dom.js`,
 *    `facades/nsh.2d96278bb9.js`), and a tracker path is always one segment.
 *  - `/*.wasm` and `/*.css`, so that the Brotli copy `nsh package` already
 *    made is what gets sent. The asset store only compresses on the fly at a
 *    low level, which turns the 7 MB runtime into ~2.6 MB instead of ~1.9 MB.
 *
 * The cost is one Worker request per such file when someone opens the app —
 * a handful per visit by the one administrator and their viewers, against a
 * budget sized for a whole fleet of apps (see src/budget.ts).
 */

/** What `nsh package` names its content-hashed files: `<name>.<10 hex>.<ext>`. */
const HASHED = /\.[0-9a-f]{10}\.(wasm|m?js|css)$/;

const TYPES: Record<string, string> = {
  wasm: 'application/wasm',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Prefixes that belong to the Worker even when they look like a file. */
const WORKER_PREFIXES = ['/api/', '/oauth/', '/.well-known/'];

/**
 * The asset for this request, or null when the Worker itself should answer
 * (the API, OAuth, MCP, the tracker script and its ingest endpoint).
 */
export async function serveAppAsset(request: Request, env: Env): Promise<Response | null> {
  // Optional on purpose: a deployment made from an older wrangler config, or a
  // test that binds no assets, still has a working API and tracker.
  const assets = (env as { ASSETS?: Fetcher }).ASSETS;
  if (!assets) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  const url = new URL(request.url);
  const path = url.pathname;
  if (WORKER_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;

  const nested = path.indexOf('/', 1) !== -1;
  if (HASHED.test(path)) {
    const found = await hashedAsset(request, assets, url);
    if (found) return found;
    // Not in the build: a single-segment name is the tracker's to answer, even
    // one that happens to look like a hash.
    return nested ? assets.fetch(request) : null;
  }
  if (nested && /\.(m?js|wasm|css)$/.test(path)) return assets.fetch(request);
  return null;
}

/**
 * A content-hashed file, sent as its precompressed copy when the browser takes
 * one. Null when the build has no such file.
 */
async function hashedAsset(request: Request, assets: Fetcher, url: URL): Promise<Response | null> {
  const ext = url.pathname.slice(url.pathname.lastIndexOf('.') + 1);
  const type = TYPES[ext] ?? 'application/octet-stream';

  if (request.method === 'GET') {
    for (const [suffix, encoding] of preferredEncodings(request.headers.get('accept-encoding') ?? '')) {
      const res = await assets.fetch(
        new Request(new URL(`${url.pathname}.${suffix}`, url), { headers: { 'accept-encoding': 'identity' } }),
      );
      // Defensive: were a single-page fallback ever turned on, a missing file
      // would come back as index.html rather than a 404.
      if (!res.ok || isHtml(res)) continue;
      const headers = new Headers({
        'content-type': type,
        'content-encoding': encoding,
        'cache-control': IMMUTABLE,
        vary: 'accept-encoding',
      });
      const etag = res.headers.get('etag');
      if (etag) headers.set('etag', etag);
      // `manual`: the body is already encoded; the runtime must not encode it again.
      return new Response(res.body, { status: 200, headers, encodeBody: 'manual' });
    }
  }

  const res = await assets.fetch(request);
  if (!res.ok || isHtml(res)) return null;
  const out = new Response(res.body, res);
  out.headers.set('cache-control', IMMUTABLE);
  out.headers.append('vary', 'accept-encoding');
  return out;
}

function isHtml(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html');
}

/** Brotli and gzip, best first by the browser's own q-values; none it refuses. */
function preferredEncodings(header: string): [string, string][] {
  const accepted = new Map<string, number>();
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    accepted.set(name.trim(), q === undefined ? 1 : Number(q.slice(2)));
  }
  const quality = (name: string) => accepted.get(name) ?? accepted.get('*') ?? 0;
  return (
    [
      ['br', 'br'],
      ['gz', 'gzip'],
    ] as [string, string][]
  )
    .filter(([, encoding]) => quality(encoding) > 0)
    .sort((a, b) => quality(b[1]) - quality(a[1]));
}
