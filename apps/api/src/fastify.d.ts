import type pg from 'pg';

import type { RedisConnection } from './redis.js';

declare module 'fastify' {
  interface FastifyInstance {
    openflow: {
      eventRateLimitMax: number;
      pool: pg.Pool;
      redis: RedisConnection;
    };
  }

  interface FastifyRequest {
    openflowWorkspaceId?: string;
  }
}
