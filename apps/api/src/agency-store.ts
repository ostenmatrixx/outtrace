import { randomBytes, randomUUID } from 'node:crypto';

import type {
  ClientCreate,
  ClientReliabilityReport,
  ClientSummary,
  MemberInvite,
  MemberInviteResponse,
  MemberCredentialResponse,
  MemberSummary,
  MemberUpdate,
  ProcessCreate,
  ProcessCreateResponse,
  ProcessCredentialIssue,
  ProcessCredentialRevoke,
  ProcessCredentialResponse,
  ProcessCredentialSummary,
  ProcessSummary,
  ProcessStage,
  ProcessUpdate,
  WorkspaceSettings,
} from '@outtrace/contracts';
import type pg from 'pg';

import type { OperatorPrincipal } from './authentication.js';
import { sha256Hex } from './crypto.js';
import { databaseFailure, HttpError, resourceConflict, resourceNotFound } from './errors.js';

interface ClientRow extends pg.QueryResultRow {
  id: string;
  name: string;
  process_count: number;
  open_incident_count: number;
  created_at: Date;
}

interface MemberRow extends pg.QueryResultRow {
  id: string;
  name: string;
  email: string;
  role: MemberSummary['role'];
  status: MemberSummary['status'];
  client_ids: string[];
  created_at: Date;
  access_key_id?: string;
}

interface ProcessRow extends pg.QueryResultRow {
  connected_at: Date | null;
  created_at: Date;
  environment: ProcessSummary['environment'];
  event_count: number;
  id: string;
  key: string;
  last_event_received_at: Date | null;
  lifecycle_status: ProcessSummary['lifecycleStatus'];
  name: string;
  client_id: string;
  client_name: string;
  sla_seconds: number | null;
  stage_count: number;
  metadata_allowlist: string[];
}

interface ProcessStageRow extends pg.QueryResultRow {
  id: string;
  key: string;
  name: string;
  owning_team: string | null;
  position: number;
  required: boolean;
  source: ProcessStage['source'];
  timeout_seconds: number | null;
}

interface ProcessCredentialRow extends pg.QueryResultRow {
  created_at: Date;
  id: string;
  key_id: string;
  process_id: string;
  revoked_at: Date | null;
  revocation_reason: string | null;
}

const mapClient = (row: ClientRow): ClientSummary => ({
  id: row.id,
  name: row.name,
  processCount: row.process_count,
  openIncidentCount: row.open_incident_count,
  createdAt: row.created_at.toISOString(),
});

const mapMember = (row: MemberRow): MemberSummary => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  status: row.status,
  clientIds: row.client_ids,
  createdAt: row.created_at.toISOString(),
});

const mapProcess = (row: ProcessRow): ProcessSummary => ({
  id: row.id,
  key: row.key,
  name: row.name,
  clientId: row.client_id,
  clientName: row.client_name,
  environment: row.environment,
  lifecycleStatus: row.lifecycle_status,
  slaSeconds: row.sla_seconds,
  metadataAllowlist: row.metadata_allowlist,
  stageCount: row.stage_count,
  connectionStatus: row.connected_at === null ? 'awaiting_first_event' : 'connected',
  eventCount: row.event_count,
  connectedAt: row.connected_at?.toISOString() ?? null,
  lastEventAt: row.last_event_received_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});

const mapProcessStage = (row: ProcessStageRow): ProcessStage => ({
  id: row.id,
  key: row.key,
  name: row.name,
  owningTeam: row.owning_team,
  position: row.position,
  required: row.required,
  source: row.source,
  timeoutSeconds: row.timeout_seconds,
});

const mapProcessCredential = (row: ProcessCredentialRow): ProcessCredentialSummary => ({
  id: row.id,
  processId: row.process_id,
  keyId: row.key_id,
  createdAt: row.created_at.toISOString(),
  revokedAt: row.revoked_at?.toISOString() ?? null,
  revocationReason: row.revocation_reason,
});

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

