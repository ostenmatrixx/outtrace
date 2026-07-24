import { randomUUID } from 'node:crypto';

import type {
  IncidentDetail,
  IncidentListResponse,
  IncidentNoteCreate,
  IncidentStatusUpdate,
  IncidentSummary,
} from '@outtrace/contracts';
import type pg from 'pg';

import { databaseFailure, HttpError } from './errors.js';

interface IncidentRow extends pg.QueryResultRow {
  id: string;
  incident_type: IncidentSummary['incidentType'];
  severity: IncidentSummary['severity'];
  status: IncidentSummary['status'];
  affected_stage: string | null;
  technical_message: string;
  business_message: string;
  assigned_to: string | null;
  source: string | null;
  execution_url: string | null;
  created_at: Date;
  updated_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  client_id: string;
  client_name: string;
  process_id: string;
  process_key: string;
  process_name: string;
  process_instance_id: string;
  instance_key: string;
  instance_status: string;
  total_count?: number;
}

interface EventRow extends pg.QueryResultRow {
  id: string;
  external_event_id: string;
  stage: string;
  status: string;
  source: string;
  execution_url: string | null;
  occurred_at: Date;
  received_at: Date;
}

interface NoteRow extends pg.QueryResultRow {
  id: string;
  author: string;
  body: string;
  created_at: Date;
}

