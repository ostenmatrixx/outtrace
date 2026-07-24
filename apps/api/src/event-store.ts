import { randomUUID } from 'node:crypto';

import type { IngestEvent, IngestEventResponse } from '@outtrace/contracts';
import type pg from 'pg';

import { databaseFailure, HttpError } from './errors.js';
import { sanitizeMetadata } from './metadata.js';

interface IdRow extends pg.QueryResultRow {
  id: string;
}

interface ProcessRow extends IdRow {
  metadata_allowlist: string[];
}

interface InstanceRow extends IdRow {
  inserted: boolean;
}

interface DuplicateRow extends pg.QueryResultRow {
  process_instance_id: string;
}

export async function persistEvent(
  pool: pg.Pool,
  workspaceId: string,
  event: IngestEvent,
): Promise<IngestEventResponse> {
  let client: pg.PoolClient | undefined;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    // Serialize one external event ID per tenant so concurrent retries cannot create orphan instances.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${workspaceId}:${event.eventId}`,
    ]);

    const processResult = await client.query<ProcessRow>(
      `
        SELECT id, metadata_allowlist
        FROM processes
        WHERE workspace_id = $1 AND key = $2
      `,
      [workspaceId, event.processKey],
    );
    const processRecord = processResult.rows[0];

    if (!processRecord) {
      throw new HttpError(
        404,
        'UNKNOWN_PROCESS',
        'No process with that key exists in the authenticated workspace.',
      );
    }

    const duplicateResult = await client.query<DuplicateRow>(
      `
        SELECT process_instance_id
        FROM events
        WHERE workspace_id = $1 AND external_event_id = $2
      `,
      [workspaceId, event.eventId],
    );
    const duplicate = duplicateResult.rows[0];

    if (duplicate) {
      await client.query('COMMIT');
      transactionStarted = false;
      return {
        accepted: true,
        duplicate: true,
        eventId: event.eventId,
        processInstanceId: duplicate.process_instance_id,
      };
    }

    const instanceId = `pi_${randomUUID()}`;
    const instanceResult = await client.query<InstanceRow>(
      `
        INSERT INTO process_instances (
          id,
          workspace_id,
          process_id,
          instance_key,
          status,
          started_at
        )
        VALUES ($1, $2, $3, $4, 'started', $5)
        ON CONFLICT (process_id, instance_key) DO UPDATE
        SET instance_key = EXCLUDED.instance_key
        RETURNING id, (xmax = 0) AS inserted
      `,
      [instanceId, workspaceId, processRecord.id, event.instanceKey, event.occurredAt],
    );
    const instance = instanceResult.rows[0];

    if (!instance) {
      throw new Error('Process instance correlation returned no row.');
    }

    const eventInsert = await client.query<IdRow>(
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        ON CONFLICT (workspace_id, external_event_id) DO NOTHING
        RETURNING id
      `,
      [
        `evt_${randomUUID()}`,
        workspaceId,
        instance.id,
        event.eventId,
        event.stage,
        event.status,
        event.source,
        JSON.stringify(sanitizeMetadata(event.metadata, processRecord.metadata_allowlist)),
        event.occurredAt,
      ],
    );

    if (eventInsert.rowCount === 0) {
      const concurrentlyInserted = await client.query<DuplicateRow>(
        `
          SELECT process_instance_id
          FROM events
          WHERE workspace_id = $1 AND external_event_id = $2
        `,
        [workspaceId, event.eventId],
      );
      const original = concurrentlyInserted.rows[0];

      if (!original) {
        throw new Error('Conflicting event could not be resolved.');
      }

      if (instance.inserted && original.process_instance_id !== instance.id) {
        await client.query(
          `
            DELETE FROM process_instances
            WHERE
              id = $1
              AND workspace_id = $2
              AND NOT EXISTS (
                SELECT 1 FROM events WHERE process_instance_id = $1 AND workspace_id = $2
              )
          `,
          [instance.id, workspaceId],
        );
      }

      await client.query('COMMIT');
      transactionStarted = false;
      return {
        accepted: true,
        duplicate: true,
        eventId: event.eventId,
        processInstanceId: original.process_instance_id,
      };
    }

    await client.query(
      `
        INSERT INTO event_evaluation_outbox (
          id,
          workspace_id,
          process_instance_id,
          external_event_id
        )
        VALUES ($1, $2, $3, $4)
      `,
      [`evaluation_${randomUUID()}`, workspaceId, instance.id, event.eventId],
    );

    await client.query(
      `
        UPDATE process_instances
        SET
          started_at = LEAST(started_at, $3),
          status = CASE
            WHEN
              latest_event_occurred_at IS NULL
              OR latest_event_occurred_at < $3
              OR (
                latest_event_occurred_at = $3
                AND COALESCE(latest_event_external_id, '') < $4
              )
            THEN $1
            ELSE status
          END,
          current_stage = CASE
            WHEN
              latest_event_occurred_at IS NULL
              OR latest_event_occurred_at < $3
              OR (
                latest_event_occurred_at = $3
                AND COALESCE(latest_event_external_id, '') < $4
              )
            THEN $2
            ELSE current_stage
          END,
          latest_event_occurred_at = CASE
            WHEN
              latest_event_occurred_at IS NULL
              OR latest_event_occurred_at < $3
              OR (
                latest_event_occurred_at = $3
                AND COALESCE(latest_event_external_id, '') < $4
              )
            THEN $3
            ELSE latest_event_occurred_at
          END,
          latest_event_external_id = CASE
            WHEN
              latest_event_occurred_at IS NULL
              OR latest_event_occurred_at < $3
              OR (
                latest_event_occurred_at = $3
                AND COALESCE(latest_event_external_id, '') < $4
              )
            THEN $4
            ELSE latest_event_external_id
          END,
          completed_at = CASE
            WHEN
              latest_event_occurred_at IS NULL
              OR latest_event_occurred_at < $3
              OR (
                latest_event_occurred_at = $3
                AND COALESCE(latest_event_external_id, '') < $4
              )
            THEN CASE WHEN $1 = 'completed' THEN $3::timestamptz ELSE NULL END
            ELSE completed_at
          END,
          updated_at = now()
        WHERE
          id = $5
          AND workspace_id = $6
      `,
      [event.status, event.stage, event.occurredAt, event.eventId, instance.id, workspaceId],
    );

    await client.query('COMMIT');
    transactionStarted = false;

    return {
      accepted: true,
      duplicate: false,
      eventId: event.eventId,
      processInstanceId: instance.id,
    };
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is more useful and is mapped below without leaking database details.
      }
    }

    if (error instanceof HttpError) {
      throw error;
    }

    throw databaseFailure();
  } finally {
    client?.release();
  }
}
