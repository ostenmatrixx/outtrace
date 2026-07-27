import type pg from 'pg';

import type { RedisConnection } from './redis.js';
import type { IngestionPrincipal, OperatorPrincipal } from './authentication.js';

declare module 'fastify' {
  interface FastifyInstance {
    outtrace: {
      allowLegacyWorkspaceCredentials: boolean;
      eventRateLimitMax: number;
      pool: pg.Pool;
      redis: RedisConnection;
    };
  }

  interface FastifyRequest {
    outtraceIngestion?: IngestionPrincipal;
    outtraceWorkspaceId?: string;
    outtraceOperator?: OperatorPrincipal;
  }
}
