import { defineConfig } from 'vitest/config';

// Phase 6 bars at full size: `pnpm test:load` (minutes, not seconds).
export default defineConfig({
  test: {
    include: ['apps/*/load/**/*.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
