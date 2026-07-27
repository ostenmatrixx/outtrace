import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { authenticateIngestion, authenticateOperator } from './authentication.js';
import { sha256Hex } from './crypto.js';

function fakePool(
  row: { id: string; ingestion_key_hash: string } | undefined,
  failure?: Error,
): pg.Pool {
  return {
    async query(sql: string) {
      if (failure) {
        throw failure;
      }
      if (sql.includes('FROM process_ingestion_credentials')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    },
  } as unknown as pg.Pool;
}

describe('authenticateIngestion', () => {
  it('resolves the workspace for valid SHA-256 credentials', async () => {
    await expect(
      authenticateIngestion(
        fakePool({ id: 'ws_1', ingestion_key_hash: sha256Hex('valid-secret') }),
        { key: 'valid-secret', keyId: 'key_1' },
      ),
    ).resolves.toEqual({ processId: null, workspaceId: 'ws_1' });
  });

  it('resolves a process scope for a valid process credential', async () => {
    const pool = {
      async query(sql: string) {
        if (sql.includes('FROM process_ingestion_credentials')) {
          return {
            rowCount: 1,
            rows: [
              {
                key_hash: sha256Hex('process-secret'),
                process_id: 'process_1',
                workspace_id: 'ws_1',
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    } as unknown as pg.Pool;

    await expect(
      authenticateIngestion(pool, { key: 'process-secret', keyId: 'process_key_1' }),
    ).resolves.toEqual({ processId: 'process_1', workspaceId: 'ws_1' });
  });

  it.each([
    fakePool({ id: 'ws_1', ingestion_key_hash: sha256Hex('different-secret') }),
    fakePool(undefined),
  ])('returns the same safe authentication error for invalid credentials', async (pool) => {
    await expect(
      authenticateIngestion(pool, { key: 'invalid-secret', keyId: 'key_1' }),
    ).rejects.toMatchObject({
      code: 'AUTHENTICATION_INVALID',
      statusCode: 401,
    });
  });

  it('maps authentication lookup failures to a safe database error', async () => {
    const error = await authenticateIngestion(
      fakePool(undefined, new Error('postgres at sensitive-host failed')),
      { key: 'secret', keyId: 'key_1' },
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'DATABASE_FAILURE', statusCode: 503 });
    expect((error as Error).message).not.toContain('sensitive-host');
  });

  it('rejects workspace-wide ingestion credentials when the legacy path is disabled', async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        return { rowCount: 0, rows: [] };
      },
    } as unknown as pg.Pool;

    await expect(
      authenticateIngestion(pool, { key: 'legacy-secret', keyId: 'legacy-key' }, false),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_INVALID', statusCode: 401 });
    expect(queries.some((sql) => sql.includes('FROM workspaces'))).toBe(false);
  });
});

describe('authenticateOperator', () => {
  it('uses the separate hashed operator credential', async () => {
    const pool = {
      async query() {
        return {
          rowCount: 1,
          rows: [{ id: 'ws_1', operator_key_hash: sha256Hex('operator-secret') }],
        };
      },
    } as unknown as pg.Pool;

    await expect(
      authenticateOperator(pool, { key: 'operator-secret', keyId: 'operator_1' }),
    ).resolves.toBe('ws_1');
    await expect(
      authenticateOperator(pool, { key: 'ingestion-secret', keyId: 'operator_1' }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_INVALID' });
  });

  it('rejects the workspace-wide operator credential when the legacy path is disabled', async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        return { rowCount: 0, rows: [] };
      },
    } as unknown as pg.Pool;

    await expect(
      authenticateOperator(pool, { key: 'legacy-secret', keyId: 'legacy-key' }, false),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_INVALID', statusCode: 401 });
    expect(queries.some((sql) => sql.includes('FROM workspaces'))).toBe(false);
  });
});
