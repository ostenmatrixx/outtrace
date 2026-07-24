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
import { safeError } from './logger.js';
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
}

export interface Phase2Runtime {
  readonly pool: pg.Pool;
  close(): Promise<void>;
  start(): void;
  tick(): Promise<void>;
}

const severityRank: Record<IncidentSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

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
        [row.id, error instanceof Error ? error.message.slice(0, 500) : 'Queue publish failed'],
      );
    }
  }
  return published;
}

export async function sweepIncidentDeadlines(pool: pg.Pool, now = new Date()): Promise<number> {
  const result = await pool.query<InstanceRow>(
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
        process_instances.completed_at IS NULL
        OR incidents.id IS NOT NULL
      ORDER BY process_instances.id
      LIMIT 500
    `,
  );
  for (const instance of result.rows) {
    await evaluateProcessInstance(pool, instance.workspace_id, instance.id, now);
  }
  return result.rowCount ?? 0;
}

export async function deliverSlackNotifications(
  pool: pg.Pool,
  config: Pick<WorkerConfig, 'slackWebhookUrl' | 'slackMinimumSeverity' | 'dashboardBaseUrl'>,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  if (!config.slackWebhookUrl) return 0;
  const result = await pool.query<NotificationRow>(
    `
      SELECT
        incident_notification_outbox.id,
        incidents.id AS incident_id,
        incidents.severity,
        incidents.status,
        incidents.business_message,
        incidents.source,
        clients.name AS client_name,
        processes.name AS process_name,
        process_instances.instance_key
      FROM incident_notification_outbox
      JOIN incidents ON incidents.id = incident_notification_outbox.incident_id
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
      ORDER BY incident_notification_outbox.created_at
      LIMIT 50
    `,
  );
  let sent = 0;

  for (const notification of result.rows) {
    if (notification.status === 'resolved') {
      await pool.query(
        `
          UPDATE incident_notification_outbox
          SET sent_at = now(), last_error = 'incident resolved before delivery'
          WHERE id = $1 AND sent_at IS NULL
        `,
        [notification.id],
      );
      continue;
    }

    if (severityRank[notification.severity] < severityRank[config.slackMinimumSeverity]) {
      await pool.query(
        `
          UPDATE incident_notification_outbox
          SET sent_at = now(), last_error = 'below configured severity threshold'
          WHERE id = $1 AND sent_at IS NULL
        `,
        [notification.id],
      );
      continue;
    }

    const text = [
      `*${notification.process_name} incident*`,
      notification.business_message,
      `Client: ${notification.client_name} · Instance: \`${notification.instance_key}\` · Severity: ${notification.severity.toUpperCase()}`,
      notification.source ? `Source: ${notification.source}` : null,
      `${config.dashboardBaseUrl}/#incidents/${encodeURIComponent(notification.incident_id)}`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const response = await fetcher(config.slackWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Slack returned HTTP ${response.status}`);
      }
      await pool.query(
        `
          UPDATE incident_notification_outbox
          SET sent_at = now(), attempts = attempts + 1, last_error = NULL
          WHERE id = $1 AND sent_at IS NULL
        `,
        [notification.id],
      );
      sent += 1;
    } catch (error) {
      await pool.query(
        `
          UPDATE incident_notification_outbox
          SET
            attempts = attempts + 1,
            last_error = $2,
            available_at = now() + LEAST(900, power(2, LEAST(attempts + 1, 9))) * interval '1 second'
          WHERE id = $1 AND sent_at IS NULL
        `,
        [
          notification.id,
          error instanceof Error ? error.message.slice(0, 500) : 'Slack delivery failed',
        ],
      );
    }
  }
  return sent;
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

  const tick = async (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      const published = await dispatchEvaluationOutbox(pool, queue);
      const notified = await deliverSlackNotifications(pool, config);
      let swept = 0;
      if (Date.now() - lastSweepAt >= config.phase2SweepIntervalMs) {
        swept = await sweepIncidentDeadlines(pool);
        lastSweepAt = Date.now();
      }
      if (published > 0 || notified > 0 || swept > 0) {
        logger.info('phase_2_cycle_completed', { published, notified, swept });
      }
    })()
      .catch((error) => {
        logger.error('phase_2_cycle_failed', safeError(error));
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  return {
    pool,
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
