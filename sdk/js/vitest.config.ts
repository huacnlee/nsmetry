import { defineConfig } from 'vitest/config';

// The SDK's own config, so its tests run in plain Node rather than inside the
// repository root's Cloudflare Workers pool (vitest.config.ts at the root).
// Run from the repo root: npx vitest run --config sdk/js/vitest.config.ts
// The suffix is `.unit.ts`, not `.test.ts`, so the root config's default
// include never picks these files up.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['test/**/*.unit.ts'],
    environment: 'node',
  },
});
