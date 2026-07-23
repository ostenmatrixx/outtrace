import pg from 'pg';

import type { ApiConfig } from './config.js';

const { Pool } = pg;

export function createPool(config: Pick<ApiConfig, 'databaseUrl'>): pg.Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
}
