import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { IncidentEvaluationJob } from '@outtrace/contracts';
import type { Queue } from 'bullmq';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { evaluateProcessInstance } from './incident-engine.js';
import {
  deliverSlackNotifications,
  dispatchEvaluationOutbox,
  enforceEventRetention,
  enforceIdempotencyRetention,
  enforceOutboxRetention,
  sweepIncidentDeadlines,
} from './phase2-runtime.js';

const { Pool } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for the worker integration suite.');
}
const schemaName = `outtrace_worker_${process.pid}_${randomBytes(5).toString('hex')}`;
const migrationDirectory = new URL('../../../database/migrations/', import.meta.url);

let adminPool: pg.Pool;
let pool: pg.Pool;

async function migrate(): Promise<void> {
  for (const filename of [
    '001_phase_1_telemetry.sql',
    '002_deterministic_instance_state.sql',
    '003_phase_2_incidents.sql',
    '004_phase_3_agency_support.sql',
    '005_phase_4_pilot.sql',
    '006_production_hardening.sql',
  ]) {
    await pool.query(await readFile(new URL(filename, migrationDirectory), 'utf8'));
  }
}

async function seedProcess(): Promise<void> {
  await pool.query(
    `
      INSERT INTO workspaces (id, name, ingestion_key_id, ingestion_key_hash)
      VALUES ('ws_engine', 'Engine workspace', 'engine-key', repeat('a', 64))
    `,
  );
  await pool.query(
    `INSERT INTO clients (id, workspace_id, name) VALUES ('client_engine', 'ws_engine', 'Acme')`,
  );
  await pool.query(
    `
      INSERT INTO processes (
        id,
        workspace_id,
        client_id,
        key,
        name,
        sla_seconds
      )
      VALUES (
        'process_engine',
        'ws_engine',
        'client_engine',
        'onboarding',
        'Client onboarding',
        600
      )
    `,
  );
  for (const stage of [
    ['payment_received', 'Payment received', 0, 60, 'make'],
    ['account_created', 'Account created', 1, 120, 'custom'],
    ['welcome_sent', 'Welcome sent', 2, 120, 'n8n'],
  ] as const) {
    await pool.query(
      `
        INSERT INTO process_stages (
          id,
          workspace_id,
          process_id,
          key,
          name,
          position,
          timeout_seconds,
          source
        )
        VALUES ($1, 'ws_engine', 'process_engine', $2, $3, $4, $5, $6)
      `,
      [`stage_${stage[0]}`, ...stage],
    );
  }
  await pool.query(
    `
      INSERT INTO process_instances (
        id,
        workspace_id,
        process_id,
        instance_key,
        status,
        started_at
      )
      VALUES (
        'instance_engine',
        'ws_engine',
        'process_engine',
        'customer_4821',
        'failed',
        '2026-07-24T10:00:00Z'
      )
    `,
  );
  await pool.query(
    `
      INSERT INTO events (
        id,
        workspace_id,
        process_instance_id,
        external_event_id,
        stage,
        status,
        source,
        metadata,
        occurred_at
      )
      VALUES
        (
          'event_account',
          'ws_engine',
          'instance_engine',
          'external_account',
          'account_created',
          'completed',
          'custom',
          '{}'::jsonb,
          '2026-07-24T10:01:00Z'
        ),
        (
          'event_welcome_failed',
          'ws_engine',
          'instance_engine',
          'external_welcome_failed',
          'welcome_sent',
          'failed',
          'n8n',
          '{"executionUrl":"https://n8n.example.com/execution/7"}'::jsonb,
          '2026-07-24T10:02:00Z'
        )
    `,
  );
}

