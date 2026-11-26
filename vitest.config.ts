import { spawnSync } from 'node:child_process';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// wrangler.jsonc serves the app from app/dist/web/nsmetry, and the pool refuses
// a config whose assets directory does not exist. A fresh checkout (CI) has no
// app build, so make the placeholder page there — offline, and a no-op when a
// real build is already in place.
spawnSync(process.execPath, ['scripts/web-package.mjs'], {
  env: { ...process.env, NSMETRY_WEB: 'skip' },
  stdio: 'ignore',
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // ADMIN_EMAIL is empty in wrangler.jsonc (each deployment names its own
      // administrator), so the suite names one. No SMTP secret or EMAIL
      // binding is set, so sign-in codes go to console.log, where the tests
      // read them.
      miniflare: { bindings: { ADMIN_EMAIL: 'owner@example.com' } },
    }),
  ],
  test: {
    // Only the Worker's suite runs in the Workers pool. The app's tests
    // (app/*.test.tsx) and the NSH SDK's (sdk/nsh/example) run under `nsh test`,
    // and sdk/js has its own Node config (`npm run test:sdk`).
    include: ['test/**/*.test.ts'],
  },
});
