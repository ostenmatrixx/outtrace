import { describe, expect, it } from 'vitest';

import { createPool } from './database.js';

describe('createPool', () => {
  it('configures connection, query, and PostgreSQL statement timeouts', async () => {
    const pool = createPool({ databaseUrl: 'postgres://localhost/openflow' });

    expect(pool.options).toMatchObject({
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
    });
    await pool.end();
  });
});
