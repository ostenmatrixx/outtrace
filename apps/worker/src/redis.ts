import { Redis } from 'ioredis';

import type { WorkerConfig } from './config.js';

export type RedisConnection = Redis;

export function createRedisConnection(config: WorkerConfig): RedisConnection {
  return new Redis(config.redisUrl, {
    connectTimeout: config.redisConnectTimeoutMs,
    enableReadyCheck: true,
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });
}