async function addWorkspaceAudit(
  client: pg.Pool | pg.PoolClient,
  principal: OperatorPrincipal,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `
      INSERT INTO workspace_audit_log (
        id,
        workspace_id,
        actor_member_id,
        actor_name,
        action,
        entity_type,
        entity_id,
        details
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    `,
    [
      `audit_${randomUUID()}`,
      principal.workspaceId,
      principal.memberId,
      principal.name,
      action,
      entityType,
      entityId,
      JSON.stringify(details),
    ],
  );
}

export async function listClients(
  pool: pg.Pool,
  principal: OperatorPrincipal,
): Promise<ClientSummary[]> {
  const values: unknown[] = [principal.workspaceId];
  const access =
    principal.clientIds === null
      ? ''
      : (() => {
          values.push(principal.clientIds);
          return `AND clients.id = ANY($${values.length}::text[])`;
        })();
  try {
    const result = await pool.query<ClientRow>(
      `
        SELECT
          clients.id,
          clients.name,
          clients.created_at,
          count(DISTINCT processes.id)::int AS process_count,
          count(DISTINCT incidents.id) FILTER (WHERE incidents.status <> 'resolved')::int
            AS open_incident_count
        FROM clients
        LEFT JOIN processes
          ON processes.workspace_id = clients.workspace_id
          AND processes.client_id = clients.id
        LEFT JOIN process_instances
          ON process_instances.workspace_id = processes.workspace_id
          AND process_instances.process_id = processes.id
        LEFT JOIN incidents
          ON incidents.workspace_id = process_instances.workspace_id
          AND incidents.process_instance_id = process_instances.id
        WHERE clients.workspace_id = $1 ${access}
        GROUP BY clients.id
        ORDER BY clients.name, clients.id
      `,
      values,
    );
    return result.rows.map(mapClient);
  } catch {
    throw databaseFailure();
  }
}

