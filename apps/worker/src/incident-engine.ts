import { randomUUID } from 'node:crypto';

import type { IncidentSeverity, IncidentType } from '@outtrace/contracts';
import type pg from 'pg';

interface InstanceRow extends pg.QueryResultRow {
  id: string;
  workspace_id: string;
  instance_key: string;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  process_id: string;
  process_name: string;
  sla_seconds: number | null;
  client_name: string;
}

interface StageRow extends pg.QueryResultRow {
  key: string;
  name: string;
  position: number;
  required: boolean;
  timeout_seconds: number | null;
  source: string | null;
}

interface EventRow extends pg.QueryResultRow {
  external_event_id: string;
  stage: string;
  status: string;
  source: string;
  execution_url: string | null;
  occurred_at: Date;
  received_at: Date;
}

interface ExistingIncidentRow extends pg.QueryResultRow {
  id: string;
  incident_type: IncidentType;
  affected_stage: string | null;
  status: 'open' | 'acknowledged' | 'resolved';
  resolution_reason: 'operator' | 'condition_cleared' | null;
  notification_version: number;
  resolved_at: Date | null;
}

interface Candidate {
  type: IncidentType;
  severity: IncidentSeverity;
  stage: string | null;
  technicalMessage: string;
  businessMessage: string;
  source: string | null;
  executionUrl: string | null;
  triggeredAt: Date;
}

interface CandidateSet {
  active: Map<string, Candidate>;
  clearedSequence: Map<string, Candidate>;
}

export interface IncidentEvaluationResult {
  evaluated: true;
  created: number;
  reopened: number;
  resolved: number;
  active: number;
}

const candidateKey = (type: IncidentType, stage: string | null): string => `${type}:${stage ?? ''}`;

function arrivedBefore(left: EventRow, right: EventRow): boolean {
  return (
    left.received_at < right.received_at ||
    (left.received_at.getTime() === right.received_at.getTime() &&
      left.external_event_id < right.external_event_id)
  );
}

function latestEventsByStage(events: EventRow[]): Map<string, EventRow> {
  const latest = new Map<string, EventRow>();
  for (const event of events) {
    const current = latest.get(event.stage);
    if (
      !current ||
      current.occurred_at < event.occurred_at ||
      (current.occurred_at.getTime() === event.occurred_at.getTime() &&
        current.external_event_id < event.external_event_id)
    ) {
      latest.set(event.stage, event);
    }
  }
  return latest;
}

function completedAtByStage(events: EventRow[]): Map<string, Date> {
  const completed = new Map<string, Date>();
  for (const event of events) {
    if (event.status !== 'completed') continue;
    const current = completed.get(event.stage);
    if (!current || current < event.occurred_at) {
      completed.set(event.stage, event.occurred_at);
    }
  }
  return completed;
}

function deriveProcessState(
  instance: InstanceRow,
  stages: StageRow[],
  events: EventRow[],
): { status: string; completedAt: Date | null } {
  const requiredStages = stages.filter((stage) => stage.required);
  if (requiredStages.length === 0) {
    return { status: instance.status, completedAt: instance.completed_at };
  }

  const completedAt = completedAtByStage(events);
  if (requiredStages.every((stage) => completedAt.has(stage.key))) {
    return {
      status: 'completed',
      completedAt: new Date(
        Math.max(...requiredStages.map((stage) => completedAt.get(stage.key)!.getTime())),
      ),
    };
  }

  const hasActiveFailure = [...latestEventsByStage(events).values()].some(
    (event) => event.status === 'failed',
  );
  return {
    status: hasActiveFailure ? 'failed' : 'started',
    completedAt: null,
  };
}

