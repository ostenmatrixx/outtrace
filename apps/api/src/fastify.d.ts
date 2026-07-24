import type pg from 'pg';

import type { RedisConnection } from './redis.js';
import type { OperatorPrincipal } from './authentication.js';

declare module 'fastify' {
  interface FastifyInstance {
    outtrace: {
      eventRateLimitMax: number;
      pool: pg.Pool;
      redis: RedisConnection;
    };
  }

  interface FastifyRequest {
    outtraceWorkspaceId?: string;
    outtraceOperator?: OperatorPrincipal;
  }
}
