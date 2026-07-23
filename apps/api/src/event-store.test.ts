import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import type { IngestEvent } from '@outtrace/contracts';

import { HttpError } from './errors.js';
import { persistEvent } from './event-store.js';

const event: IngestEvent = {
  eventId: 'evt_external_1',
  instanceKey: 'customer_1',
  metadata: {},
  occurredAt: '2026-07-23T10:30:00Z',
  processKey: 'client-onboarding',
  source: 'custom',
  stage: 'account_created',
  status: 'completed',
};

interface FakeClientOptions {
  duplicateInstanceId?: string;
  failEventInsert?: boolean;
}

function createFakePool(options: FakeClientOptions = {}): {
  calls: string[];
  pool: pg.Pool;
} {
  const calls: string[] = [];
  const client = {
    async query(sql: string): Promise<{ rowCount: number; rows: unknown[] }> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push(normalized);

      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (normalized.includes('pg_advisory_xact_lock')) {
        return { rowCount: 1, rows: [{}] };
      }
      if (normalized.includes('FROM processes')) {
        return { rowCount: 1, rows: [{ id: 'process_1' }] };
      }
      if (normalized.includes('SELECT process_instance_id')) {
        const rows = options.duplicateInstanceId
          ? [{ process_instance_id: options.duplicateInstanceId }]
          : [];
        return { rowCount: rows.length, rows };
      }
      if (normalized.startsWith('INSERT INTO process_instances')) {
        return { rowCount: 1, rows: [{ id: 'pi_1', inserted: true }] };
      }
      if (normalized.startsWith('INSERT INTO events')) {
        if (options.failEventInsert) {
          throw new Error('synthetic database failure containing SQL details');
        }
        return { rowCount: 1, rows: [{ id: 'event_1' }] };
      }
      if (normalized.startsWith('UPDATE process_instances')) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Unexpected SQL in test: ${normalized}`);
    },
    release(): void {
      calls.push('RELEASE');
    },
  };
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as pg.Pool;

  return { calls, pool };
}

describe('persistEvent', () => {
  it('returns the original instance for an idempotent duplicate without writing state', async () => {
    const { calls, pool } = createFakePool({ duplicateInstanceId: 'pi_original' });

    await expect(persistEvent(pool, 'ws_1', event)).resolves.toMatchObject({
      duplicate: true,
      processInstanceId: 'pi_original',
    });
    expect(calls.some((sql) => sql.startsWith('INSERT INTO events'))).toBe(false);
    expect(calls).toContain('COMMIT');
  });

  it('rolls back persistence failures and exposes no SQL or driver detail', async () => {
    const { calls, pool } = createFakePool({ failEventInsert: true });

    const error = await persistEvent(pool, 'ws_1', event).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      code: 'DATABASE_FAILURE',
      statusCode: 503,
    });
    expect((error as Error).message).not.toContain('SQL');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });
});