function buildCandidates(
  instance: InstanceRow,
  stages: StageRow[],
  events: EventRow[],
  now: Date,
): CandidateSet {
  const candidates = new Map<string, Candidate>();
  const clearedSequence = new Map<string, Candidate>();
  const latestByStage = latestEventsByStage(events);
  const completedAt = completedAtByStage(events);
  const stageByKey = new Map(stages.map((stage) => [stage.key, stage]));
  const requiredStages = stages
    .filter((stage) => stage.required)
    .sort((a, b) => a.position - b.position);
  // Arrival-order incidents use received_at; stage state and completion use occurred_at.
  const earliestCompletedArrivalByStage = new Map<string, EventRow>();
  for (const event of events) {
    if (event.status !== 'completed') continue;
    const current = earliestCompletedArrivalByStage.get(event.stage);
    if (!current || arrivedBefore(event, current)) {
      earliestCompletedArrivalByStage.set(event.stage, event);
    }
  }

  for (const [stageKey, event] of latestByStage) {
    if (event.status !== 'failed') continue;
    const stage = stageByKey.get(stageKey);
    const stageName = stage?.name ?? stageKey;
    const candidate: Candidate = {
      type: 'reported_failure',
      severity: 'high',
      stage: stageKey,
      technicalMessage: `${event.source} reported a failed event for stage ${stageKey}.`,
      businessMessage: `${stageName} failed for ${instance.client_name} process ${instance.process_name}, instance ${instance.instance_key}.`,
      source: event.source,
      executionUrl: event.execution_url,
      triggeredAt: event.received_at,
    };
    candidates.set(candidateKey(candidate.type, candidate.stage), candidate);
  }

  for (const event of events) {
    const stage = stageByKey.get(event.stage);
    if (!stage) continue;
    const predecessors = requiredStages.filter((required) => required.position < stage.position);
    const missingAtOccurrence = predecessors.filter((required) => {
      const completion = earliestCompletedArrivalByStage.get(required.key);
      return !completion || !arrivedBefore(completion, event);
    });
    if (missingAtOccurrence.length === 0) continue;
    const missingNames = missingAtOccurrence.map((required) => required.name).join(', ');
    const candidate: Candidate = {
      type: 'unexpected_sequence',
      severity: 'medium',
      stage: event.stage,
      technicalMessage: `Stage ${event.stage} arrived before required predecessor stages: ${missingAtOccurrence
        .map((required) => required.key)
        .join(', ')}.`,
      businessMessage: `${stage.name} arrived before ${missingNames} for ${instance.instance_key}.`,
      source: event.source,
      executionUrl: event.execution_url,
      triggeredAt: event.received_at,
    };
    const key = candidateKey(candidate.type, candidate.stage);
    if (missingAtOccurrence.some((required) => !completedAt.has(required.key))) {
      if (!candidates.has(key)) candidates.set(key, candidate);
      clearedSequence.delete(key);
    } else if (!candidates.has(key) && !clearedSequence.has(key)) {
      clearedSequence.set(key, candidate);
    }
  }

  for (let index = 0; index < requiredStages.length; index += 1) {
    const stage = requiredStages[index]!;
    if (completedAt.has(stage.key) || stage.timeout_seconds === null) continue;
    const predecessor = requiredStages[index - 1];
    const baseline = predecessor ? completedAt.get(predecessor.key) : instance.started_at;
    if (!baseline) continue;
    const deadline = new Date(baseline.getTime() + stage.timeout_seconds * 1_000);
    if (now < deadline) continue;
    const candidate: Candidate = {
      type: 'missing_stage',
      severity: stage.position === 0 ? 'high' : 'medium',
      stage: stage.key,
      technicalMessage: `Required stage ${stage.key} was not completed within ${stage.timeout_seconds} seconds.`,
      businessMessage: `${stage.name} is overdue for ${instance.client_name} instance ${instance.instance_key}.`,
      source: stage.source,
      executionUrl: null,
      triggeredAt: deadline,
    };
    candidates.set(candidateKey(candidate.type, candidate.stage), candidate);
  }

  if (
    instance.sla_seconds !== null &&
    instance.completed_at === null &&
    now.getTime() >= instance.started_at.getTime() + instance.sla_seconds * 1_000
  ) {
    const candidate: Candidate = {
      type: 'sla_violation',
      severity: 'critical',
      stage: null,
      technicalMessage: `Process duration exceeded the configured ${instance.sla_seconds}-second SLA.`,
      businessMessage: `${instance.process_name} exceeded its completion SLA for ${instance.instance_key}.`,
      source: null,
      executionUrl: null,
      triggeredAt: new Date(instance.started_at.getTime() + instance.sla_seconds * 1_000),
    };
    candidates.set(candidateKey(candidate.type, candidate.stage), candidate);
  }

  return { active: candidates, clearedSequence };
}

