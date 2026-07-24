import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { IncidentEvaluationJob } from '@outtrace/contracts';
import type { Queue } from 'bullmq';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { evaluateProcessInstance } from './incident-engine.js';
import { deliverSlackNotifications, dispatchEvaluationOutbox } from './phase2-runtime.js';

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
    await expect(
      deliverSlackNotifications(
        pool,
        {
          slackWebhookUrl: 'https://hooks.slack.test/services/example',
          slackMinimumSeverity: 'low',
          dashboardBaseUrl: 'https://outtrace.example',
        },
        fetcher,
      ),
    ).resolves.toBe(6);
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
          resolved_at = '2026-07-24T10:12:00Z'
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
});
