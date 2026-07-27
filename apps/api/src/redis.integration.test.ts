import { afterEach, describe, expect, it } from 'vitest';

import { ProductionRedisConnection } from './redis.js';

const runRedisIntegration = process.env.RUN_REDIS_INTEGRATION === 'true';
let connection: ProductionRedisConnection | undefined;

afterEach(async () => {
  await connection?.close();
  connection = undefined;
});

describe.runIf(runRedisIntegration)('Outtrace Redis integration', () => {
  it('connects through the production adapter and responds to PING', async () => {
    const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('TEST_REDIS_URL or REDIS_URL is required when RUN_REDIS_INTEGRATION=true.');
    }

    connection = new ProductionRedisConnection(redisUrl);
    await expect(connection.ping()).resolves.toBe('PONG');
  });
});
