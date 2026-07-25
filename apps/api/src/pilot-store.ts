import type { PilotSummary } from '@outtrace/contracts';
import type pg from 'pg';

import { databaseFailure } from './errors.js';

const PILOT_WINDOW_DAYS = 28;
const PILOT_WINDOW_MILLISECONDS = PILOT_WINDOW_DAYS * 24 * 60 * 60 * 1_000;

interface ActivationRow extends pg.QueryResultRow {
  connected: number;
  median_seconds_to_first_event: number | string | null;
  total: number;
}

interface QualityRow extends pg.QueryResultRow {
  false_positive: number;
  genuine: number;
  total: number;
}

interface PilotProcessRow extends pg.QueryResultRow {
  client_id: string;
  client_name: string;
  connected_at: Date | null;
  event_count: number;
  id: string;
  key: string;
  last_event_received_at: Date | null;
  name: string;
}

export async function getPilotSummary(
  pool: pg.Pool,
  workspaceId: string,
  generatedAt = new Date(),
): Promise<PilotSummary> {
  const windowStartedAt = new Date(generatedAt.getTime() - PILOT_WINDOW_MILLISECONDS);
  try {
    const [activationResult, qualityResult, processesResult] = await Promise.all([
      pool.query<ActivationRow>(
        `
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE connected_at IS NOT NULL)::int AS connected,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY extract(epoch FROM (connected_at - created_at))
            ) FILTER (WHERE connected_at IS NOT NULL) AS median_seconds_to_first_event
          FROM processes
          WHERE
            workspace_id = $1
            AND environment = 'production'
            AND lifecycle_status = 'active'
        `,
        [workspaceId],
      ),
      pool.query<QualityRow>(
        `
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE incident_feedback.verdict = 'genuine')::int AS genuine,
            count(*) FILTER (
              WHERE incident_feedback.verdict = 'false_positive'
            )::int AS false_positive
          FROM incidents
          JOIN process_instances
            ON process_instances.workspace_id = incidents.workspace_id
            AND process_instances.id = incidents.process_instance_id
          JOIN processes
            ON processes.workspace_id = process_instances.workspace_id
            AND processes.id = process_instances.process_id
          LEFT JOIN incident_feedback
            ON incident_feedback.workspace_id = incidents.workspace_id
            AND incident_feedback.incident_id = incidents.id
          WHERE
            incidents.workspace_id = $1
            AND processes.environment = 'production'
            AND incidents.created_at >= $2
            AND incidents.created_at < $3
        `,
        [workspaceId, windowStartedAt, generatedAt],
      ),
      pool.query<PilotProcessRow>(
        `
          SELECT
            processes.id,
            processes.key,
            processes.name,
            processes.client_id,
            clients.name AS client_name,
            processes.connected_at,
            processes.last_event_received_at,
            (
              SELECT count(*)::int
              FROM events
              JOIN process_instances
                ON process_instances.workspace_id = events.workspace_id
                AND process_instances.id = events.process_instance_id
              WHERE
                events.workspace_id = processes.workspace_id
                AND process_instances.process_id = processes.id
            ) AS event_count
          FROM processes
          JOIN clients
            ON clients.workspace_id = processes.workspace_id
            AND clients.id = processes.client_id
          WHERE
            processes.workspace_id = $1
            AND processes.environment = 'production'
            AND processes.lifecycle_status = 'active'
          ORDER BY clients.name, processes.name, processes.id
        `,
        [workspaceId],
      ),
    ]);

    const activation = activationResult.rows[0] ?? {
      connected: 0,
      median_seconds_to_first_event: null,
      total: 0,
    };
    const quality = qualityResult.rows[0] ?? {
      false_positive: 0,
      genuine: 0,
      total: 0,
    };
    const reviewed = quality.genuine + quality.false_positive;

    return {
      windowDays: PILOT_WINDOW_DAYS,
      windowStartedAt: windowStartedAt.toISOString(),
      generatedAt: generatedAt.toISOString(),
      activation: {
        totalProcesses: activation.total,
        connectedProcesses: activation.connected,
        awaitingFirstEvent: activation.total - activation.connected,
        connectionRate: activation.total === 0 ? 0 : activation.connected / activation.total,
        medianSecondsToFirstEvent:
          activation.median_seconds_to_first_event === null
            ? null
            : Number(activation.median_seconds_to_first_event),
      },
      quality: {
        incidentsDetected: quality.total,
        reviewedIncidents: reviewed,
        genuineIncidents: quality.genuine,
        falsePositiveIncidents: quality.false_positive,
        unreviewedIncidents: quality.total - reviewed,
        falsePositiveRate: reviewed === 0 ? null : quality.false_positive / reviewed,
      },
      processes: processesResult.rows.map((process) => ({
        id: process.id,
        key: process.key,
        name: process.name,
        clientId: process.client_id,
        clientName: process.client_name,
        connectionStatus:
          process.connected_at === null ? 'awaiting_first_event' : ('connected' as const),
        eventCount: process.event_count,
        connectedAt: process.connected_at?.toISOString() ?? null,
        lastEventAt: process.last_event_received_at?.toISOString() ?? null,
      })),
    };
  } catch {
    throw databaseFailure();
  }
}