export async function createClient(
  pool: pg.Pool,
  principal: OperatorPrincipal,
  input: ClientCreate,
): Promise<ClientSummary> {
  const clientId = `client_${randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<ClientRow>(
      `
        INSERT INTO clients (id, workspace_id, name)
        VALUES ($1, $2, $3)
        RETURNING id, name, created_at, 0::int AS process_count, 0::int AS open_incident_count
      `,
      [clientId, principal.workspaceId, input.name],
    );
    await addWorkspaceAudit(client, principal, 'client_created', 'client', clientId, {
      name: input.name,
    });
    await client.query('COMMIT');
    return mapClient(result.rows[0]!);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isUniqueViolation(error))
      throw resourceConflict('A client with that identity already exists.');
    throw databaseFailure();
  } finally {
    client.release();
  }
}

export async function listMembers(pool: pg.Pool, workspaceId: string): Promise<MemberSummary[]> {
  try {
    const result = await pool.query<MemberRow>(
      `
        SELECT
          workspace_members.id,
          workspace_members.name,
          workspace_members.email,
          workspace_members.role,
          workspace_members.status,
          workspace_members.created_at,
          COALESCE(
            array_agg(member_client_access.client_id)
              FILTER (WHERE member_client_access.client_id IS NOT NULL),
            ARRAY[]::text[]
          ) AS client_ids
        FROM workspace_members
        LEFT JOIN member_client_access
          ON member_client_access.workspace_id = workspace_members.workspace_id
          AND member_client_access.member_id = workspace_members.id
        WHERE workspace_members.workspace_id = $1
        GROUP BY workspace_members.id
        ORDER BY workspace_members.created_at, workspace_members.id
      `,
      [workspaceId],
    );
    return result.rows.map(mapMember);
  } catch {
    throw databaseFailure();
  }
}

async function replaceMemberClientAccess(
  client: pg.PoolClient,
  workspaceId: string,
  memberId: string,
  clientIds: string[],
): Promise<void> {
  if (clientIds.length > 0) {
    const available = await client.query<{ id: string }>(
      `SELECT id FROM clients WHERE workspace_id = $1 AND id = ANY($2::text[])`,
      [workspaceId, clientIds],
    );
    if (available.rowCount !== new Set(clientIds).size) {
      throw resourceNotFound('CLIENT_NOT_FOUND', 'client');
    }
  }
  await client.query(
    `DELETE FROM member_client_access WHERE workspace_id = $1 AND member_id = $2`,
    [workspaceId, memberId],
  );
  for (const clientId of new Set(clientIds)) {
    await client.query(
      `
        INSERT INTO member_client_access (workspace_id, member_id, client_id)
        VALUES ($1, $2, $3)
      `,
      [workspaceId, memberId, clientId],
    );
  }
}

export async function inviteMember(
  pool: pg.Pool,
  principal: OperatorPrincipal,
  input: MemberInvite,
): Promise<MemberInviteResponse> {
  const memberId = `member_${randomUUID()}`;
  const accessKeyId = `member_key_${randomUUID()}`;
  const accessKey = `outtrace_member_${randomBytes(24).toString('base64url')}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<MemberRow>(
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
        VALUES ($1, $2, $3, lower($4), $5, 'invited', $6, $7)
        RETURNING
          id,
          name,
          email,
          role,
          status,
          created_at,
          ARRAY[]::text[] AS client_ids
      `,
      [
        memberId,
        principal.workspaceId,
        input.name,
        input.email,
        input.role,
        accessKeyId,
        sha256Hex(accessKey),
      ],
    );
    await replaceMemberClientAccess(
      client,
      principal.workspaceId,
      memberId,
      input.role === 'viewer' ? input.clientIds : [],
    );
    await addWorkspaceAudit(client, principal, 'member_invited', 'member', memberId, {
      email: input.email.toLowerCase(),
      role: input.role,
      clientIds: input.role === 'viewer' ? input.clientIds : [],
    });
    await client.query('COMMIT');
    return {
      member: {
        ...mapMember(inserted.rows[0]!),
        clientIds: input.role === 'viewer' ? [...new Set(input.clientIds)] : [],
      },
      accessKeyId,
      accessKey,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof HttpError) throw error;
    if (isUniqueViolation(error)) {
      throw resourceConflict('A member with that email already exists in the workspace.');
    }
    throw databaseFailure();
  } finally {
    client.release();
  }
}

export async function updateMember(
  pool: pg.Pool,
  principal: OperatorPrincipal,
  memberId: string,
  input: MemberUpdate,
): Promise<MemberSummary> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [
      principal.workspaceId,
    ]);
    const current = await client.query<MemberRow>(
      `
        SELECT
          id,
          name,
          email,
          role,
          status,
          created_at,
          ARRAY[]::text[] AS client_ids
        FROM workspace_members
        WHERE workspace_id = $1 AND id = $2
        FOR UPDATE
      `,
      [principal.workspaceId, memberId],
    );
    const member = current.rows[0];
    if (!member) throw resourceNotFound('MEMBER_NOT_FOUND', 'member');

    const nextRole = input.role ?? member.role;
    const nextStatus = input.status ?? member.status;
    const revokeCredential = member.status !== 'disabled' && nextStatus === 'disabled';
    const revokedAccessKeyId = `revoked_member_key_${randomUUID()}`;
    const revokedAccessKeyHash = sha256Hex(randomBytes(32).toString('base64url'));
    const removesActiveOwner =
      member.role === 'owner' &&
      member.status === 'active' &&
      (nextRole !== 'owner' || nextStatus === 'disabled');
    if (removesActiveOwner) {
      const owners = await client.query<{ count: number }>(
        `
          SELECT count(*)::int AS count
          FROM workspace_members
          WHERE workspace_id = $1 AND role = 'owner' AND status = 'active'
        `,
        [principal.workspaceId],
      );
      if ((owners.rows[0]?.count ?? 0) <= 1) {
        throw resourceConflict('The workspace must retain at least one active owner.');
      }
    }

    const updated = await client.query<MemberRow>(
      `
        UPDATE workspace_members
        SET
          role = $3,
          status = $4,
          access_key_id = CASE WHEN $5 THEN $6 ELSE access_key_id END,
          access_key_hash = CASE WHEN $5 THEN $7 ELSE access_key_hash END,
          updated_at = now()
        WHERE workspace_id = $1 AND id = $2
        RETURNING
          id,
          name,
          email,
          role,
          status,
          created_at,
          ARRAY[]::text[] AS client_ids
      `,
      [
        principal.workspaceId,
        memberId,
        nextRole,
        nextStatus,
        revokeCredential,
        revokedAccessKeyId,
        revokedAccessKeyHash,
      ],
    );
    const clientIds = nextRole === 'viewer' ? (input.clientIds ?? []) : [];
    if (input.clientIds !== undefined || nextRole !== member.role) {
      await replaceMemberClientAccess(client, principal.workspaceId, memberId, clientIds);
    }
    const effectiveClientIds =
      nextRole === 'viewer'
        ? (
            await client.query<{ client_id: string }>(
              `
                SELECT client_id
                FROM member_client_access
                WHERE workspace_id = $1 AND member_id = $2
                ORDER BY client_id
              `,
              [principal.workspaceId, memberId],
            )
          ).rows.map((row) => row.client_id)
        : [];
    await addWorkspaceAudit(client, principal, 'member_updated', 'member', memberId, {
      role: nextRole,
      status: nextStatus,
      clientIds: effectiveClientIds,
      credentialRevoked: revokeCredential,
    });
    await client.query('COMMIT');
    return { ...mapMember(updated.rows[0]!), clientIds: effectiveClientIds };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw databaseFailure();
  } finally {
    client.release();
  }
}

export async function rotateMemberCredential(
  pool: pg.Pool,
  principal: OperatorPrincipal,
  memberId: string,
): Promise<MemberCredentialResponse> {
  const accessKeyId = `member_key_${randomUUID()}`;
  const accessKey = `outtrace_member_${randomBytes(24).toString('base64url')}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [
      principal.workspaceId,
    ]);
    const updated = await client.query<{ updated_at: Date }>(
      `
        UPDATE workspace_members
        SET
          access_key_id = $3,
          access_key_hash = $4,
          updated_at = now()
        WHERE workspace_id = $1 AND id = $2
        RETURNING updated_at
      `,
      [principal.workspaceId, memberId, accessKeyId, sha256Hex(accessKey)],
    );
    if (!updated.rows[0]) {
      throw resourceNotFound('MEMBER_NOT_FOUND', 'member');
    }
    await addWorkspaceAudit(client, principal, 'member_credential_rotated', 'member', memberId, {
      accessKeyId,
    });
    await client.query('COMMIT');
    return {
      memberId,
      accessKeyId,
      accessKey,
      rotatedAt: updated.rows[0].updated_at.toISOString(),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw databaseFailure();
  } finally {
    client.release();
  }
}

