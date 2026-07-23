import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { authenticateIngestion } from './authentication.js';
import { sha256Hex } from './crypto.js';

function fakePool(
  row: { id: string; ingestion_key_hash: string } | undefined,
  failure?: Error,
): pg.Pool {
  return {
    async query() {
      if (failure) {
        throw failure;
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
    ).resolves.toBe('ws_1');
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
});