export interface IncidentFilters {
  clientId?: string | undefined;
  limit: number;
  processId?: string | undefined;
  severity?: IncidentSummary['severity'] | undefined;
  source?: string | undefined;
  status?: IncidentSummary['status'] | undefined;
  type?: IncidentSummary['incidentType'] | undefined;
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function mapIncident(row: IncidentRow): IncidentSummary {
  return {
    id: row.id,
    incidentType: row.incident_type,
    severity: row.severity,
    status: row.status,
    affectedStage: row.affected_stage,
    technicalMessage: row.technical_message,
    businessMessage: row.business_message,
    assignedTo: row.assigned_to,
    source: row.source,
    executionUrl: row.execution_url,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    acknowledgedAt: toIso(row.acknowledged_at),
    resolvedAt: toIso(row.resolved_at),
    client: {
      id: row.client_id,
      name: row.client_name,
    },
    process: {
      id: row.process_id,
      key: row.process_key,
      name: row.process_name,
    },
    instance: {
      id: row.process_instance_id,
      key: row.instance_key,
      status: row.instance_status,
    },
  };
}

const incidentSelect = `
  SELECT
    incidents.id,
    incidents.incident_type,
    incidents.severity,
    incidents.status,
    incidents.affected_stage,
    incidents.technical_message,
    incidents.business_message,
    incidents.assigned_to,
    incidents.source,
    incidents.execution_url,
    incidents.created_at,
    incidents.updated_at,
    incidents.acknowledged_at,
    incidents.resolved_at,
    clients.id AS client_id,
    clients.name AS client_name,
    processes.id AS process_id,
    processes.key AS process_key,
    processes.name AS process_name,
    process_instances.id AS process_instance_id,
    process_instances.instance_key,
    process_instances.status AS instance_status
  FROM incidents
  JOIN process_instances
    ON process_instances.workspace_id = incidents.workspace_id
    AND process_instances.id = incidents.process_instance_id
  JOIN processes
    ON processes.workspace_id = process_instances.workspace_id
    AND processes.id = process_instances.process_id
  JOIN clients
    ON clients.workspace_id = processes.workspace_id
    AND clients.id = processes.client_id
`;

export async function listIncidents(
  pool: pg.Pool,
  workspaceId: string,
  filters: IncidentFilters,
): Promise<IncidentListResponse> {
  const values: unknown[] = [workspaceId];
  const clauses = ['incidents.workspace_id = $1'];
  const addFilter = (column: string, value: unknown): void => {
    values.push(value);
    clauses.push(`${column} = $${values.length}`);
  };

  if (filters.status) addFilter('incidents.status', filters.status);
  if (filters.severity) addFilter('incidents.severity', filters.severity);
  if (filters.type) addFilter('incidents.incident_type', filters.type);
  if (filters.clientId) addFilter('clients.id', filters.clientId);
  if (filters.processId) addFilter('processes.id', filters.processId);
  if (filters.source) addFilter('incidents.source', filters.source);
  values.push(filters.limit);

  try {
    const result = await pool.query<IncidentRow>(
      `
        SELECT incident_rows.*, count(*) OVER ()::int AS total_count
        FROM (
          ${incidentSelect}
          WHERE ${clauses.join(' AND ')}
        ) AS incident_rows
        ORDER BY
          CASE incident_rows.severity
            WHEN 'critical' THEN 1
            WHEN 'high' THEN 2
            WHEN 'medium' THEN 3
            ELSE 4
          END,
          incident_rows.created_at DESC
        LIMIT $${values.length}
      `,
      values,
    );

    return {
      incidents: result.rows.map(mapIncident),
      total: result.rows[0]?.total_count ?? 0,
    };
  } catch {
    throw databaseFailure();
  }
}

async function findIncident(
  client: pg.Pool | pg.PoolClient,
  workspaceId: string,
  incidentId: string,
): Promise<IncidentRow> {
  const result = await client.query<IncidentRow>(
    `
      ${incidentSelect}
      WHERE incidents.workspace_id = $1 AND incidents.id = $2
    `,
    [workspaceId, incidentId],
  );
  const incident = result.rows[0];
  if (!incident) {
    throw new HttpError(404, 'INCIDENT_NOT_FOUND', 'The incident does not exist.');
  }
  return incident;
}

export async function getIncident(
  pool: pg.Pool,
  workspaceId: string,
  incidentId: string,
): Promise<IncidentDetail> {
  try {
    const incident = await findIncident(pool, workspaceId, incidentId);
    const [events, notes] = await Promise.all([
      pool.query<EventRow>(
        `
          SELECT
            id,
            external_event_id,
            stage,
            status,
            source,
            metadata->>'executionUrl' AS execution_url,
            occurred_at,
            received_at
          FROM events
          WHERE workspace_id = $1 AND process_instance_id = $2
          ORDER BY occurred_at, external_event_id
        `,
        [workspaceId, incident.process_instance_id],
      ),
      pool.query<NoteRow>(
        `
          SELECT id, author, body, created_at
          FROM incident_notes
          WHERE workspace_id = $1 AND incident_id = $2
          ORDER BY created_at, id
        `,
        [workspaceId, incidentId],
      ),
    ]);

    return {
      ...mapIncident(incident),
      timeline: events.rows.map((event) => ({
        id: event.id,
        eventId: event.external_event_id,
        stage: event.stage,
        status: event.status,
        source: event.source,
        executionUrl: event.execution_url,
        occurredAt: event.occurred_at.toISOString(),
        receivedAt: event.received_at.toISOString(),
      })),
      notes: notes.rows.map((note) => ({
        id: note.id,
        author: note.author,
        body: note.body,
        createdAt: note.created_at.toISOString(),
      })),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw databaseFailure();
  }
}

export async function updateIncident(
  pool: pg.Pool,
  workspaceId: string,
  incidentId: string,
  update: IncidentStatusUpdate,
  actor: string,
): Promise<IncidentDetail> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await findIncident(client, workspaceId, incidentId);
    const nextStatus = update.status ?? current.status;
    const nextAssignedTo =
      update.assignedTo === undefined ? current.assigned_to : update.assignedTo;

    await client.query(
      `
        UPDATE incidents
        SET
          status = $3,
          assigned_to = $4,
          acknowledged_at = CASE
            WHEN $3 = 'acknowledged' THEN COALESCE(acknowledged_at, now())
            ELSE acknowledged_at
          END,
          resolved_at = CASE WHEN $3 = 'resolved' THEN now() ELSE NULL END,
          resolution_reason = CASE WHEN $3 = 'resolved' THEN 'operator' ELSE NULL END,
          updated_at = now()
        WHERE workspace_id = $1 AND id = $2
      `,
      [workspaceId, incidentId, nextStatus, nextAssignedTo],
    );

    const actions: Array<{ action: string; details: Record<string, unknown> }> = [];
    if (update.status && update.status !== current.status) {
      actions.push({ action: update.status, details: { previousStatus: current.status } });
    }
    if (update.assignedTo !== undefined && update.assignedTo !== current.assigned_to) {
      actions.push({
        action: 'assigned',
        details: { assignedTo: update.assignedTo, previousAssignee: current.assigned_to },
      });
    }

    for (const entry of actions) {
      await client.query(
        `
          INSERT INTO incident_audit_log (id, workspace_id, incident_id, action, actor, details)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        `,
        [
          `audit_${randomUUID()}`,
          workspaceId,
          incidentId,
          entry.action,
          actor,
          JSON.stringify(entry.details),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw databaseFailure();
  } finally {
    client.release();
  }

  return getIncident(pool, workspaceId, incidentId);
}

export async function addIncidentNote(
  pool: pg.Pool,
  workspaceId: string,
  incidentId: string,
  note: IncidentNoteCreate,
): Promise<IncidentDetail> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await findIncident(client, workspaceId, incidentId);
    await client.query(
      `
        INSERT INTO incident_notes (id, workspace_id, incident_id, author, body)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [`note_${randomUUID()}`, workspaceId, incidentId, note.author, note.body],
    );
    await client.query(
      `
        INSERT INTO incident_audit_log (id, workspace_id, incident_id, action, actor)
        VALUES ($1, $2, $3, 'note_added', $4)
      `,
      [`audit_${randomUUID()}`, workspaceId, incidentId, note.author],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw databaseFailure();
  } finally {
    client.release();
  }

  return getIncident(pool, workspaceId, incidentId);
}