async function addAudit(
  client: pg.PoolClient,
  workspaceId: string,
  incidentId: string,
  action: 'created' | 'reopened' | 'resolved',
): Promise<void> {
  await client.query(
    `
      INSERT INTO incident_audit_log (id, workspace_id, incident_id, action, actor)
      VALUES ($1, $2, $3, $4, 'incident-engine')
    `,
    [`audit_${randomUUID()}`, workspaceId, incidentId, action],
  );
}

async function enqueueNotification(
  client: pg.PoolClient,
  workspaceId: string,
  incidentId: string,
  notificationVersion: number,
): Promise<void> {
  await client.query(
    `
      INSERT INTO incident_notification_outbox (
        id,
        workspace_id,
        incident_id,
        notification_version
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (incident_id, notification_version) DO NOTHING
    `,
    [`notification_${randomUUID()}`, workspaceId, incidentId, notificationVersion],
  );
}

export async function evaluateProcessInstance(
  pool: pg.Pool,
  workspaceId: string,
  processInstanceId: string,
  now = new Date(),
): Promise<IncidentEvaluationResult> {
  const client = await pool.connect();
  let created = 0;
  let reopened = 0;
  let resolved = 0;

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `incident:${workspaceId}:${processInstanceId}`,
    ]);
    const instanceResult = await client.query<InstanceRow>(
      `
        SELECT
          process_instances.id,
          process_instances.workspace_id,
          process_instances.instance_key,
          process_instances.status,
          process_instances.started_at,
          process_instances.completed_at,
          processes.id AS process_id,
          processes.name AS process_name,
          processes.sla_seconds,
          clients.name AS client_name
        FROM process_instances
        JOIN processes
          ON processes.workspace_id = process_instances.workspace_id
          AND processes.id = process_instances.process_id
        JOIN clients
          ON clients.workspace_id = processes.workspace_id
          AND clients.id = processes.client_id
        WHERE process_instances.workspace_id = $1 AND process_instances.id = $2
      `,
      [workspaceId, processInstanceId],
    );
    const instance = instanceResult.rows[0];
    if (!instance) {
      await client.query('COMMIT');
      return { evaluated: true, created: 0, reopened: 0, resolved: 0, active: 0 };
    }

    const stagesResult = await client.query<StageRow>(
      `
          SELECT key, name, position, required, timeout_seconds, source
          FROM process_stages
          WHERE workspace_id = $1 AND process_id = $2
          ORDER BY position
        `,
      [workspaceId, instance.process_id],
    );
    const eventsResult = await client.query<EventRow>(
      `
          SELECT
            external_event_id,
            stage,
            status,
            source,
            metadata->>'executionUrl' AS execution_url,
            occurred_at,
            received_at
          FROM events
          WHERE workspace_id = $1 AND process_instance_id = $2
          ORDER BY received_at, external_event_id
        `,
      [workspaceId, processInstanceId],
    );
    const incidentsResult = await client.query<ExistingIncidentRow>(
      `
          SELECT
            id,
            incident_type,
            affected_stage,
            status,
            resolution_reason,
            notification_version,
            resolved_at
          FROM incidents
          WHERE workspace_id = $1 AND process_instance_id = $2
        `,
      [workspaceId, processInstanceId],
    );

    const derivedState = deriveProcessState(instance, stagesResult.rows, eventsResult.rows);
    if (
      derivedState.status !== instance.status ||
      derivedState.completedAt?.getTime() !== instance.completed_at?.getTime()
    ) {
      await client.query(
        `
          UPDATE process_instances
          SET status = $3, completed_at = $4, updated_at = now()
          WHERE workspace_id = $1 AND id = $2
        `,
        [workspaceId, processInstanceId, derivedState.status, derivedState.completedAt],
      );
      instance.status = derivedState.status;
      instance.completed_at = derivedState.completedAt;
    }

    const candidateSet = buildCandidates(instance, stagesResult.rows, eventsResult.rows, now);
    const candidates = candidateSet.active;
    const existing = new Map(
      incidentsResult.rows.map((incident) => [
        candidateKey(incident.incident_type, incident.affected_stage),
        incident,
      ]),
    );

    for (const [key, candidate] of candidateSet.clearedSequence) {
      if (existing.has(key) || candidates.has(key)) continue;
      const incidentId = `incident_${randomUUID()}`;
      await client.query(
        `
          INSERT INTO incidents (
            id,
            workspace_id,
            process_instance_id,
            incident_type,
            severity,
            status,
            affected_stage,
            technical_message,
            business_message,
            source,
            execution_url,
            resolved_at,
            resolution_reason
          )
          VALUES ($1, $2, $3, $4, $5, 'resolved', $6, $7, $8, $9, $10, now(), 'condition_cleared')
        `,
        [
          incidentId,
          workspaceId,
          processInstanceId,
          candidate.type,
          candidate.severity,
          candidate.stage,
          candidate.technicalMessage,
          candidate.businessMessage,
          candidate.source,
          candidate.executionUrl,
        ],
      );
      await addAudit(client, workspaceId, incidentId, 'created');
      await addAudit(client, workspaceId, incidentId, 'resolved');
      existing.set(key, {
        id: incidentId,
        incident_type: candidate.type,
        affected_stage: candidate.stage,
        status: 'resolved',
        resolution_reason: 'condition_cleared',
        notification_version: 1,
        resolved_at: now,
      });
      created += 1;
      resolved += 1;
    }

    for (const [key, candidate] of candidates) {
      const incident = existing.get(key);
      if (!incident) {
        const incidentId = `incident_${randomUUID()}`;
        await client.query(
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
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            incidentId,
            workspaceId,
            processInstanceId,
            candidate.type,
            candidate.severity,
            candidate.stage,
            candidate.technicalMessage,
            candidate.businessMessage,
            candidate.source,
            candidate.executionUrl,
          ],
        );
        await addAudit(client, workspaceId, incidentId, 'created');
        await enqueueNotification(client, workspaceId, incidentId, 1);
        created += 1;
        continue;
      }

      const isNewOccurrenceAfterOperatorResolution =
        incident.status === 'resolved' &&
        incident.resolution_reason === 'operator' &&
        incident.resolved_at !== null &&
        candidate.triggeredAt > incident.resolved_at;
      if (
        incident.status === 'resolved' &&
        (incident.resolution_reason === 'condition_cleared' ||
          isNewOccurrenceAfterOperatorResolution)
      ) {
        const nextVersion = incident.notification_version + 1;
        await client.query(
          `
            UPDATE incidents
            SET
              severity = $3,
              status = 'open',
              technical_message = $4,
              business_message = $5,
              source = $6,
              execution_url = $7,
              notification_version = $8,
              acknowledged_at = NULL,
              resolved_at = NULL,
              resolution_reason = NULL,
              updated_at = now()
            WHERE workspace_id = $1 AND id = $2
          `,
          [
            workspaceId,
            incident.id,
            candidate.severity,
            candidate.technicalMessage,
            candidate.businessMessage,
            candidate.source,
            candidate.executionUrl,
            nextVersion,
          ],
        );
        await addAudit(client, workspaceId, incident.id, 'reopened');
        await enqueueNotification(client, workspaceId, incident.id, nextVersion);
        reopened += 1;
      } else if (incident.status !== 'resolved') {
        await client.query(
          `
            UPDATE incidents
            SET
              severity = $3,
              technical_message = $4,
              business_message = $5,
              source = $6,
              execution_url = COALESCE($7, execution_url),
              updated_at = now()
            WHERE workspace_id = $1 AND id = $2
          `,
          [
            workspaceId,
            incident.id,
            candidate.severity,
            candidate.technicalMessage,
            candidate.businessMessage,
            candidate.source,
            candidate.executionUrl,
          ],
        );
      }
    }

    for (const incident of incidentsResult.rows) {
      const key = candidateKey(incident.incident_type, incident.affected_stage);
      if (incident.status === 'resolved' || candidates.has(key)) continue;
      await client.query(
        `
          UPDATE incidents
          SET
            status = 'resolved',
            resolved_at = now(),
            resolution_reason = 'condition_cleared',
            updated_at = now()
          WHERE workspace_id = $1 AND id = $2
        `,
        [workspaceId, incident.id],
      );
      await addAudit(client, workspaceId, incident.id, 'resolved');
      resolved += 1;
    }

    await client.query('COMMIT');
    return {
      evaluated: true,
      created,
      reopened,
      resolved,
      active: candidates.size,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
