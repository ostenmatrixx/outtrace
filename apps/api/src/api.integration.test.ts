import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { sha256Hex } from './crypto.js';
import { runMigrations } from './migrations.js';

const { Pool } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for the PostgreSQL integration suite.');
}
const schemaName = `outtrace_api_${process.pid}_${randomBytes(5).toString('hex')}`;

const workspaceOne = {
  id: 'ws_integration_one',
  key: 'integration-secret-one',
  keyId: 'integration-key-one',
};
const workspaceTwo = {
  id: 'ws_integration_two',
  key: 'integration-secret-two',
  keyId: 'integration-key-two',
};

let adminPool: pg.Pool;
let pool: pg.Pool;
let app: FastifyInstance;

function eventPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'external-event-1',
    instanceKey: 'customer-4821',
    metadata: {
      clientId: 'client_visible',
    },
    occurredAt: '2026-07-23T10:30:00Z',
    processKey: 'client-onboarding',
    source: 'n8n',
    stage: 'workspace_created',
    status: 'completed',
    ...overrides,
  };
}

async function postEvent(
  payload: Record<string, unknown>,
  credentials: { key?: string; keyId?: string } = {
    key: workspaceOne.key,
    keyId: workspaceOne.keyId,
  },
) {
  const headers: Record<string, string> = {};
  if (credentials.key !== undefined) {
    headers['x-outtrace-key'] = credentials.key;
  }
  if (credentials.keyId !== undefined) {
    headers['x-outtrace-key-id'] = credentials.keyId;
  }

  return app.inject({
    headers,
    method: 'POST',
    payload,
    url: '/v1/events',
  });
}

