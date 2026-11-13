import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://relay@localhost:5432/relay_test?host=/tmp', RATE_LIMIT: 'off', SIMULATION: 'off', LOG_LEVEL: 'error' },
  },
});
