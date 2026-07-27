import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import type pg from 'pg';
import { z } from 'zod';

import { loadConfig } from './config.js';
import { sha256Hex } from './crypto.js';
import { createPool } from './database.js';

const bootstrapWorkspaceInputSchema = z.object({
  workspaceId: z
    .string()
    .min(3)
    .max(200)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      'Workspace ID may contain letters, numbers, underscores, and dashes.',
    ),
  workspaceName: z.string().trim().min(1).max(200),
  ownerName: z.string().trim().min(1).max(200),
  ownerEmail: z
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
});

export type BootstrapWorkspaceInput = z.input<typeof bootstrapWorkspaceInputSchema>;

export interface BootstrapWorkspaceResult {
  workspaceId: string;
  memberId: string;
  accessKeyId: string;
  accessKey: string;
  createdAt: string;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

export async function bootstrapWorkspace(
  pool: pg.Pool,
  input: BootstrapWorkspaceInput,
): Promise<BootstrapWorkspaceResult> {
  const value = bootstrapWorkspaceInputSchema.parse(input);
  const memberId = `member_${randomUUID()}`;
  const accessKeyId = `member_key_${randomUUID()}`;
  const accessKey = `outtrace_member_${randomBytes(24).toString('base64url')}`;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const workspace = await client.query<{ created_at: Date }>(
      `
        INSERT INTO workspaces (id, name)
        VALUES ($1, $2)
        RETURNING created_at
      `,
      [value.workspaceId, value.workspaceName],
    );
    await client.query(
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
        VALUES ($1, $2, $3, $4, 'owner', 'active', $5, $6)
      `,
      [
        memberId,
        value.workspaceId,
        value.ownerName,
        value.ownerEmail,
        accessKeyId,
        sha256Hex(accessKey),
      ],
    );
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
        VALUES ($1, $2, $3, $4, 'workspace_bootstrapped', 'workspace', $2, $5::jsonb)
      `,
      [
        `audit_${randomUUID()}`,
        value.workspaceId,
        memberId,
        value.ownerName,
        JSON.stringify({ ownerEmail: value.ownerEmail }),
      ],
    );
    await client.query('COMMIT');
    return {
      workspaceId: value.workspaceId,
      memberId,
      accessKeyId,
      accessKey,
      createdAt: workspace.rows[0]!.created_at.toISOString(),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isUniqueViolation(error)) {
      throw new Error('The workspace bootstrap target already exists.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function runWorkspaceBootstrap(environment: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(environment);
  const pool = createPool(config);
  try {
    const result = await bootstrapWorkspace(pool, {
      workspaceId: environment.OUTTRACE_BOOTSTRAP_WORKSPACE_ID ?? '',
      workspaceName: environment.OUTTRACE_BOOTSTRAP_WORKSPACE_NAME ?? '',
      ownerName: environment.OUTTRACE_BOOTSTRAP_OWNER_NAME ?? '',
      ownerEmail: environment.OUTTRACE_BOOTSTRAP_OWNER_EMAIL ?? '',
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runWorkspaceBootstrap().catch(() => {
    process.stderr.write(
      'Workspace bootstrap failed. Check the bootstrap fields, database connectivity, and whether the workspace ID already exists.\n',
    );
    process.exitCode = 1;
  });
}