function generateProcessCredential(): { key: string; keyId: string } {
  return {
    key: `outtrace_process_${randomBytes(24).toString('base64url')}`,
    keyId: `process_key_${randomUUID()}`,
  };
}

async function insertProcessCredential(
  client: pg.PoolClient,
  principal: OperatorPrincipal,
  processId: string,
): Promise<ProcessCredentialResponse> {
  const credential = generateProcessCredential();
  const inserted = await client.query<{ created_at: Date }>(
    `
      INSERT INTO process_ingestion_credentials (
        id,
        workspace_id,
        process_id,
        key_id,
        key_hash,
        created_by_member_id
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING created_at
    `,
    [
      `credential_${randomUUID()}`,
      principal.workspaceId,
      processId,
      credential.keyId,
      sha256Hex(credential.key),
      principal.memberId,
    ],
  );
  await addWorkspaceAudit(
    client,
    principal,
    'process_ingestion_credential_created',
    'process',
    processId,
    { keyId: credential.keyId },
  );
  return {
    processId,
    keyId: credential.keyId,
    key: credential.key,
    createdAt: inserted.rows[0]!.created_at.toISOString(),
  };
}

export async function createProcess(
  pool: pg.Pool,
  principal: OperatorPrincipal,
  input: ProcessCreate,
): Promise<ProcessCreateResponse> {
  const client = await pool.connect();
  const processId = `process_${randomUUID()}`;
  try {
    await client.query('BEGIN');
    const clientResult = await client.query<{ name: string }>(
      `SELECT name FROM clients WHERE workspace_id = $1 AND id = $2`,
      [principal.workspaceId, input.clientId],
    );
    const clientName = clientResult.rows[0]?.name;
    if (!clientName) throw resourceNotFound('CLIENT_NOT_FOUND', 'client');

    const insertedProcess = await client.query<ProcessRow>(
      `
        INSERT INTO processes (
          id,
          workspace_id,
          client_id,
          key,
          name,
          environment,
          sla_seconds,
          metadata_allowlist
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])
        RETURNING
          id,
          key,
          name,
          client_id,
          $9::text AS client_name,
          environment,
          lifecycle_status,
          sla_seconds,
          metadata_allowlist,
          connected_at,
          last_event_received_at,
          created_at,
          $10::int AS stage_count,
          0::int AS event_count
      `,
      [
        processId,
        principal.workspaceId,
        input.clientId,
        input.key,
        input.name,
        input.environment,
        input.slaSeconds,
        input.metadataAllowlist,
        clientName,
        input.stages.length,
      ],
    );

    const stages: ProcessStage[] = [];
    for (const [position, stage] of input.stages.entries()) {
      const insertedStage = await client.query<ProcessStageRow>(
        `
          INSERT INTO process_stages (
            id,
            workspace_id,
            process_id,
            key,
            name,
            position,
            required,
            timeout_seconds,
            source,
            owning_team
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING
            id,
            key,
            name,
            position,
            required,
            timeout_seconds,
            source,
            owning_team
        `,
        [
          `stage_${randomUUID()}`,
          principal.workspaceId,
          processId,
          stage.key,
          stage.name,
          position,
          stage.required,
          stage.timeoutSeconds,
          stage.source,
          stage.owningTeam,
        ],
      );
      stages.push(mapProcessStage(insertedStage.rows[0]!));
    }

    const credential = await insertProcessCredential(client, principal, processId);
    await addWorkspaceAudit(client, principal, 'process_created', 'process', processId, {
      clientId: input.clientId,
      environment: input.environment,
      key: input.key,
      stageCount: input.stages.length,
    });
    await client.query('COMMIT');
    return {
      process: mapProcess(insertedProcess.rows[0]!),
      stages,
      credential: {
        keyId: credential.keyId,
        key: credential.key,
        createdAt: credential.createdAt,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof HttpError) throw error;
    if (isUniqueViolation(error)) {
      throw resourceConflict('A process with that key already exists in the workspace.');
    }
    throw databaseFailure();
  } finally {
    client.release();
  }
}

export async function createProcessCredential(
  pool: pg.Pool,
  principal: OperatorPrincipal,
  processId: string,
  input: ProcessCredentialIssue = { revokeExisting: false },
): Promise<ProcessCredentialResponse> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const process = await client.query<{ id: string }>(
      `SELECT id FROM processes WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [principal.workspaceId, processId],
    );
    if (!process.rows[0]) throw resourceNotFound('PROCESS_NOT_FOUND', 'process');
    if (input.revokeExisting) {
      const revoked = await client.query<{ key_id: string }>(
        `
          UPDATE process_ingestion_credentials
          SET
            revoked_at = now(),
            revoked_by_member_id = $3,
            revocation_reason = 'Rotated by replacement credential'
          WHERE workspace_id = $1 AND process_id = $2 AND revoked_at IS NULL
          RETURNING key_id
        `,
        [principal.workspaceId, processId, principal.memberId],
      );
      for (const row of revoked.rows) {
        await addWorkspaceAudit(
          client,
          principal,
          'process_ingestion_credential_revoked',
          'process',
          processId,
          { keyId: row.key_id, reason: 'Rotated by replacement credential' },
        );
      }
    }
    const credential = await insertProcessCredential(client, principal, processId);
    await client.query('COMMIT');
    return credential;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw databaseFailure();
  } finally {
    client.release();
  }
}

export async function listProcessCredentials(
  pool: pg.Pool,
  principal: OperatorPrincipal,
  processId: string,
): Promise<ProcessCredentialSummary[]> {
  try {
    const process = await pool.query<{ id: string }>(
      `SELECT id FROM processes WHERE workspace_id = $1 AND id = $2`,
      [principal.workspaceId, processId],
    );
    if (!process.rows[0]) throw resourceNotFound('PROCESS_NOT_FOUND', 'process');
    const result = await pool.query<ProcessCredentialRow>(
      `
        SELECT
          id,
          process_id,
          key_id,
          created_at,
          revoked_at,
          revocation_reason
        FROM process_ingestion_credentials
        WHERE workspace_id = $1 AND process_id = $2
        ORDER BY created_at DESC, id
      `,
      [principal.workspaceId, processId],
    );
    return result.rows.map(mapProcessCredential);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw databaseFailure();
  }
}

export async function revokeProcessCredential(
  pool: pg.Pool,
  principal: OperatorPrincipal,
  processId: string,
  credentialId: string,
  input: ProcessCredentialRevoke,
): Promise<ProcessCredentialSummary> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const process = await client.query<{ id: string }>(
      `SELECT id FROM processes WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [principal.workspaceId, processId],
    );
    if (!process.rows[0]) throw resourceNotFound('PROCESS_NOT_FOUND', 'process');
    const result = await client.query<ProcessCredentialRow>(
      `
        UPDATE process_ingestion_credentials
        SET
          revoked_at = COALESCE(revoked_at, now()),
          revoked_by_member_id = COALESCE(revoked_by_member_id, $4),
          revocation_reason = COALESCE(revocation_reason, $5)
        WHERE workspace_id = $1 AND process_id = $2 AND id = $3
        RETURNING
          id,
          process_id,
          key_id,
          created_at,
          revoked_at,
          revocation_reason
      `,
      [
        principal.workspaceId,
        processId,
        credentialId,
        principal.memberId,
        input.reason ?? 'Revoked by workspace owner',
      ],
    );
    const credential = result.rows[0];
    if (!credential) throw resourceNotFound('CREDENTIAL_NOT_FOUND', 'credential');
    await addWorkspaceAudit(
      client,
      principal,
      'process_ingestion_credential_revoked',
      'process',
      processId,
      {
        credentialId,
        keyId: credential.key_id,
        reason: credential.revocation_reason,
      },
    );
    await client.query('COMMIT');
    return mapProcessCredential(credential);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw databaseFailure();
  } finally {
    client.release();
  }
}

