import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['src/**/*.integration.test.ts'],
    testTimeout: 10_000,
  },
});