async function seedWorkspace(
  workspace: typeof workspaceOne,
  suffix: string,
  processKey = 'client-onboarding',
): Promise<void> {
  await pool.query(
    `
      INSERT INTO workspaces (id, name, ingestion_key_id, ingestion_key_hash)
      VALUES ($1, $2, $3, $4)
    `,
    [workspace.id, `Workspace ${suffix}`, workspace.keyId, sha256Hex(workspace.key)],
  );
  await pool.query('INSERT INTO clients (id, workspace_id, name) VALUES ($1, $2, $3)', [
    `client_${suffix}`,
    workspace.id,
    `Client ${suffix}`,
  ]);
  await pool.query(
    `
      INSERT INTO processes (id, workspace_id, client_id, key, name)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [`process_${suffix}`, workspace.id, `client_${suffix}`, processKey, `Process ${suffix}`],
  );
}

describe('Outtrace API PostgreSQL integration', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: testDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName}`,
    });
    await runMigrations(pool);
    await runMigrations(pool);
    app = await createApp({
      dependencies: {
        pool,
        redis: {
          async close() {},
          async ping() {
            return 'PONG';
          },
        },
      },
    });
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE events, process_instances, process_stages, processes, clients, workspaces CASCADE',
    );
    await seedWorkspace(workspaceOne, 'one');
    await seedWorkspace(workspaceTwo, 'two', 'workspace-two-only');
  });

  afterAll(async () => {
    await app?.close();
    await adminPool?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await adminPool?.end();
  });

  it.each(['n8n', 'make', 'custom'])('persists an authenticated %s event', async (source) => {
    const response = await postEvent(
      eventPayload({
        eventId: `external-${source}`,
        instanceKey: `instance-${source}`,
        source,
      }),
    );

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      eventId: `external-${source}`,
    });
    const persisted = await pool.query(
      'SELECT source FROM events WHERE workspace_id = $1 AND external_event_id = $2',
      [workspaceOne.id, `external-${source}`],
    );
    expect(persisted.rows).toEqual([{ source }]);
  });

  it('applies the opt-in development seed idempotently and stores only a SHA-256 hash', async () => {
    const seed = {
      clientId: 'client_seeded',
      ingestionKey: 'plaintext-seed-secret',
      ingestionKeyId: 'seed-key-id',
      processId: 'process_seeded',
      processKey: 'seed-process',
      workspaceId: 'workspace_seeded',
    };

    await runMigrations(pool, { seed });
    await runMigrations(pool, { seed });

    const stored = await pool.query<{
      ingestion_key_hash: string;
      plaintext_was_stored: boolean;
    }>(
      `
          SELECT
            ingestion_key_hash,
            ingestion_key_hash = $2 AS plaintext_was_stored
          FROM workspaces
          WHERE id = $1
        `,
      [seed.workspaceId, seed.ingestionKey],
    );
    expect(stored.rows[0]).toEqual({
      ingestion_key_hash: sha256Hex(seed.ingestionKey),
      plaintext_was_stored: false,
    });
  });

  it('strips unknown top-level data and rejects invalid payloads safely', async () => {
    const accepted = await postEvent(
      eventPayload({
        eventId: 'unknown-field-event',
        fullCustomerPayload: { creditCard: 'must-not-persist' },
      }),
    );
    expect(accepted.statusCode).toBe(202);
    expect(JSON.stringify(await pool.query('SELECT metadata FROM events'))).not.toContain(
      'creditCard',
    );

    const rejected = await postEvent(
      eventPayload({ eventId: 'bad-timestamp', occurredAt: 'not-a-timestamp' }),
    );
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      error: { code: 'INVALID_PAYLOAD' },
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM events')).rows[0]).toEqual({
      count: 1,
    });
  });

  it('returns a structured error for an unsupported status', async () => {
    const response = await postEvent(eventPayload({ eventId: 'bad-status', status: 'waiting' }));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'UNSUPPORTED_STATUS',
        message: 'The event status is not supported.',
      },
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM events')).rows[0]).toEqual({
      count: 0,
    });
  });

  it('distinguishes missing and invalid authentication', async () => {
    const missing = await postEvent(eventPayload(), {});
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });

    const invalid = await postEvent(eventPayload(), {
      key: 'wrong-key',
      keyId: workspaceOne.keyId,
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({
      error: { code: 'AUTHENTICATION_INVALID' },
    });
  });

  it('cannot resolve a process that only exists in another workspace', async () => {
    const response = await postEvent(eventPayload({ processKey: 'workspace-two-only' }));

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'UNKNOWN_PROCESS' },
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM events')).rows[0]).toEqual({
      count: 0,
    });
  });

  it('returns a stable process instance and stores one row for duplicate event IDs', async () => {
    const first = await postEvent(eventPayload());
    const second = await postEvent(
      eventPayload({
        instanceKey: 'attempted-different-instance',
        metadata: { clientId: 'attempted-overwrite' },
      }),
    );

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      duplicate: true,
      processInstanceId: first.json().processInstanceId,
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM events')).rows[0]).toEqual({
      count: 1,
    });
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM process_instances')).rows[0],
    ).toEqual({ count: 1 });
  });

  it('rolls back a newly correlated instance when event insertion fails', async () => {
    const functionName = 'fail_test_event_insert';
    const triggerName = 'fail_test_event_insert_trigger';
    await pool.query(`
        CREATE FUNCTION "${schemaName}".${functionName}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'synthetic event insert failure';
        END;
        $$
      `);
    await pool.query(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON events
        FOR EACH ROW
        EXECUTE FUNCTION "${schemaName}".${functionName}()
      `);

    try {
      const response = await postEvent(eventPayload({ eventId: 'rollback-event' }));

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'DATABASE_FAILURE' },
      });
      expect((await pool.query('SELECT count(*)::int AS count FROM events')).rows[0]).toEqual({
        count: 0,
      });
      expect(
        (await pool.query('SELECT count(*)::int AS count FROM process_instances')).rows[0],
      ).toEqual({ count: 0 });
    } finally {
      await pool.query(`DROP TRIGGER ${triggerName} ON events`);
      await pool.query(`DROP FUNCTION "${schemaName}".${functionName}()`);
    }
  });

  it('handles concurrent identical retries with one event and one nonduplicate response', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        postEvent(eventPayload({ eventId: 'concurrent-identical-event' })),
      ),
    );

    expect(responses.filter((response) => response.statusCode === 202)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(7);
    expect(responses.filter((response) => response.json().duplicate === false)).toHaveLength(1);
    expect(new Set(responses.map((response) => response.json().processInstanceId)).size).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM events')).rows[0]).toEqual({
      count: 1,
    });
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM process_instances')).rows[0],
    ).toEqual({ count: 1 });
  });

  it('handles concurrent distinct events with deterministic latest instance state', async () => {
    const events = Array.from({ length: 8 }, (_, index) => ({
      eventId: `concurrent-distinct-${index}`,
      occurredAt: `2026-07-23T10:${String(index).padStart(2, '0')}:00Z`,
      stage: `stage-${index}`,
      status: index === 7 ? 'failed' : 'started',
    }));
    const responses = await Promise.all(
      events.map((event) =>
        postEvent(
          eventPayload({
            ...event,
            instanceKey: 'concurrent-shared-instance',
          }),
        ),
      ),
    );

    expect(responses.every((response) => response.statusCode === 202)).toBe(true);
    expect(new Set(responses.map((response) => response.json().processInstanceId)).size).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM events')).rows[0]).toEqual({
      count: events.length,
    });
    const instance = await pool.query(
      `
          SELECT
            current_stage,
            latest_event_external_id,
            status
          FROM process_instances
        `,
    );
    expect(instance.rows).toEqual([
      {
        current_stage: 'stage-7',
        latest_event_external_id: 'concurrent-distinct-7',
        status: 'failed',
      },
    ]);
  });

  it('correlates separate events with the same process and instance keys', async () => {
    const first = await postEvent(
      eventPayload({
        eventId: 'correlation-1',
        occurredAt: '2026-07-23T10:00:00Z',
        status: 'started',
      }),
    );
    const second = await postEvent(
      eventPayload({
        eventId: 'correlation-2',
        occurredAt: '2026-07-23T10:05:00Z',
        stage: 'account_created',
      }),
    );

    expect(first.json().processInstanceId).toBe(second.json().processInstanceId);
    expect((await pool.query('SELECT count(*)::int AS count FROM events')).rows[0]).toEqual({
      count: 2,
    });
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM process_instances')).rows[0],
    ).toEqual({ count: 1 });
  });

  it('allowlists metadata and recursively redacts sensitive nested values', async () => {
    await postEvent(
      eventPayload({
        eventId: 'metadata-event',
        metadata: {
          clientId: 'client_acme',
          customerEmail: 'removed@example.com',
          executionUrl: {
            nested: [
              {
                api_key_backup: 'remove-me',
                AuthorizationHeader: 'remove-me-too',
                safe: 'preserved',
              },
            ],
            sessionCookie: 'remove-me-three',
          },
        },
      }),
    );

    const result = await pool.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM events WHERE external_event_id = $1',
      ['metadata-event'],
    );
    expect(result.rows[0]?.metadata).toEqual({
      clientId: 'client_acme',
    });
  });

  it('persists late events, moves started_at earlier, and does not rewind current state', async () => {
    await postEvent(
      eventPayload({
        eventId: 'newer-event',
        occurredAt: '2026-07-23T11:00:00Z',
        stage: 'welcome_sent',
        status: 'completed',
      }),
    );
    await postEvent(
      eventPayload({
        eventId: 'older-event',
        occurredAt: '2026-07-23T10:00:00Z',
        stage: 'payment_received',
        status: 'started',
      }),
    );

    const instance = await pool.query(
      `
          SELECT
            current_stage,
            status,
            started_at = '2026-07-23T10:00:00Z'::timestamptz AS earliest_started,
            latest_event_occurred_at = '2026-07-23T11:00:00Z'::timestamptz AS latest_unchanged
          FROM process_instances
        `,
    );
    expect(instance.rows[0]).toEqual({
      current_stage: 'welcome_sent',
      earliest_started: true,
      latest_unchanged: true,
      status: 'completed',
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM events')).rows[0]).toEqual({
      count: 2,
    });
  });

  it('uses external event ID as a deterministic tie-breaker for equal timestamps', async () => {
    const occurredAt = '2026-07-23T12:00:00Z';
    const responses = await Promise.all([
      postEvent(
        eventPayload({
          eventId: 'equal-a',
          occurredAt,
          stage: 'alphabetically-first',
          status: 'started',
        }),
      ),
      postEvent(
        eventPayload({
          eventId: 'equal-z',
          occurredAt,
          stage: 'alphabetically-last',
          status: 'failed',
        }),
      ),
    ]);

    expect(responses.every((response) => response.statusCode === 202)).toBe(true);
    const instance = await pool.query(
      `
          SELECT current_stage, latest_event_external_id, status
          FROM process_instances
        `,
    );
    expect(instance.rows).toEqual([
      {
        current_stage: 'alphabetically-last',
        latest_event_external_id: 'equal-z',
        status: 'failed',
      },
    ]);
  });

  it('reports PostgreSQL and Redis health without secrets', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      dependencies: {
        postgres: { status: 'up' },
        redis: { status: 'up' },
      },
      service: 'outtrace-api',
      status: 'ok',
    });
  });
});
