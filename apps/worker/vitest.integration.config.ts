import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
});