describe('Phase 2 incident engine', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: testDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName}`,
    });
    await migrate();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE workspaces CASCADE');
    await seedProcess();
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await adminPool?.end();
  });

  it('detects every Phase 2 rule idempotently and auto-resolves cleared conditions', async () => {
    const first = await evaluateProcessInstance(
      pool,
      'ws_engine',
      'instance_engine',
      new Date('2026-07-24T10:11:00Z'),
    );
    expect(first).toEqual({
      evaluated: true,
      created: 6,
      reopened: 0,
      resolved: 0,
      active: 6,
    });
    expect((await pool.query(`SELECT status, completed_at FROM process_instances`)).rows).toEqual([
      { status: 'failed', completed_at: null },
    ]);
    expect(
      (
        await pool.query(
          `SELECT incident_type, affected_stage, status FROM incidents ORDER BY incident_type, affected_stage`,
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ incident_type: 'reported_failure', status: 'open' }),
        expect.objectContaining({ incident_type: 'missing_stage', status: 'open' }),
        expect.objectContaining({ incident_type: 'sla_violation', status: 'open' }),
        expect.objectContaining({ incident_type: 'unexpected_sequence', status: 'open' }),
      ]),
    );

    const repeated = await evaluateProcessInstance(
      pool,
      'ws_engine',
      'instance_engine',
      new Date('2026-07-24T10:11:00Z'),
    );
    expect(repeated).toMatchObject({ created: 0, reopened: 0, active: 6 });
    expect((await pool.query('SELECT count(*)::int AS count FROM incidents')).rows[0]).toEqual({
      count: 6,
    });

    await pool.query(
      `
        INSERT INTO events (
          id,
          workspace_id,
          process_instance_id,
          external_event_id,
          stage,
          status,
          source,
          occurred_at
        )
        VALUES
          (
            'event_payment',
            'ws_engine',
            'instance_engine',
            'external_payment',
            'payment_received',
            'completed',
            'make',
            '2026-07-24T10:12:00Z'
          ),
          (
            'event_welcome_completed',
            'ws_engine',
            'instance_engine',
            'external_welcome_completed',
            'welcome_sent',
            'completed',
            'n8n',
            '2026-07-24T10:13:00Z'
          )
      `,
    );
    await pool.query(
      `
        UPDATE process_instances
        SET status = 'completed', completed_at = '2026-07-24T10:13:00Z'
        WHERE id = 'instance_engine'
      `,
    );
    const cleared = await evaluateProcessInstance(
      pool,
      'ws_engine',
      'instance_engine',
      new Date('2026-07-24T10:14:00Z'),
    );
    expect(cleared).toMatchObject({ active: 0, resolved: 6 });
    expect(
      (
        await pool.query(
          `
            SELECT
              status,
              completed_at = '2026-07-24T10:13:00Z'::timestamptz AS completed_at_matches
            FROM process_instances
          `,
        )
      ).rows,
    ).toEqual([{ status: 'completed', completed_at_matches: true }]);
    expect((await pool.query(`SELECT DISTINCT status FROM incidents`)).rows).toEqual([
      { status: 'resolved' },
    ]);
  });

  it('publishes event outbox rows once and delivers inspectable Slack notifications', async () => {
    await pool.query(
      `
        INSERT INTO event_evaluation_outbox (
          id,
          workspace_id,
          process_instance_id,
          external_event_id
        )
        VALUES ('evaluation_engine', 'ws_engine', 'instance_engine', 'external_welcome_failed')
      `,
    );
    const add = vi.fn(async () => undefined);
    const queue = { add } as unknown as Queue<IncidentEvaluationJob>;

    await expect(dispatchEvaluationOutbox(pool, queue)).resolves.toBe(1);
    await expect(dispatchEvaluationOutbox(pool, queue)).resolves.toBe(0);
    expect(add).toHaveBeenCalledTimes(1);
    const addCalls = add.mock.calls as unknown[][];
    expect(addCalls[0]?.[1]).toMatchObject({
      workspaceId: 'ws_engine',
      processInstanceId: 'instance_engine',
      reason: 'event',
    });

    await evaluateProcessInstance(
      pool,
      'ws_engine',
      'instance_engine',
      new Date('2026-07-24T10:11:00Z'),
    );
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }));
    const deliveryConfig = {
      slackWebhookUrls: {
        ws_engine: 'https://hooks.slack.test/services/example',
      },
      slackMinimumSeverity: 'low' as const,
      dashboardBaseUrl: 'https://outtrace.example',
    };
    const delivered = await Promise.all([
      deliverSlackNotifications(pool, deliveryConfig, fetcher),
      deliverSlackNotifications(pool, deliveryConfig, fetcher),
    ]);
    expect(delivered.reduce((sum, count) => sum + count, 0)).toBe(6);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(fetcher.mock.calls)).toContain('customer_4821');
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM incident_notification_outbox WHERE sent_at IS NOT NULL`,
        )
      ).rows[0],
    ).toEqual({ count: 6 });
  });

  it('keeps notification claims inside the lease budget and counts only retained claims', async () => {
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
        SELECT
          'incident_claim_' || value,
          'ws_engine',
          'instance_engine',
          'reported_failure',
          'high',
          'claim_stage_' || value,
          'Claim test',
          'Claim test'
        FROM generate_series(1, 9) AS value;

        INSERT INTO incident_notification_outbox (
          id,
          workspace_id,
          incident_id,
          notification_version
        )
        SELECT
          'notification_claim_' || value,
          'ws_engine',
          'incident_claim_' || value,
          1
        FROM generate_series(1, 9) AS value;
      `,
    );
    const config = {
      slackWebhookUrls: {
        ws_engine: 'https://hooks.slack.test/services/claim-budget',
      },
      slackMinimumSeverity: 'low' as const,
      dashboardBaseUrl: 'https://outtrace.example',
    };
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }));

    await expect(deliverSlackNotifications(pool, config, fetcher)).resolves.toBe(8);
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM incident_notification_outbox WHERE sent_at IS NULL`,
        )
      ).rows[0],
    ).toEqual({ count: 1 });

    await pool.query(`TRUNCATE incident_notification_outbox, incidents CASCADE`);
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
          'incident_lost_claim',
          'ws_engine',
          'instance_engine',
          'reported_failure',
          'high',
          'lost_claim',
          'Lost claim test',
          'Lost claim test'
        );
        INSERT INTO incident_notification_outbox (
          id,
          workspace_id,
          incident_id,
          notification_version
        )
        VALUES (
          'notification_lost_claim',
          'ws_engine',
          'incident_lost_claim',
          1
        );
      `,
    );
    const reclaimingFetcher = vi.fn(async () => {
      await pool.query(
        `
          UPDATE incident_notification_outbox
          SET claimed_at = now(), claim_token = 'reclaimed_by_other_worker'
          WHERE id = 'notification_lost_claim'
        `,
      );
      return new Response('ok', { status: 200 });
    });

    await expect(deliverSlackNotifications(pool, config, reclaimingFetcher)).resolves.toBe(0);
    expect(
      (
        await pool.query(
          `
            SELECT sent_at, claim_token
            FROM incident_notification_outbox
            WHERE id = 'notification_lost_claim'
          `,
        )
      ).rows,
    ).toEqual([{ sent_at: null, claim_token: 'reclaimed_by_other_worker' }]);
  });

  it('routes each workspace only to its own webhook and escapes Slack control text', async () => {
    await pool.query(
      `
        INSERT INTO workspaces (id, name, ingestion_key_id, ingestion_key_hash)
        VALUES ('ws_other', 'Other workspace', 'other-key', repeat('b', 64));
        INSERT INTO clients (id, workspace_id, name)
        VALUES ('client_other', 'ws_other', 'Other client');
        INSERT INTO processes (id, workspace_id, client_id, key, name)
        VALUES ('process_other', 'ws_other', 'client_other', 'other-process', 'Other process');
        INSERT INTO process_instances (
          id,
          workspace_id,
          process_id,
          instance_key,
          status,
          started_at
        )
        VALUES (
          'instance_other',
          'ws_other',
          'process_other',
          'other-instance',
          'failed',
          now()
        );
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
        VALUES
          (
            'incident_engine_route',
            'ws_engine',
            'instance_engine',
            'reported_failure',
            'high',
            'welcome_sent',
            'Engine route test',
            'Workspace one <!channel>'
          ),
          (
            'incident_other_route',
            'ws_other',
            'instance_other',
            'reported_failure',
            'high',
            'other_stage',
            'Other route test',
            'Workspace two only'
          );
        INSERT INTO incident_notification_outbox (
          id,
          workspace_id,
          incident_id,
          notification_version
        )
        VALUES
          ('notification_engine_route', 'ws_engine', 'incident_engine_route', 1),
          ('notification_other_route', 'ws_other', 'incident_other_route', 1);
      `,
    );
    const deliveries: Array<{ body: string; url: string }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      deliveries.push({ body: String(init?.body), url: String(input) });
      return new Response('ok', { status: 200 });
    });

    await expect(
      deliverSlackNotifications(
        pool,
        {
          slackWebhookUrls: {
            ws_engine: 'https://hooks.slack.test/services/workspace-one',
            ws_other: 'https://hooks.slack.test/services/workspace-two',
          },
          slackMinimumSeverity: 'low',
          dashboardBaseUrl: 'https://outtrace.example',
        },
        fetcher,
      ),
    ).resolves.toBe(2);

    expect(deliveries).toHaveLength(2);
    const workspaceOneDelivery = deliveries.find((delivery) =>
      delivery.url.endsWith('/workspace-one'),
    )!;
    const workspaceTwoDelivery = deliveries.find((delivery) =>
      delivery.url.endsWith('/workspace-two'),
    )!;
    expect(workspaceOneDelivery.body).toContain('Workspace one &lt;!channel&gt;');
    expect(workspaceOneDelivery.body).not.toContain('Workspace two only');
    expect(workspaceTwoDelivery.body).toContain('Workspace two only');
    expect(workspaceTwoDelivery.body).not.toContain('Workspace one');
  });

  it('preserves an arrival-order violation after a backdated predecessor and corrected event', async () => {
    await pool.query(
      `
        INSERT INTO events (
          id,
          workspace_id,
          process_instance_id,
          external_event_id,
          stage,
          status,
          source,
          occurred_at
        )
        VALUES
          (
            'event_payment_late',
            'ws_engine',
            'instance_engine',
            'external_payment_late',
            'payment_received',
            'completed',
            'make',
            '2026-07-24T09:59:00Z'
          ),
          (
            'event_account_corrected',
            'ws_engine',
            'instance_engine',
            'external_account_corrected',
            'account_created',
            'completed',
            'custom',
            '2026-07-24T10:03:00Z'
          )
      `,
    );
    await evaluateProcessInstance(
      pool,
      'ws_engine',
      'instance_engine',
      new Date('2026-07-24T10:04:00Z'),
    );
    expect(
      (
        await pool.query(
          `
            SELECT affected_stage, status, resolution_reason
            FROM incidents
            WHERE incident_type = 'unexpected_sequence'
            ORDER BY affected_stage
          `,
        )
      ).rows,
    ).toEqual([
      {
        affected_stage: 'account_created',
        status: 'resolved',
        resolution_reason: 'condition_cleared',
      },
      {
        affected_stage: 'welcome_sent',
        status: 'resolved',
        resolution_reason: 'condition_cleared',
      },
    ]);
  });

  it('paginates through more than 500 deadline candidates', async () => {
    await pool.query(
      `UPDATE process_instances SET completed_at = now() WHERE id = 'instance_engine'`,
    );
    await pool.query(
      `
        INSERT INTO process_instances (
          id,
          workspace_id,
          process_id,
          instance_key,
          status,
          started_at
        )
        SELECT
          'deadline_' || lpad(value::text, 4, '0'),
          'ws_engine',
          'process_engine',
          'deadline-key-' || value::text,
          'started',
          '2026-07-24T10:00:00Z'::timestamptz
        FROM generate_series(1, 501) AS value
      `,
    );
    await expect(sweepIncidentDeadlines(pool, new Date('2026-07-24T10:00:00Z'))).resolves.toBe(501);
  });

  it('keeps an operator resolution stable until a distinct failure occurs', async () => {
    await evaluateProcessInstance(
      pool,
      'ws_engine',
      'instance_engine',
      new Date('2026-07-24T10:11:00Z'),
    );
    await pool.query(
      `
        UPDATE incidents
        SET
          status = 'resolved',
          resolution_reason = 'operator',
          resolved_at = now()
        WHERE incident_type = 'reported_failure' AND affected_stage = 'welcome_sent'
      `,
    );

    const repeated = await evaluateProcessInstance(
      pool,
      'ws_engine',
      'instance_engine',
      new Date('2026-07-24T10:13:00Z'),
    );
    expect(repeated.reopened).toBe(0);

    await pool.query(
      `
        INSERT INTO events (
          id,
          workspace_id,
          process_instance_id,
          external_event_id,
          stage,
          status,
          source,
          occurred_at
        )
        VALUES (
          'event_welcome_failed_again',
          'ws_engine',
          'instance_engine',
          'external_welcome_failed_again',
          'welcome_sent',
          'failed',
          'n8n',
          '2026-07-24T10:14:00Z'
        )
      `,
    );
    const recurrence = await evaluateProcessInstance(
      pool,
      'ws_engine',
      'instance_engine',
      new Date('2026-07-24T10:15:00Z'),
    );
    expect(recurrence.reopened).toBe(1);
    expect(
      (
        await pool.query(
          `
            SELECT status, notification_version
            FROM incidents
            WHERE incident_type = 'reported_failure' AND affected_stage = 'welcome_sent'
          `,
        )
      ).rows,
    ).toEqual([{ status: 'open', notification_version: 2 }]);
  });

  it('enforces each workspace retention policy and records the deletion', async () => {
    await pool.query(`UPDATE workspaces SET event_retention_days = 1 WHERE id = 'ws_engine'`);
    await pool.query(
      `UPDATE process_instances SET completed_at = '2026-07-21T11:00:00Z' WHERE id = 'instance_engine'`,
    );
    await pool.query(
      `
        UPDATE events
        SET received_at = CASE
          WHEN id = 'event_account' THEN '2026-07-20T10:00:00Z'::timestamptz
          ELSE '2026-07-21T10:00:00Z'::timestamptz
        END
      `,
    );

    await expect(enforceEventRetention(pool, new Date('2026-07-24T10:00:00Z'), 1, 1)).resolves.toBe(
      1,
    );
    expect((await pool.query(`SELECT id FROM events ORDER BY id`)).rows).toEqual([
      { id: 'event_welcome_failed' },
    ]);
    expect(
      (
        await pool.query(
          `SELECT retention_days, events_deleted FROM retention_runs WHERE workspace_id = 'ws_engine'`,
        )
      ).rows,
    ).toEqual([{ retention_days: 1, events_deleted: 1 }]);
    expect(
      (await pool.query(`SELECT action FROM workspace_audit_log WHERE workspace_id = 'ws_engine'`))
        .rows,
    ).toEqual([{ action: 'events_retained' }]);
  });

  it('prunes only completed outbox rows after the operational retention window', async () => {
    await pool.query(
      `
        INSERT INTO event_evaluation_outbox (
          id,
          workspace_id,
          process_instance_id,
          external_event_id,
          published_at,
          created_at
        )
        VALUES
          (
            'evaluation_old',
            'ws_engine',
            'instance_engine',
            'evaluation-old-event',
            '2026-01-01T00:00:00Z',
            '2026-01-01T00:00:00Z'
          ),
          (
            'evaluation_pending',
            'ws_engine',
            'instance_engine',
            'evaluation-pending-event',
            NULL,
            '2026-01-01T00:00:00Z'
          ),
          (
            'evaluation_old_two',
            'ws_engine',
            'instance_engine',
            'evaluation-old-event-two',
            '2026-01-01T00:00:00Z',
            '2026-01-01T00:00:00Z'
          );
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
          'incident_outbox_retention',
          'ws_engine',
          'instance_engine',
          'reported_failure',
          'high',
          'welcome_sent',
          'Retention test',
          'Retention test'
        );
        INSERT INTO incident_notification_outbox (
          id,
          workspace_id,
          incident_id,
          notification_version,
          sent_at,
          created_at
        )
        VALUES (
          'notification_old',
          'ws_engine',
          'incident_outbox_retention',
          1,
          '2026-01-01T00:00:00Z',
          '2026-01-01T00:00:00Z'
        );
      `,
    );

    await expect(
      enforceOutboxRetention(pool, new Date('2026-07-24T00:00:00Z'), 90, 1, 2),
    ).resolves.toBe(3);
    expect((await pool.query(`SELECT id FROM event_evaluation_outbox`)).rows).toEqual([
      { id: 'evaluation_pending' },
    ]);
    expect((await pool.query(`SELECT id FROM incident_notification_outbox`)).rows).toEqual([]);
  });

  it('bounds idempotency receipts without racing raw events or evaluation outbox rows', async () => {
    await pool.query(
      `
        INSERT INTO event_idempotency_keys (
          workspace_id,
          external_event_id,
          process_instance_id,
          created_at
        )
        VALUES
          (
            'ws_engine',
            'idempotency-expired',
            'instance_engine',
            '2025-01-01T00:00:00Z'
          ),
          (
            'ws_engine',
            'idempotency-outbox-protected',
            'instance_engine',
            '2025-01-01T00:00:00Z'
          ),
          (
            'ws_engine',
            'idempotency-expired-two',
            'instance_engine',
            '2025-01-01T00:00:00Z'
          ),
          (
            'ws_engine',
            'idempotency-recent',
            'instance_engine',
            '2026-07-01T00:00:00Z'
          );
        INSERT INTO event_evaluation_outbox (
          id,
          workspace_id,
          process_instance_id,
          external_event_id
        )
        VALUES (
          'evaluation_idempotency_protected',
          'ws_engine',
          'instance_engine',
          'idempotency-outbox-protected'
        )
      `,
    );

    await expect(
      enforceIdempotencyRetention(pool, new Date('2026-07-24T00:00:00Z'), 90, 1, 2),
    ).resolves.toBe(2);
    expect(
      (
        await pool.query(
          `SELECT external_event_id FROM event_idempotency_keys ORDER BY external_event_id`,
        )
      ).rows,
    ).toEqual([
      { external_event_id: 'idempotency-outbox-protected' },
      { external_event_id: 'idempotency-recent' },
    ]);
  });
});