export async function listProcesses(
  pool: pg.Pool,
  principal: OperatorPrincipal,
): Promise<ProcessSummary[]> {
  const values: unknown[] = [principal.workspaceId];
  const access =
    principal.clientIds === null
      ? ''
      : (() => {
          values.push(principal.clientIds);
          return `AND processes.client_id = ANY($${values.length}::text[])`;
        })();
  try {
    const result = await pool.query<ProcessRow>(
      `
        SELECT
          processes.id,
          processes.key,
          processes.name,
          processes.client_id,
          clients.name AS client_name,
          processes.environment,
          processes.lifecycle_status,
          processes.sla_seconds,
          processes.metadata_allowlist,
          processes.connected_at,
          processes.last_event_received_at,
          processes.created_at,
          (
            SELECT count(*)::int
            FROM process_stages
            WHERE
              process_stages.workspace_id = processes.workspace_id
              AND process_stages.process_id = processes.id
          ) AS stage_count,
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
        WHERE processes.workspace_id = $1 ${access}
        ORDER BY clients.name, processes.name
      `,
      values,
    );
    return result.rows.map(mapProcess);
  } catch {
    throw databaseFailure();
  }
}

export async function updateProcess(
  pool: pg.Pool,
  principal: OperatorPrincipal,
  processId: string,
  input: ProcessUpdate,
): Promise<ProcessSummary> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<ProcessRow>(
      `
        SELECT
          processes.id,
          processes.key,
          processes.name,
          processes.client_id,
          clients.name AS client_name,
          processes.environment,
          processes.lifecycle_status,
          processes.sla_seconds,
          processes.metadata_allowlist,
          processes.connected_at,
          processes.last_event_received_at,
          processes.created_at,
          (
            SELECT count(*)::int
            FROM process_stages
            WHERE
              process_stages.workspace_id = processes.workspace_id
              AND process_stages.process_id = processes.id
          ) AS stage_count,
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
        WHERE processes.workspace_id = $1 AND processes.id = $2
        FOR UPDATE OF processes
      `,
      [principal.workspaceId, processId],
    );
    const process = current.rows[0];
    if (!process) throw resourceNotFound('PROCESS_NOT_FOUND', 'process');
    const clientId = input.clientId ?? process.client_id;
    const clientResult = await client.query<{ name: string }>(
      `SELECT name FROM clients WHERE workspace_id = $1 AND id = $2`,
      [principal.workspaceId, clientId],
    );
    if (!clientResult.rows[0]) throw resourceNotFound('CLIENT_NOT_FOUND', 'client');
    const allowlist = input.metadataAllowlist ?? process.metadata_allowlist;
    const lifecycleStatus = input.lifecycleStatus ?? process.lifecycle_status;
    const updated = await client.query<ProcessRow>(
      `
        UPDATE processes
        SET
          client_id = $3,
          metadata_allowlist = $4::text[],
          lifecycle_status = $5,
          updated_at = now()
        WHERE workspace_id = $1 AND id = $2
        RETURNING
          id,
          key,
          name,
          client_id,
          $6::text AS client_name,
          environment,
          lifecycle_status,
          sla_seconds,
          metadata_allowlist,
          connected_at,
          last_event_received_at,
          created_at,
          (
            SELECT count(*)::int
            FROM process_stages
            WHERE
              process_stages.workspace_id = $1
              AND process_stages.process_id = $2
          ) AS stage_count,
          (
            SELECT count(*)::int
            FROM events
            JOIN process_instances
              ON process_instances.workspace_id = events.workspace_id
              AND process_instances.id = events.process_instance_id
            WHERE
              events.workspace_id = $1
              AND process_instances.process_id = $2
          ) AS event_count
      `,
      [
        principal.workspaceId,
        processId,
        clientId,
        allowlist,
        lifecycleStatus,
        clientResult.rows[0].name,
      ],
    );
    await addWorkspaceAudit(client, principal, 'process_updated', 'process', processId, {
      clientId,
      lifecycleStatus,
      metadataAllowlist: allowlist,
    });
    await client.query('COMMIT');
    return mapProcess(updated.rows[0]!);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw databaseFailure();
  } finally {
    client.release();
  }
}

