import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { WorkspaceRole } from '@outtrace/contracts';

import { verifySha256Secret } from './crypto.js';
import {
  authenticationInvalid,
  authenticationRequired,
  databaseFailure,
  HttpError,
  operatorAuthenticationInvalid,
  operatorAuthenticationRequired,
} from './errors.js';

interface WorkspaceRow extends pg.QueryResultRow {
  id: string;
  ingestion_key_hash: string;
  operator_key_hash?: string;
}

interface MemberRow extends pg.QueryResultRow {
  id: string;
  workspace_id: string;
  name: string;
  role: WorkspaceRole;
  status: 'invited' | 'active';
  access_key_hash: string;
  client_ids: string[];
}

export interface IngestionCredentials {
  key: string;
  keyId: string;
}

export interface OperatorCredentials {
  key: string;
  keyId: string;
}

export interface OperatorPrincipal {
  workspaceId: string;
  memberId: string | null;
  name: string;
  role: WorkspaceRole;
  clientIds: string[] | null;
}

export function readIngestionCredentials(request: FastifyRequest): IngestionCredentials {
  const keyId = request.headers['x-outtrace-key-id'];
  const key = request.headers['x-outtrace-key'];

  if (keyId === undefined || key === undefined) {
    throw authenticationRequired();
  }

  if (
    typeof keyId !== 'string' ||
    typeof key !== 'string' ||
    keyId.trim().length === 0 ||
    key.length === 0 ||
    keyId.length > 255 ||
    key.length > 4_096
  ) {
    throw authenticationInvalid();
  }

  return { key, keyId: keyId.trim() };
}

export async function authenticateIngestion(
  pool: pg.Pool,
  credentials: IngestionCredentials,
): Promise<string> {
  try {
    const result = await pool.query<WorkspaceRow>(
      `
        SELECT id, ingestion_key_hash
        FROM workspaces
        WHERE ingestion_key_id = $1
        LIMIT 1
      `,
      [credentials.keyId],
    );
    const workspace = result.rows[0];

    if (!verifySha256Secret(credentials.key, workspace?.ingestion_key_hash)) {
      throw authenticationInvalid();
    }

    return workspace!.id;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw databaseFailure();
  }
}

export function readOperatorCredentials(request: FastifyRequest): OperatorCredentials {
  const keyId = request.headers['x-outtrace-operator-key-id'];
  const key = request.headers['x-outtrace-operator-key'];

  if (keyId === undefined || key === undefined) {
    throw operatorAuthenticationRequired();
  }

  if (
    typeof keyId !== 'string' ||
    typeof key !== 'string' ||
    keyId.trim().length === 0 ||
    key.length === 0 ||
    keyId.length > 255 ||
    key.length > 4_096
  ) {
    throw operatorAuthenticationInvalid();
  }

  return { key, keyId: keyId.trim() };
}

export async function authenticateOperator(
  pool: pg.Pool,
  credentials: OperatorCredentials,
): Promise<string> {
  return (await authenticateOperatorPrincipal(pool, credentials)).workspaceId;
}

export async function authenticateOperatorPrincipal(
  pool: pg.Pool,
  credentials: OperatorCredentials,
): Promise<OperatorPrincipal> {
  try {
    const memberResult = await pool.query<MemberRow>(
      `
        SELECT
          workspace_members.id,
          workspace_members.workspace_id,
          workspace_members.name,
          workspace_members.role,
          workspace_members.status,
          workspace_members.access_key_hash,
          COALESCE(
            array_agg(member_client_access.client_id)
              FILTER (WHERE member_client_access.client_id IS NOT NULL),
            ARRAY[]::text[]
          ) AS client_ids
        FROM workspace_members
        LEFT JOIN member_client_access
          ON member_client_access.workspace_id = workspace_members.workspace_id
          AND member_client_access.member_id = workspace_members.id
        WHERE
          workspace_members.access_key_id = $1
          AND workspace_members.status IN ('invited', 'active')
        GROUP BY workspace_members.id
        LIMIT 1
      `,
      [credentials.keyId],
    );
    const member = memberResult.rows[0];
    if (member && verifySha256Secret(credentials.key, member.access_key_hash)) {
      if (member.status === 'invited') {
        await pool.query(
          `
            UPDATE workspace_members
            SET status = 'active', updated_at = now()
            WHERE workspace_id = $1 AND id = $2 AND status = 'invited'
          `,
          [member.workspace_id, member.id],
        );
      }
      return {
        workspaceId: member.workspace_id,
        memberId: member.id,
        name: member.name,
        role: member.role,
        clientIds: member.role === 'viewer' ? member.client_ids : null,
      };
    }

    const result = await pool.query<WorkspaceRow>(
      `
        SELECT id, operator_key_hash
        FROM workspaces
        WHERE operator_key_id = $1
        LIMIT 1
      `,
      [credentials.keyId],
    );
    const workspace = result.rows[0];

    if (!verifySha256Secret(credentials.key, workspace?.operator_key_hash)) {
      throw operatorAuthenticationInvalid();
    }

    return {
      workspaceId: workspace!.id,
      memberId: null,
      name: 'Workspace owner',
      role: 'owner',
      clientIds: null,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw databaseFailure();
  }
}
