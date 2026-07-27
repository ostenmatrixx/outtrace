import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { bootstrapWorkspace } from './bootstrap-workspace.js';
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
  operatorKey: 'operator-secret-one',
  operatorKeyId: 'operator-key-one',
};
const workspaceTwo = {
  id: 'ws_integration_two',
  key: 'integration-secret-two',
  keyId: 'integration-key-two',
  operatorKey: 'operator-secret-two',
  operatorKeyId: 'operator-key-two',
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
      INSERT INTO workspaces (
        id,
        name,
        ingestion_key_id,
        ingestion_key_hash,
        operator_key_id,
        operator_key_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      workspace.id,
      `Workspace ${suffix}`,
      workspace.keyId,
      sha256Hex(workspace.key),
      workspace.operatorKeyId,
      sha256Hex(workspace.operatorKey),
    ],
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

function operatorHeaders(workspace = workspaceOne): Record<string, string> {
  return {
    'x-outtrace-operator-key': workspace.operatorKey,
    'x-outtrace-operator-key-id': workspace.operatorKeyId,
    'x-outtrace-operator-name': 'Integration Operator',
  };
}

async function createPilotProcess(key = 'production-pilot') {
  return app.inject({
    headers: operatorHeaders(),
    method: 'POST',
    payload: {
      clientId: 'client_one',
      environment: 'production',
      key,
      metadataAllowlist: ['executionUrl'],
      name: 'Production pilot',
      slaSeconds: 900,
      stages: [
        {
          key: 'received',
          name: 'Received',
          owningTeam: 'Operations',
          required: true,
          source: 'make',
          timeoutSeconds: 120,
        },
        {
          key: 'completed',
          name: 'Completed',
          owningTeam: 'Automation',
          required: true,
          source: 'n8n',
          timeoutSeconds: 300,
        },
      ],
    },
    url: '/v1/processes',
  });
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
      operatorKey: 'plaintext-operator-secret',
      operatorKeyId: 'seed-operator-key-id',
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

  it('bootstraps a production workspace with one active owner and no legacy ingestion key', async () => {
    const bootstrap = await bootstrapWorkspace(pool, {
      workspaceId: 'ws_production_bootstrap',
      workspaceName: 'Production agency',
      ownerName: 'Initial Owner',
      ownerEmail: 'OWNER@EXAMPLE.COM',
    });

    expect(
      (
        await pool.query(
          `
            SELECT
              workspaces.ingestion_key_id,
              workspaces.ingestion_key_hash,
              workspace_members.email,
              workspace_members.role,
              workspace_members.status
            FROM workspaces
            JOIN workspace_members
              ON workspace_members.workspace_id = workspaces.id
            WHERE workspaces.id = $1
          `,
          [bootstrap.workspaceId],
        )
      ).rows,
    ).toEqual([
      {
        ingestion_key_id: null,
        ingestion_key_hash: null,
        email: 'owner@example.com',
        role: 'owner',
        status: 'active',
      },
    ]);

    const session = await app.inject({
      headers: {
        'x-outtrace-operator-key-id': bootstrap.accessKeyId,
        'x-outtrace-operator-key': bootstrap.accessKey,
      },
      method: 'GET',
      url: '/v1/session',
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      workspaceId: bootstrap.workspaceId,
      memberId: bootstrap.memberId,
      role: 'owner',
    });
    await expect(
      bootstrapWorkspace(pool, {
        workspaceId: 'ws_production_bootstrap',
        workspaceName: 'Duplicate',
        ownerName: 'Other Owner',
        ownerEmail: 'other@example.com',
      }),
    ).rejects.toThrow('already exists');
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

  it('keeps retries idempotent after raw event retention', async () => {
    const first = await postEvent(eventPayload({ eventId: 'retained-idempotency-event' }));
    expect(first.statusCode).toBe(202);
    await pool.query(`DELETE FROM events WHERE workspace_id = $1 AND external_event_id = $2`, [
      workspaceOne.id,
      'retained-idempotency-event',
    ]);

    const retry = await postEvent(
      eventPayload({
        eventId: 'retained-idempotency-event',
        instanceKey: 'attempted-recreated-instance',
      }),
    );
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      duplicate: true,
      processInstanceId: first.json().processInstanceId,
    });
    expect(
      (
        await pool.query(`SELECT count(*)::int AS count FROM events WHERE workspace_id = $1`, [
          workspaceOne.id,
        ])
      ).rows[0],
    ).toEqual({ count: 0 });
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM event_idempotency_keys WHERE workspace_id = $1`,
          [workspaceOne.id],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });

  it('writes one durable evaluation outbox job for each new event only', async () => {
    await postEvent(eventPayload({ eventId: 'outbox-event' }));
    await postEvent(eventPayload({ eventId: 'outbox-event' }));

    expect(
      (
        await pool.query(
          `
            SELECT external_event_id, published_at
            FROM event_evaluation_outbox
            WHERE workspace_id = $1
          `,
          [workspaceOne.id],
        )
      ).rows,
    ).toEqual([{ external_event_id: 'outbox-event', published_at: null }]);
  });

  it('serves a tenant-scoped incident workflow with timeline, assignment, notes, and audit', async () => {
    const event = await postEvent(
      eventPayload({
        eventId: 'incident-source-event',
        metadata: { executionUrl: 'https://n8n.example.com/execution/42' },
        status: 'failed',
      }),
    );
    const instanceId = event.json().processInstanceId as string;
    await pool.query(
      `
        INSERT INTO incidents (
          id,
          workspace_id,
          process_instance_id,
          incident_type,
          severity,
          affected_stage,
          technical_message,
          business_message,
          source,
          execution_url
        )
        VALUES (
          'incident_integration',
          $1,
          $2,
          'reported_failure',
          'high',
          'workspace_created',
          'n8n reported a failed event.',
          'Workspace creation failed.',
          'n8n',
          'https://n8n.example.com/execution/42'
        )
      `,
      [workspaceOne.id, instanceId],
    );

    const unauthorized = await app.inject({ method: 'GET', url: '/v1/incidents' });
    expect(unauthorized.statusCode).toBe(401);

    const otherTenant = await app.inject({
      headers: operatorHeaders(workspaceTwo),
      method: 'GET',
      url: '/v1/incidents',
    });
    expect(otherTenant.json()).toEqual({ incidents: [], total: 0 });

    const inbox = await app.inject({
      headers: operatorHeaders(),
      method: 'GET',
      url: '/v1/incidents?status=open&severity=high',
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json()).toMatchObject({
      total: 1,
      incidents: [
        {
          id: 'incident_integration',
          client: { name: 'Client one' },
          process: { name: 'Process one' },
          instance: { id: instanceId },
        },
      ],
    });

    const updated = await app.inject({
      headers: operatorHeaders(),
      method: 'PATCH',
      payload: { assignedTo: 'Mina', status: 'acknowledged' },
      url: '/v1/incidents/incident_integration',
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      assignedTo: 'Mina',
      status: 'acknowledged',
      timeline: [
        {
          eventId: 'incident-source-event',
          executionUrl: 'https://n8n.example.com/execution/42',
        },
      ],
    });

    const noted = await app.inject({
      headers: operatorHeaders(),
      method: 'POST',
      payload: { author: 'Spoofed author', body: 'Retrying the source workflow.' },
      url: '/v1/incidents/incident_integration/notes',
    });
    expect(noted.statusCode).toBe(201);
    expect(noted.json()).toMatchObject({
      notes: [{ author: 'Workspace owner', body: 'Retrying the source workflow.' }],
    });
    expect(
      (
        await pool.query(
          'SELECT action FROM incident_audit_log WHERE incident_id = $1 ORDER BY created_at, id',
          ['incident_integration'],
        )
      ).rows.map((row) => row.action),
    ).toEqual(expect.arrayContaining(['acknowledged', 'assigned', 'note_added']));
  });

  it('enforces Phase 3 roles, client access, metadata allowlists, reports, and retention settings', async () => {
    const session = await app.inject({
      headers: operatorHeaders(),
      method: 'GET',
      url: '/v1/session',
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      workspaceId: workspaceOne.id,
      role: 'owner',
      clientIds: null,
    });

    const createdClient = await app.inject({
      headers: operatorHeaders(),
      method: 'POST',
      payload: { name: 'Restricted client' },
      url: '/v1/clients',
    });
    expect(createdClient.statusCode).toBe(201);
    const restrictedClientId = createdClient.json().id as string;

    const invited = await app.inject({
      headers: operatorHeaders(),
      method: 'POST',
      payload: {
        name: 'Viewer One',
        email: 'viewer@example.com',
        role: 'viewer',
        clientIds: [restrictedClientId],
      },
      url: '/v1/members',
    });
    expect(invited.statusCode).toBe(201);
    expect(invited.json()).toMatchObject({
      member: {
        role: 'viewer',
        clientIds: [restrictedClientId],
      },
    });
    const viewerHeaders = {
      'x-outtrace-operator-key-id': invited.json().accessKeyId as string,
      'x-outtrace-operator-key': invited.json().accessKey as string,
    };

    const viewerClients = await app.inject({
      headers: viewerHeaders,
      method: 'GET',
      url: '/v1/clients',
    });
    expect(viewerClients.statusCode).toBe(200);
    expect(viewerClients.json().clients).toEqual([
      expect.objectContaining({ id: restrictedClientId, name: 'Restricted client' }),
    ]);
    expect(
      (
        await app.inject({
          headers: viewerHeaders,
          method: 'POST',
          payload: { name: 'Forbidden client' },
          url: '/v1/clients',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          headers: viewerHeaders,
          method: 'GET',
          url: '/v1/clients/client_one/report',
        })
      ).statusCode,
    ).toBe(403);

    const processUpdate = await app.inject({
      headers: operatorHeaders(),
      method: 'PATCH',
      payload: { metadataAllowlist: ['orderId', 'executionUrl'] },
      url: '/v1/processes/process_one',
    });
    expect(processUpdate.statusCode).toBe(200);
    expect(processUpdate.json()).toMatchObject({
      metadataAllowlist: ['orderId', 'executionUrl'],
    });

    await postEvent(
      eventPayload({
        eventId: 'phase-3-allowlist-event',
        metadata: {
          clientId: 'discarded-by-process-policy',
          orderId: 'order_42',
          executionUrl: 'https://n8n.example.com/execution/phase-3',
        },
      }),
    );
    expect(
      (
        await pool.query<{ metadata: Record<string, string> }>(
          `SELECT metadata FROM events WHERE external_event_id = 'phase-3-allowlist-event'`,
        )
      ).rows[0]?.metadata,
    ).toEqual({
      orderId: 'order_42',
      executionUrl: 'https://n8n.example.com/execution/phase-3',
    });

    const report = await app.inject({
      headers: operatorHeaders(),
      method: 'GET',
      url: '/v1/clients/client_one/report',
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({
      client: { id: 'client_one' },
      totalInstances: 1,
      completedInstances: 1,
      completionRate: 1,
    });

    const settings = await app.inject({
      headers: operatorHeaders(),
      method: 'PATCH',
      payload: { eventRetentionDays: 45 },
      url: '/v1/workspace/settings',
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toEqual({ eventRetentionDays: 45 });

    expect(
      (
        await pool.query<{ action: string }>(
          `SELECT action FROM workspace_audit_log WHERE workspace_id = $1`,
          [workspaceOne.id],
        )
      ).rows.map((row) => row.action),
    ).toEqual(
      expect.arrayContaining([
        'client_created',
        'member_invited',
        'process_updated',
        'retention_updated',
      ]),
    );
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

  it('creates a production process with ordered stages and hash-only scoped credentials', async () => {
    const created = await createPilotProcess();
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      process: {
        clientId: 'client_one',
        connectionStatus: 'awaiting_first_event',
        environment: 'production',
        eventCount: 0,
        key: 'production-pilot',
        lifecycleStatus: 'active',
        stageCount: 2,
      },
      stages: [
        { key: 'received', owningTeam: 'Operations', position: 0 },
        { key: 'completed', owningTeam: 'Automation', position: 1 },
      ],
      credential: {
        key: expect.stringMatching(/^outtrace_process_/),
        keyId: expect.stringMatching(/^process_key_/),
      },
    });

    const processId = created.json().process.id as string;
    const key = created.json().credential.key as string;
    const keyId = created.json().credential.keyId as string;
    const stored = await pool.query<{ key_hash: string }>(
      `
        SELECT key_hash
        FROM process_ingestion_credentials
        WHERE workspace_id = $1 AND process_id = $2 AND key_id = $3
      `,
      [workspaceOne.id, processId, keyId],
    );
    expect(stored.rows).toEqual([{ key_hash: sha256Hex(key) }]);
    expect(JSON.stringify(stored.rows)).not.toContain(key);

    const accepted = await postEvent(
      eventPayload({
        eventId: 'process-scoped-event',
        processKey: 'production-pilot',
        stage: 'received',
      }),
      { key, keyId },
    );
    expect(accepted.statusCode).toBe(202);

    const wrongProcess = await postEvent(
      eventPayload({
        eventId: 'process-scope-escape',
        processKey: 'client-onboarding',
      }),
      { key, keyId },
    );
    expect(wrongProcess.statusCode).toBe(404);
    expect(wrongProcess.json()).toMatchObject({ error: { code: 'UNKNOWN_PROCESS' } });

    const processState = await pool.query<{
      connected_at: Date | null;
      last_event_received_at: Date | null;
    }>(
      `
        SELECT connected_at, last_event_received_at
        FROM processes
        WHERE workspace_id = $1 AND id = $2
      `,
      [workspaceOne.id, processId],
    );
    expect(processState.rows[0]?.connected_at).toBeInstanceOf(Date);
    expect(processState.rows[0]?.last_event_received_at).toEqual(
      processState.rows[0]?.connected_at,
    );

    const anotherCredential = await app.inject({
      headers: operatorHeaders(),
      method: 'POST',
      url: `/v1/processes/${processId}/credentials`,
    });
    expect(anotherCredential.statusCode).toBe(201);
    expect(anotherCredential.json()).toMatchObject({
      processId,
      key: expect.stringMatching(/^outtrace_process_/),
      keyId: expect.stringMatching(/^process_key_/),
    });
    expect(anotherCredential.json().key).not.toBe(key);

    const archived = await app.inject({
      headers: operatorHeaders(),
      method: 'PATCH',
      payload: { lifecycleStatus: 'archived' },
      url: `/v1/processes/${processId}`,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      id: processId,
      lifecycleStatus: 'archived',
    });

    const archivedIngestion = await postEvent(
      eventPayload({
        eventId: 'archived-process-event',
        processKey: 'production-pilot',
        stage: 'completed',
      }),
      { key, keyId },
    );
    expect(archivedIngestion.statusCode).toBe(404);
    expect(archivedIngestion.json()).toMatchObject({ error: { code: 'UNKNOWN_PROCESS' } });

    const processList = await app.inject({
      headers: operatorHeaders(),
      method: 'GET',
      url: '/v1/processes',
    });
    expect(processList.json().processes).toContainEqual(
      expect.objectContaining({ id: processId, lifecycleStatus: 'archived' }),
    );
  });

  it('lists, rotates, and immediately revokes process-scoped credentials', async () => {
    const created = await createPilotProcess('credential-lifecycle');
    const processId = created.json().process.id as string;
    const originalKey = created.json().credential.key as string;
    const originalKeyId = created.json().credential.keyId as string;

    const initialList = await app.inject({
      headers: operatorHeaders(),
      method: 'GET',
      url: `/v1/processes/${processId}/credentials`,
    });
    expect(initialList.statusCode).toBe(200);
    expect(initialList.json().credentials).toEqual([
      expect.objectContaining({ keyId: originalKeyId, revokedAt: null }),
    ]);

    const rotated = await app.inject({
      headers: operatorHeaders(),
      method: 'POST',
      payload: { revokeExisting: true },
      url: `/v1/processes/${processId}/credentials`,
    });
    expect(rotated.statusCode).toBe(201);
    const replacementKey = rotated.json().key as string;
    const replacementKeyId = rotated.json().keyId as string;

    expect(
      (
        await postEvent(
          eventPayload({
            eventId: 'revoked-original',
            processKey: 'credential-lifecycle',
            stage: 'received',
          }),
          { key: originalKey, keyId: originalKeyId },
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await postEvent(
          eventPayload({
            eventId: 'replacement-accepted',
            processKey: 'credential-lifecycle',
            stage: 'received',
          }),
          { key: replacementKey, keyId: replacementKeyId },
        )
      ).statusCode,
    ).toBe(202);

    const credentialList = await app.inject({
      headers: operatorHeaders(),
      method: 'GET',
      url: `/v1/processes/${processId}/credentials`,
    });
    const replacement = (credentialList.json().credentials as Array<Record<string, unknown>>).find(
      (credential) => credential.keyId === replacementKeyId,
    )!;
    expect(
      (credentialList.json().credentials as Array<Record<string, unknown>>).find(
        (credential) => credential.keyId === originalKeyId,
      ),
    ).toMatchObject({
      revokedAt: expect.any(String),
      revocationReason: 'Rotated by replacement credential',
    });

    const revoked = await app.inject({
      headers: operatorHeaders(),
      method: 'POST',
      payload: { reason: 'Canary completed' },
      url: `/v1/processes/${processId}/credentials/${String(replacement.id)}/revoke`,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      keyId: replacementKeyId,
      revokedAt: expect.any(String),
      revocationReason: 'Canary completed',
    });
    expect(
      (
        await postEvent(
          eventPayload({
            eventId: 'revoked-replacement',
            processKey: 'credential-lifecycle',
            stage: 'completed',
          }),
          { key: replacementKey, keyId: replacementKeyId },
        )
      ).statusCode,
    ).toBe(401);

    const defaultReasonCredential = await app.inject({
      headers: operatorHeaders(),
      method: 'POST',
      payload: { revokeExisting: false },
      url: `/v1/processes/${processId}/credentials`,
    });
    const defaultReasonList = await app.inject({
      headers: operatorHeaders(),
      method: 'GET',
      url: `/v1/processes/${processId}/credentials`,
    });
    const defaultReasonRecord = (
      defaultReasonList.json().credentials as Array<Record<string, unknown>>
    ).find((credential) => credential.keyId === defaultReasonCredential.json().keyId)!;
    const defaultReasonRevocation = await app.inject({
      headers: operatorHeaders(),
      method: 'POST',
      url: `/v1/processes/${processId}/credentials/${String(defaultReasonRecord.id)}/revoke`,
    });
    expect(defaultReasonRevocation.statusCode).toBe(200);
    expect(defaultReasonRevocation.json()).toMatchObject({
      revocationReason: 'Revoked by workspace owner',
    });
  });

  it('serializes owner changes and never counts invited owners as active', async () => {
    const insertOwner = async (id: string, status: 'active' | 'invited'): Promise<void> => {
      await pool.query(
        `
          INSERT INTO workspace_members (
            id,
            workspace_id,
            name,
            email,
            role,
            status,
            access_key_id,
            access_key_hash
          )
          VALUES ($1, $2, $1, $1 || '@example.com', 'owner', $3, $1 || '_key', $4)
        `,
        [id, workspaceOne.id, status, sha256Hex(`${id}_secret`)],
      );
    };

    await insertOwner('owner_active', 'active');
    await insertOwner('owner_invited', 'invited');
    expect(
      (
        await app.inject({
          headers: operatorHeaders(),
          method: 'PATCH',
          payload: { status: 'disabled' },
          url: '/v1/members/owner_invited',
        })
      ).statusCode,
    ).toBe(200);
    const invitedDoesNotCount = await app.inject({
      headers: operatorHeaders(),
      method: 'PATCH',
      payload: { status: 'disabled' },
      url: '/v1/members/owner_active',
    });
    expect(invitedDoesNotCount.statusCode).toBe(409);

    await pool.query(`UPDATE workspace_members SET status = 'active' WHERE id = 'owner_invited'`);
    const concurrent = await Promise.all([
      app.inject({
        headers: operatorHeaders(),
        method: 'PATCH',
        payload: { status: 'disabled' },
        url: '/v1/members/owner_active',
      }),
      app.inject({
        headers: operatorHeaders(),
        method: 'PATCH',
        payload: { status: 'disabled' },
        url: '/v1/members/owner_invited',
      }),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(
      (
        await pool.query(
          `
            SELECT count(*)::int AS count
            FROM workspace_members
            WHERE workspace_id = $1 AND role = 'owner' AND status = 'active'
          `,
          [workspaceOne.id],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });

  it('rotates member credentials atomically and uses disablement as revocation', async () => {
    await pool.query(
      `
        INSERT INTO workspace_members (
          id,
          workspace_id,
          name,
          email,
          role,
          status,
          access_key_id,
          access_key_hash
        )
        VALUES (
          'member_rotate',
          $1,
          'Rotating operator',
          'rotate@example.com',
          'operator',
          'active',
          'member_rotate_old_key',
          $2
        )
      `,
      [workspaceOne.id, sha256Hex('member-rotate-old-secret')],
    );
    const rotated = await app.inject({
      headers: operatorHeaders(),
      method: 'POST',
      url: '/v1/members/member_rotate/credentials/rotate',
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toMatchObject({
      memberId: 'member_rotate',
      accessKeyId: expect.stringMatching(/^member_key_/),
      accessKey: expect.stringMatching(/^outtrace_member_/),
    });

    const oldSession = await app.inject({
      headers: {
        'x-outtrace-operator-key-id': 'member_rotate_old_key',
        'x-outtrace-operator-key': 'member-rotate-old-secret',
      },
      method: 'GET',
      url: '/v1/session',
    });
    expect(oldSession.statusCode).toBe(401);
    const newHeaders = {
      'x-outtrace-operator-key-id': rotated.json().accessKeyId as string,
      'x-outtrace-operator-key': rotated.json().accessKey as string,
    };
    expect(
      (
        await app.inject({
          headers: newHeaders,
          method: 'GET',
          url: '/v1/session',
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await app.inject({
          headers: operatorHeaders(),
          method: 'PATCH',
          payload: { status: 'disabled' },
          url: '/v1/members/member_rotate',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          headers: newHeaders,
          method: 'GET',
          url: '/v1/session',
        })
      ).statusCode,
    ).toBe(401);

    const disabledRotation = await app.inject({
      headers: operatorHeaders(),
      method: 'POST',
      url: '/v1/members/member_rotate/credentials/rotate',
    });
    expect(disabledRotation.statusCode).toBe(200);
    const disabledRotationHeaders = {
      'x-outtrace-operator-key-id': disabledRotation.json().accessKeyId as string,
      'x-outtrace-operator-key': disabledRotation.json().accessKey as string,
    };
    expect(
      (
        await app.inject({
          headers: disabledRotationHeaders,
          method: 'GET',
          url: '/v1/session',
        })
      ).statusCode,
    ).toBe(401);

    expect(
      (
        await app.inject({
          headers: operatorHeaders(),
          method: 'PATCH',
          payload: { status: 'active' },
          url: '/v1/members/member_rotate',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          headers: newHeaders,
          method: 'GET',
          url: '/v1/session',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          headers: disabledRotationHeaders,
          method: 'GET',
          url: '/v1/session',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('records tenant-scoped incident feedback and returns it with incident detail', async () => {
    const event = await postEvent(eventPayload({ eventId: 'feedback-event', status: 'failed' }));
    await pool.query(
      `
        INSERT INTO incidents (
          id,
          workspace_id,
          process_instance_id,
          incident_type,
          severity,
          affected_stage,
          technical_message,
          business_message
        )
        VALUES (
          'incident_feedback_test',
          $1,
          $2,
          'reported_failure',
          'high',
          'workspace_created',
          'A failure was reported.',
          'Workspace creation failed.'
        )
      `,
      [workspaceOne.id, event.json().processInstanceId],
    );

    const invalid = await app.inject({
      headers: operatorHeaders(),
      method: 'PUT',
      payload: { verdict: 'false_positive' },
      url: '/v1/incidents/incident_feedback_test/feedback',
    });
    expect(invalid.statusCode).toBe(400);

    const recorded = await app.inject({
      headers: operatorHeaders(),
      method: 'PUT',
      payload: {
        note: 'The timeout is intentionally short in this workflow.',
        reason: 'timeout_too_short',
        verdict: 'false_positive',
      },
      url: '/v1/incidents/incident_feedback_test/feedback',
    });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json()).toMatchObject({
      incidentId: 'incident_feedback_test',
      reason: 'timeout_too_short',
      reviewedBy: 'Workspace owner',
      verdict: 'false_positive',
    });
    expect(
      (
        await pool.query<{ action: string }>(
          `SELECT action FROM incident_audit_log WHERE incident_id = $1`,
          ['incident_feedback_test'],
        )
      ).rows,
    ).toContainEqual({ action: 'feedback_recorded' });

    const otherTenant = await app.inject({
      headers: operatorHeaders(workspaceTwo),
      method: 'PUT',
      payload: { verdict: 'genuine' },
      url: '/v1/incidents/incident_feedback_test/feedback',
    });
    expect(otherTenant.statusCode).toBe(404);
  });

  it('returns a production-only activation and 28-day incident quality summary', async () => {
    const created = await createPilotProcess('summary-process');
    const key = created.json().credential.key as string;
    const keyId = created.json().credential.keyId as string;
    const processId = created.json().process.id as string;
    const archived = await createPilotProcess('summary-archived');
    await app.inject({
      headers: operatorHeaders(),
      method: 'PATCH',
      payload: { lifecycleStatus: 'archived' },
      url: `/v1/processes/${archived.json().process.id as string}`,
    });
    await postEvent(
      eventPayload({
        eventId: 'summary-event',
        processKey: 'summary-process',
        stage: 'received',
      }),
      { key, keyId },
    );
    const sandboxEvent = await postEvent(
      eventPayload({
        eventId: 'summary-sandbox-event',
        instanceKey: 'summary-sandbox-instance',
      }),
    );
    const instance = await pool.query<{ id: string }>(
      `SELECT id FROM process_instances WHERE workspace_id = $1 AND process_id = $2`,
      [workspaceOne.id, processId],
    );
    await pool.query(
      `
        INSERT INTO incidents (
          id,
          workspace_id,
          process_instance_id,
          incident_type,
          severity,
          affected_stage,
          technical_message,
          business_message,
          created_at
        )
        VALUES
          (
            'incident_summary_recent',
            $1,
            $2,
            'missing_stage',
            'medium',
            'completed',
            'Completion is overdue.',
            'The pilot process is delayed.',
            now() - interval '1 day'
          ),
          (
            'incident_summary_old',
            $1,
            $2,
            'sla_violation',
            'critical',
            NULL,
            'The SLA was exceeded.',
            'The pilot process exceeded its SLA.',
            now() - interval '29 days'
          ),
          (
            'incident_summary_sandbox',
            $1,
            $3,
            'reported_failure',
            'high',
            'workspace_created',
            'A sandbox event reported failure.',
            'The sandbox process reported failure.',
            now() - interval '1 day'
          )
      `,
      [workspaceOne.id, instance.rows[0]!.id, sandboxEvent.json().processInstanceId],
    );
    await pool.query(
      `
        INSERT INTO incident_feedback (
          id,
          workspace_id,
          incident_id,
          verdict,
          reason,
          reviewed_by_name
        )
        VALUES (
          'feedback_summary_recent',
          $1,
          'incident_summary_recent',
          'false_positive',
          'timeout_too_short',
          'Workspace owner'
        )
      `,
      [workspaceOne.id],
    );

    const summary = await app.inject({
      headers: operatorHeaders(),
      method: 'GET',
      url: '/v1/pilot/summary',
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      windowDays: 28,
      activation: {
        totalProcesses: 1,
        connectedProcesses: 1,
        awaitingFirstEvent: 0,
        connectionRate: 1,
      },
      quality: {
        incidentsDetected: 1,
        reviewedIncidents: 1,
        genuineIncidents: 0,
        falsePositiveIncidents: 1,
        unreviewedIncidents: 0,
        falsePositiveRate: 1,
      },
      processes: [
        {
          id: processId,
          connectionStatus: 'connected',
          eventCount: 1,
          key: 'summary-process',
        },
      ],
    });
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