export async function getWorkspaceSettings(
  pool: pg.Pool,
  workspaceId: string,
): Promise<WorkspaceSettings> {
  try {
    const result = await pool.query<{ event_retention_days: number }>(
      `SELECT event_retention_days FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    return { eventRetentionDays: result.rows[0]?.event_retention_days ?? 30 };
  } catch {
    throw databaseFailure();
  }
}

export async function updateWorkspaceSettings(
  pool: pg.Pool,
  principal: OperatorPrincipal,
  settings: WorkspaceSettings,
): Promise<WorkspaceSettings> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE workspaces SET event_retention_days = $2, updated_at = now() WHERE id = $1`,
      [principal.workspaceId, settings.eventRetentionDays],
    );
    await addWorkspaceAudit(
      client,
      principal,
      'retention_updated',
      'workspace',
      principal.workspaceId,
      settings,
    );
    await client.query('COMMIT');
    return settings;
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    throw databaseFailure();
  } finally {
    client.release();
  }
}

export async function getClientReliabilityReport(
  pool: pg.Pool,
  workspaceId: string,
  clientId: string,
): Promise<ClientReliabilityReport> {
  try {
    const client = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, clientId],
    );
    if (!client.rows[0]) throw resourceNotFound('CLIENT_NOT_FOUND', 'client');
    const [instances, incidents, unreliable] = await Promise.all([
      pool.query<{
        total: number;
        completed: number;
      }>(
        `
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE process_instances.status = 'completed')::int AS completed
          FROM process_instances
          JOIN processes
            ON processes.workspace_id = process_instances.workspace_id
            AND processes.id = process_instances.process_id
          WHERE processes.workspace_id = $1 AND processes.client_id = $2
        `,
        [workspaceId, clientId],
      ),
      pool.query<{
        detected: number;
        resolved: number;
        median_resolution_seconds: number | null;
      }>(
        `
          SELECT
            count(*)::int AS detected,
            count(*) FILTER (WHERE incidents.status = 'resolved')::int AS resolved,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY extract(epoch FROM (incidents.resolved_at - incidents.created_at))
            ) FILTER (WHERE incidents.resolved_at IS NOT NULL) AS median_resolution_seconds
          FROM incidents
          JOIN process_instances
            ON process_instances.workspace_id = incidents.workspace_id
            AND process_instances.id = incidents.process_instance_id
          JOIN processes
            ON processes.workspace_id = process_instances.workspace_id
            AND processes.id = process_instances.process_id
          WHERE incidents.workspace_id = $1 AND processes.client_id = $2
        `,
        [workspaceId, clientId],
      ),
      pool.query<{ stage: string; incident_count: number }>(
        `
          SELECT incidents.affected_stage AS stage, count(*)::int AS incident_count
          FROM incidents
          JOIN process_instances
            ON process_instances.workspace_id = incidents.workspace_id
            AND process_instances.id = incidents.process_instance_id
          JOIN processes
            ON processes.workspace_id = process_instances.workspace_id
            AND processes.id = process_instances.process_id
          WHERE
            incidents.workspace_id = $1
            AND processes.client_id = $2
            AND incidents.affected_stage IS NOT NULL
          GROUP BY incidents.affected_stage
          ORDER BY incident_count DESC, incidents.affected_stage
          LIMIT 1
        `,
        [workspaceId, clientId],
      ),
    ]);
    const instanceMetrics = instances.rows[0] ?? { total: 0, completed: 0 };
    const incidentMetrics = incidents.rows[0] ?? {
      detected: 0,
      resolved: 0,
      median_resolution_seconds: null,
    };
    const stage = unreliable.rows[0];
    return {
      client: client.rows[0],
      totalInstances: instanceMetrics.total,
      completedInstances: instanceMetrics.completed,
      completionRate:
        instanceMetrics.total === 0 ? 0 : instanceMetrics.completed / instanceMetrics.total,
      incidentsDetected: incidentMetrics.detected,
      incidentsResolved: incidentMetrics.resolved,
      medianResolutionSeconds:
        incidentMetrics.median_resolution_seconds === null
          ? null
          : Number(incidentMetrics.median_resolution_seconds),
      mostUnreliableStage: stage
        ? { stage: stage.stage, incidentCount: stage.incident_count }
        : null,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw databaseFailure();
  }
}
