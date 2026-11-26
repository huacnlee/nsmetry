#!/usr/bin/env node
/**
 * Make sure the app's web build is where wrangler.jsonc's "assets" points
 * (app/dist/web/nsmetry) before the Worker is deployed or run.
 *
 * wrangler.jsonc runs this as its custom build ("build.command"), so it runs
 * before every `wrangler deploy` and `wrangler dev`, however they are started:
 * `npm run deploy`, a clone on someone's laptop, or Cloudflare's own build for
 * the Deploy button and for Workers Builds — which has Node and npm but no
 * `nsh` CLI to build the app with.
 *
 * In order, the first that works wins:
 *
 *   1. A build is already there: nothing to do. (Delete the directory, or set
 *      NSMETRY_WEB=rebuild, to replace it.)
 *   2. `nsh` is installed: build this checkout with app/build-web.sh.
 *   3. Download the web package that release CI attached to this version's
 *      GitHub release (nsmetry-web.tar.gz for v<package.json version>), check
 *      it against the release's sha256sums, and unpack it. NSMETRY_WEB_URL
 *      overrides the URL, for a fork that publishes its own releases.
 *   4. Write a one-page placeholder that says how to get the app. The Worker
 *      still deploys, and the tracker, the HTTP API, MCP and the desktop and
 *      mobile apps all work without it; only the browser app is missing.
 *
 * Why download rather than commit the build: it is ~15 MB of generated files
 * per release, which would make every update pull request mostly noise. The
 * release that matches package.json's version is the same code CI tested and
 * tagged, and the download happens at build time on Cloudflare's builder —
 * never in anyone's browser.
 *
 * NSMETRY_WEB=skip writes the placeholder and touches no network (tests, CI).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'app', 'dist', 'web', 'nsmetry');
const index = join(out, 'index.html');
const REPO = 'https://github.com/hayaran/Edgemetry';
const PLACEHOLDER_MARK = '<!-- nsmetry:placeholder -->';
const mode = process.env.NSMETRY_WEB ?? '';

const log = (message) => console.log(`[web-package] ${message}`);

function isPlaceholder() {
  try {
    return readFileSync(index, 'utf8').includes(PLACEHOLDER_MARK);
  } catch {
    return false;
  }
}

function hasNsh() {
  const probe = spawnSync(process.env.NSH ?? 'nsh', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function buildWithNsh() {
  log('building the app with nsh (app/build-web.sh)…');
  const result = spawnSync('sh', [join(root, 'app', 'build-web.sh')], { cwd: root, stdio: 'inherit' });
  return result.status === 0 && existsSync(index) && !isPlaceholder();
}

async function download() {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const url = process.env.NSMETRY_WEB_URL ?? `${REPO}/releases/download/v${version}/nsmetry-web.tar.gz`;
  log(`downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());

  // The release's sha256sums, when there is one next to the package. A
  // custom URL may not have one; a release from this project always does.
  if (!process.env.NSMETRY_WEB_URL) {
    const sums = await fetch(url.replace(/[^/]+$/, 'sha256sums'), { redirect: 'follow' });
    if (sums.ok) {
      const line = (await sums.text()).split('\n').find((l) => l.trim().endsWith(' nsmetry-web.tar.gz'));
      const expected = line?.trim().split(/\s+/)[0];
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (expected && expected !== actual) throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);
      if (expected) log('checksum ok');
    }
  }

  const archive = join(tmpdir(), `nsmetry-web-${process.pid}.tar.gz`);
  writeFileSync(archive, bytes);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', archive, '-C', out], { stdio: 'inherit' });
  rmSync(archive, { force: true });
  if (untar.status !== 0 || !existsSync(index)) throw new Error('could not unpack the web package');
}

function placeholder(reason) {
  mkdirSync(out, { recursive: true });
  writeFileSync(
    index,
    `<!doctype html>
${PLACEHOLDER_MARK}
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NsMetry</title>
<style>:root{color-scheme:light dark}body{margin:0;font:15px/1.6 -apple-system,system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:520px;margin:15vh auto;padding:0 16px}h1{font-size:20px}code{font:13px ui-monospace,Menlo,monospace}p{color:GrayText}</style>
</head><body><main>
<h1>NsMetry is running</h1>
<p>The tracker, the HTTP API and MCP are up. The browser app was not included in this deploy (${reason}).</p>
<p>To add it, deploy a version that has a release (the Deploy button and the update workflow do), or build it yourself with
<a href="https://nsh.dev">nsh</a>: <code>app/build-web.sh &amp;&amp; npm run deploy</code>.
Meanwhile the desktop and mobile apps from the <a href="${REPO}/releases">releases page</a> work with this server.</p>
</main></body></html>
`,
  );
  log(`wrote a placeholder page (${reason})`);
}

async function main() {
  if (mode === 'skip') {
    if (!existsSync(index)) placeholder('NSMETRY_WEB=skip');
    return;
  }
  if (existsSync(index) && !isPlaceholder() && mode !== 'rebuild') {
    log('app/dist/web/nsmetry is already built');
    return;
  }
  if (hasNsh()) {
    if (buildWithNsh()) return;
    log('the nsh build failed; trying the release package instead');
  }
  try {
    await download();
    log('unpacked the release web package');
  } catch (error) {
    // Already a placeholder from an earlier run: keep it, it says the same.
    if (!existsSync(index)) placeholder(`no web package: ${error.message}`);
    else log(`kept the existing page (${error.message})`);
  }
}

await main();
