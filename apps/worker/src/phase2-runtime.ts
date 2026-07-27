import { randomUUID } from 'node:crypto';

import {
  INCIDENT_EVALUATION_QUEUE,
  type IncidentEvaluationJob,
  type IncidentSeverity,
} from '@outtrace/contracts';
import { Queue } from 'bullmq';
import pg from 'pg';

import type { WorkerConfig } from './config.js';
import { evaluateProcessInstance } from './incident-engine.js';
import type { Logger } from './logger.js';
import { safeError, safeErrorMessage } from './logger.js';
import type { RedisConnection } from './redis.js';

const { Pool } = pg;

interface EvaluationOutboxRow extends pg.QueryResultRow {
  id: string;
  workspace_id: string;
  process_instance_id: string;
  external_event_id: string;
}

interface InstanceRow extends pg.QueryResultRow {
  workspace_id: string;
  id: string;
}

interface NotificationRow extends pg.QueryResultRow {
  id: string;
  incident_id: string;
  severity: IncidentSeverity;
  status: 'open' | 'acknowledged' | 'resolved';
  business_message: string;
  source: string | null;
  client_name: string;
  process_name: string;
  instance_key: string;
  workspace_id: string;
}

interface WorkspaceRetentionRow extends pg.QueryResultRow {
  id: string;
  event_retention_days: number;
}

export interface Phase2Runtime {
  readonly pool: pg.Pool;
  close(): Promise<void>;
  getStatus(): 'starting' | 'ready' | 'degraded';
  start(): void;
  tick(): Promise<void>;
}

const severityRank: Record<IncidentSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};
const NOTIFICATION_CLAIM_BATCH_SIZE = 8;
const NOTIFICATION_CLAIM_LEASE_SECONDS = 120;
const SLACK_REQUEST_TIMEOUT_MS = 10_000;

const escapeSlackText = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export async function dispatchEvaluationOutbox(
  pool: pg.Pool,
  queue: Queue<IncidentEvaluationJob>,
): Promise<number> {
  const result = await pool.query<EvaluationOutboxRow>(
    `
      SELECT id, workspace_id, process_instance_id, external_event_id
      FROM event_evaluation_outbox
      WHERE published_at IS NULL AND available_at <= now()
      ORDER BY created_at
      LIMIT 100
    `,
  );
  let published = 0;

  for (const row of result.rows) {
    try {
      await queue.add(
        INCIDENT_EVALUATION_QUEUE,
        {
          workspaceId: row.workspace_id,
          processInstanceId: row.process_instance_id,
          eventId: row.external_event_id,
          reason: 'event',
        },
        {
          attempts: 5,
          backoff: { delay: 1_000, type: 'exponential' },
          jobId: row.id,
          removeOnComplete: 1_000,
          removeOnFail: false,
        },
      );
      await pool.query(
        `
          UPDATE event_evaluation_outbox
          SET published_at = now(), attempts = attempts + 1, last_error = NULL
          WHERE id = $1 AND published_at IS NULL
        `,
        [row.id],
      );
      published += 1;
    } catch (error) {
      await pool.query(
        `
          UPDATE event_evaluation_outbox
          SET
            attempts = attempts + 1,
            last_error = $2,
            available_at = now() + LEAST(300, power(2, LEAST(attempts, 8))) * interval '1 second'
          WHERE id = $1 AND published_at IS NULL
        `,
        [
          row.id,
          error instanceof Error
            ? safeErrorMessage(error.message).slice(0, 500)
            : 'Queue publish failed',
        ],
      );
    }
  }
  return published;
}

export async function sweepIncidentDeadlines(pool: pg.Pool, now = new Date()): Promise<number> {
  let evaluated = 0;
  let cursorWorkspaceId: string | null = null;
  let cursorInstanceId: string | null = null;

  for (;;) {
    const result: pg.QueryResult<InstanceRow> = await pool.query<InstanceRow>(
      `
        SELECT DISTINCT process_instances.workspace_id, process_instances.id
        FROM process_instances
        JOIN processes
          ON processes.workspace_id = process_instances.workspace_id
          AND processes.id = process_instances.process_id
        LEFT JOIN incidents
          ON incidents.workspace_id = process_instances.workspace_id
          AND incidents.process_instance_id = process_instances.id
          AND incidents.status <> 'resolved'
        WHERE
          (
            process_instances.completed_at IS NULL
            OR incidents.id IS NOT NULL
          )
          AND (
            $1::text IS NULL
            OR (process_instances.workspace_id, process_instances.id) > ($1::text, $2::text)
          )
        ORDER BY process_instances.workspace_id, process_instances.id
        LIMIT 500
      `,
      [cursorWorkspaceId, cursorInstanceId],
    );
    for (const instance of result.rows) {
      await evaluateProcessInstance(pool, instance.workspace_id, instance.id, now);
    }
    evaluated += result.rowCount ?? 0;
    const last: InstanceRow | undefined = result.rows.at(-1);
    if (!last || result.rows.length < 500) break;
    cursorWorkspaceId = last.workspace_id;
    cursorInstanceId = last.id;
  }
  return evaluated;
}

