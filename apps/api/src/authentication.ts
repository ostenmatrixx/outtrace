import type { FastifyRequest } from 'fastify';
import type pg from 'pg';

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

export interface IngestionCredentials {
  key: string;
  keyId: string;
}

export interface OperatorCredentials {
  key: string;
  keyId: string;
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
  try {
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

    return workspace!.id;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw databaseFailure();
  }
}
