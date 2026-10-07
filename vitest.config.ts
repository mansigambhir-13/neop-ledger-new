import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts', 'scripts/fleet/tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each test file gets its own database. Cap process-heavy integration files so
    // local and CI runs do not starve their runners and turn polling checks flaky.
    pool: 'forks',
    maxWorkers: 4,
  },
});