export async function deliverSlackNotifications(
  pool: pg.Pool,
  config: Pick<WorkerConfig, 'slackWebhookUrls' | 'slackMinimumSeverity' | 'dashboardBaseUrl'>,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const workspaceIds = Object.keys(config.slackWebhookUrls);
  if (workspaceIds.length === 0) return 0;
  const claimToken = `notification_claim_${randomUUID()}`;
  const claimClient = await pool.connect();
  let result: pg.QueryResult<NotificationRow>;
  try {
    await claimClient.query('BEGIN');
    result = await claimClient.query<NotificationRow>(
      `
        SELECT
          incident_notification_outbox.id,
          incident_notification_outbox.workspace_id,
          incidents.id AS incident_id,
          incidents.severity,
          incidents.status,
          incidents.business_message,
          incidents.source,
          clients.name AS client_name,
          processes.name AS process_name,
          process_instances.instance_key
        FROM incident_notification_outbox
        JOIN incidents
          ON incidents.workspace_id = incident_notification_outbox.workspace_id
          AND incidents.id = incident_notification_outbox.incident_id
        JOIN process_instances
          ON process_instances.workspace_id = incidents.workspace_id
          AND process_instances.id = incidents.process_instance_id
        JOIN processes
          ON processes.workspace_id = process_instances.workspace_id
          AND processes.id = process_instances.process_id
        JOIN clients
          ON clients.workspace_id = processes.workspace_id
          AND clients.id = processes.client_id
        WHERE
          incident_notification_outbox.sent_at IS NULL
          AND incident_notification_outbox.available_at <= now()
          AND incident_notification_outbox.workspace_id = ANY($1::text[])
          AND (
            incident_notification_outbox.claimed_at IS NULL
            OR incident_notification_outbox.claimed_at
              < now() - ($2::int * interval '1 second')
          )
        ORDER BY incident_notification_outbox.created_at
        FOR UPDATE OF incident_notification_outbox SKIP LOCKED
        LIMIT $3
      `,
      [workspaceIds, NOTIFICATION_CLAIM_LEASE_SECONDS, NOTIFICATION_CLAIM_BATCH_SIZE],
    );
    if (result.rows.length > 0) {
      await claimClient.query(
        `
          UPDATE incident_notification_outbox
          SET claimed_at = now(), claim_token = $2
          WHERE id = ANY($1::text[]) AND sent_at IS NULL
        `,
        [result.rows.map((row) => row.id), claimToken],
      );
    }
    await claimClient.query('COMMIT');
  } catch (error) {
    await claimClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    claimClient.release();
  }
  let sent = 0;

  for (const notification of result.rows) {
    if (notification.status === 'resolved') {
      await pool.query(
        `
          UPDATE incident_notification_outbox
          SET
            sent_at = now(),
            last_error = 'incident resolved before delivery',
            claimed_at = NULL,
            claim_token = NULL
          WHERE id = $1 AND sent_at IS NULL AND claim_token = $2
        `,
        [notification.id, claimToken],
      );
      continue;
    }

    if (severityRank[notification.severity] < severityRank[config.slackMinimumSeverity]) {
      await pool.query(
        `
          UPDATE incident_notification_outbox
          SET
            sent_at = now(),
            last_error = 'below configured severity threshold',
            claimed_at = NULL,
            claim_token = NULL
          WHERE id = $1 AND sent_at IS NULL AND claim_token = $2
        `,
        [notification.id, claimToken],
      );
      continue;
    }

    const text = [
      `*${escapeSlackText(notification.process_name)} incident*`,
      escapeSlackText(notification.business_message),
      `Client: ${escapeSlackText(notification.client_name)} · Instance: \`${escapeSlackText(notification.instance_key)}\` · Severity: ${notification.severity.toUpperCase()}`,
      notification.source ? `Source: ${escapeSlackText(notification.source)}` : null,
      `${config.dashboardBaseUrl}/#incidents/${encodeURIComponent(notification.incident_id)}`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const renewed = await pool.query(
        `
          UPDATE incident_notification_outbox
          SET claimed_at = now()
          WHERE id = $1 AND sent_at IS NULL AND claim_token = $2
          RETURNING id
        `,
        [notification.id, claimToken],
      );
      if (renewed.rowCount !== 1) continue;

      const response = await fetcher(config.slackWebhookUrls[notification.workspace_id]!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Slack returned HTTP ${response.status}`);
      }
      const marked = await pool.query(
        `
          UPDATE incident_notification_outbox
          SET
            sent_at = now(),
            attempts = attempts + 1,
            last_error = NULL,
            claimed_at = NULL,
            claim_token = NULL
          WHERE id = $1 AND sent_at IS NULL AND claim_token = $2
        `,
        [notification.id, claimToken],
      );
      if (marked.rowCount === 1) sent += 1;
    } catch (error) {
      await pool.query(
        `
          UPDATE incident_notification_outbox
          SET
            attempts = attempts + 1,
            last_error = $2,
            available_at = now() + LEAST(900, power(2, LEAST(attempts + 1, 9))) * interval '1 second',
            claimed_at = NULL,
            claim_token = NULL
          WHERE id = $1 AND sent_at IS NULL AND claim_token = $3
        `,
        [
          notification.id,
          error instanceof Error
            ? safeErrorMessage(error.message).slice(0, 500)
            : 'Slack delivery failed',
          claimToken,
        ],
      );
    }
  }
  return sent;
}

export async function enforceEventRetention(
  pool: pg.Pool,
  now = new Date(),
  batchSize = 1_000,
  maxBatchesPerWorkspace = 10,
): Promise<number> {
  const workspaces = await pool.query<WorkspaceRetentionRow>(
    `SELECT id, event_retention_days FROM workspaces ORDER BY id`,
  );
  let totalDeleted = 0;
  for (const workspace of workspaces.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let count = 0;
      for (let batch = 0; batch < maxBatchesPerWorkspace; batch += 1) {
        const deleted = await client.query<{ count: number }>(
          `
            WITH candidates AS (
              SELECT ctid
              FROM events
              WHERE
                workspace_id = $1
                AND received_at < $2::timestamptz - ($3::int * interval '1 day')
                AND EXISTS (
                  SELECT 1
                  FROM process_instances
                  WHERE
                    process_instances.workspace_id = events.workspace_id
                    AND process_instances.id = events.process_instance_id
                    AND process_instances.completed_at IS NOT NULL
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM incidents
                  WHERE
                    incidents.workspace_id = events.workspace_id
                    AND incidents.process_instance_id = events.process_instance_id
                    AND incidents.status <> 'resolved'
                )
              ORDER BY received_at, id
              FOR UPDATE SKIP LOCKED
              LIMIT $4
            ),
            removed AS (
              DELETE FROM events
              USING candidates
              WHERE events.ctid = candidates.ctid
              RETURNING 1
            )
            SELECT count(*)::int AS count FROM removed
          `,
          [workspace.id, now, workspace.event_retention_days, batchSize],
        );
        const deletedCount = deleted.rows[0]?.count ?? 0;
        count += deletedCount;
        if (deletedCount < batchSize) break;
      }
      if (count > 0) {
        await client.query(
          `
            INSERT INTO retention_runs (
              id,
              workspace_id,
              retention_days,
              events_deleted,
              completed_at
            )
            VALUES ($1, $2, $3, $4, $5)
          `,
          [`retention_${randomUUID()}`, workspace.id, workspace.event_retention_days, count, now],
        );
        await client.query(
          `
            INSERT INTO workspace_audit_log (
              id,
              workspace_id,
              actor_name,
              action,
              entity_type,
              entity_id,
              details,
              created_at
            )
            VALUES (
              $1,
              $2,
              'retention-worker',
              'events_retained',
              'workspace',
              $2,
              $3::jsonb,
              $4
            )
          `,
          [
            `audit_${randomUUID()}`,
            workspace.id,
            JSON.stringify({
              retentionDays: workspace.event_retention_days,
              eventsDeleted: count,
            }),
            now,
          ],
        );
      }
      await client.query('COMMIT');
      totalDeleted += count;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return totalDeleted;
}

export async function enforceOutboxRetention(
  pool: pg.Pool,
  now = new Date(),
  retentionDays = 90,
  batchSize = 1_000,
  maxBatches = 10,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let totalDeleted = 0;
    for (const table of ['event_evaluation_outbox', 'incident_notification_outbox'] as const) {
      const completionColumn = table === 'event_evaluation_outbox' ? 'published_at' : 'sent_at';
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const result = await client.query<{ count: number }>(
          `
            WITH candidates AS (
              SELECT ctid
              FROM ${table}
              WHERE
                ${completionColumn} IS NOT NULL
                AND created_at < $1::timestamptz - ($2::int * interval '1 day')
              ORDER BY created_at, id
              FOR UPDATE SKIP LOCKED
              LIMIT $3
            ),
            removed AS (
              DELETE FROM ${table}
              USING candidates
              WHERE ${table}.ctid = candidates.ctid
              RETURNING 1
            )
            SELECT count(*)::int AS count FROM removed
          `,
          [now, retentionDays, batchSize],
        );
        const deleted = result.rows[0]?.count ?? 0;
        totalDeleted += deleted;
        if (deleted < batchSize) break;
      }
    }
    await client.query('COMMIT');
    return totalDeleted;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function enforceIdempotencyRetention(
  pool: pg.Pool,
  now = new Date(),
  retentionDays = 365,
  batchSize = 1_000,
  maxBatches = 10,
): Promise<number> {
  let totalDeleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await pool.query<{ count: number }>(
      `
        WITH candidates AS (
          SELECT event_idempotency_keys.ctid
          FROM event_idempotency_keys
          WHERE
            event_idempotency_keys.created_at
              < $1::timestamptz - ($2::int * interval '1 day')
            AND NOT EXISTS (
              SELECT 1
              FROM events
              WHERE
                events.workspace_id = event_idempotency_keys.workspace_id
                AND events.external_event_id = event_idempotency_keys.external_event_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM event_evaluation_outbox
              WHERE
                event_evaluation_outbox.workspace_id = event_idempotency_keys.workspace_id
                AND event_evaluation_outbox.external_event_id
                  = event_idempotency_keys.external_event_id
            )
          ORDER BY
            event_idempotency_keys.created_at,
            event_idempotency_keys.workspace_id,
            event_idempotency_keys.external_event_id
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        ),
        removed AS (
          DELETE FROM event_idempotency_keys
          USING candidates
          WHERE event_idempotency_keys.ctid = candidates.ctid
          RETURNING 1
        )
        SELECT count(*)::int AS count FROM removed
      `,
      [now, retentionDays, batchSize],
    );
    const deleted = result.rows[0]?.count ?? 0;
    totalDeleted += deleted;
    if (deleted < batchSize) break;
  }
  return totalDeleted;
}

export function createPhase2Runtime(
  connection: RedisConnection,
  config: WorkerConfig,
  logger: Logger,
): Phase2Runtime {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  const queue = new Queue<IncidentEvaluationJob>(INCIDENT_EVALUATION_QUEUE, {
    connection,
  });
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let lastSweepAt = 0;
  let lastRetentionAt = 0;
  let status: 'starting' | 'ready' | 'degraded' = 'starting';

  const tick = async (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      const published = await dispatchEvaluationOutbox(pool, queue);
      const notified = await deliverSlackNotifications(pool, config);
      let swept = 0;
      let retained = 0;
      let outboxPruned = 0;
      let idempotencyPruned = 0;
      if (Date.now() - lastSweepAt >= config.phase2SweepIntervalMs) {
        lastSweepAt = Date.now();
        swept = await sweepIncidentDeadlines(pool);
      }
      if (Date.now() - lastRetentionAt >= config.retentionSweepIntervalMs) {
        lastRetentionAt = Date.now();
        retained = await enforceEventRetention(
          pool,
          new Date(),
          config.retentionBatchSize,
          config.retentionMaxBatchesPerSweep,
        );
        outboxPruned = await enforceOutboxRetention(
          pool,
          new Date(),
          config.outboxRetentionDays,
          config.retentionBatchSize,
          config.retentionMaxBatchesPerSweep,
        );
        idempotencyPruned = await enforceIdempotencyRetention(
          pool,
          new Date(),
          config.idempotencyRetentionDays,
          config.retentionBatchSize,
          config.retentionMaxBatchesPerSweep,
        );
      }
      if (
        published > 0 ||
        notified > 0 ||
        swept > 0 ||
        retained > 0 ||
        outboxPruned > 0 ||
        idempotencyPruned > 0
      ) {
        logger.info('worker_cycle_completed', {
          published,
          notified,
          swept,
          retained,
          outboxPruned,
          idempotencyPruned,
        });
      }
      status = 'ready';
    })()
      .catch((error) => {
        status = 'degraded';
        logger.error('phase_2_cycle_failed', safeError(error));
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  return {
    pool,
    getStatus: () => status,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), config.phase2PollIntervalMs);
      timer.unref();
    },
    tick,
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
      await Promise.allSettled([queue.close(), pool.end()]);
    },
  };
}
