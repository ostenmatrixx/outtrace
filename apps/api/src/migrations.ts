import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

import type { DevelopmentSeedConfig } from './config.js';
import { sha256Hex } from './crypto.js';

const defaultMigrationsDirectory = fileURLToPath(
  new URL('../../../database/migrations/', import.meta.url),
);

interface AppliedMigration {
  checksum: string;
  filename: string;
}

function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function seedDevelopmentData(
  client: pg.PoolClient,
  seed: DevelopmentSeedConfig,
): Promise<void> {
  await client.query(
    `
      INSERT INTO workspaces (
        id,
        name,
        ingestion_key_id,
        ingestion_key_hash,
        operator_key_id,
        operator_key_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE
      SET
        name = EXCLUDED.name,
        ingestion_key_id = EXCLUDED.ingestion_key_id,
        ingestion_key_hash = EXCLUDED.ingestion_key_hash,
        operator_key_id = EXCLUDED.operator_key_id,
        operator_key_hash = EXCLUDED.operator_key_hash,
        updated_at = now()
    `,
    [
      seed.workspaceId,
      'Outtrace development workspace',
      seed.ingestionKeyId,
      sha256Hex(seed.ingestionKey),
      seed.operatorKeyId,
      sha256Hex(seed.operatorKey),
    ],
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
      VALUES ($1, $2, 'Development owner', 'owner@local.outtrace.invalid', 'owner', 'active', $3, $4)
      ON CONFLICT (access_key_id) DO UPDATE
      SET
        name = EXCLUDED.name,
        role = 'owner',
        status = 'active',
        access_key_hash = EXCLUDED.access_key_hash,
        updated_at = now()
      WHERE workspace_members.workspace_id = EXCLUDED.workspace_id
    `,
    [
      `member_${seed.workspaceId}_owner`,
      seed.workspaceId,
      seed.operatorKeyId,
      sha256Hex(seed.operatorKey),
    ],
  );

  await client.query(
    `
      INSERT INTO clients (id, workspace_id, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name, updated_at = now()
      WHERE clients.workspace_id = EXCLUDED.workspace_id
    `,
    [seed.clientId, seed.workspaceId, 'Development client'],
  );

  await client.query(
    `
      INSERT INTO processes (id, workspace_id, client_id, key, name, sla_seconds)
      VALUES ($1, $2, $3, $4, $5, 1800)
      ON CONFLICT (id) DO UPDATE
      SET
        key = EXCLUDED.key,
        name = EXCLUDED.name,
        sla_seconds = EXCLUDED.sla_seconds,
        updated_at = now()
      WHERE
        processes.workspace_id = EXCLUDED.workspace_id
        AND processes.client_id = EXCLUDED.client_id
    `,
    [
      seed.processId,
      seed.workspaceId,
      seed.clientId,
      seed.processKey,
      'Development onboarding process',
    ],
  );

  const stages = [
    ['payment_received', 'Payment received', 0, 300, 'make'],
    ['account_created', 'Account created', 1, 600, 'custom'],
    ['workspace_created', 'Workspace created', 2, 600, 'n8n'],
    ['welcome_email_sent', 'Welcome email sent', 3, 300, 'custom'],
  ] as const;

  for (const [key, name, position, timeoutSeconds, source] of stages) {
    await client.query(
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
          source
        )
        VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
        ON CONFLICT (process_id, key) DO UPDATE
        SET
          name = EXCLUDED.name,
          position = EXCLUDED.position,
          required = EXCLUDED.required,
          timeout_seconds = EXCLUDED.timeout_seconds,
          source = EXCLUDED.source,
          updated_at = now()
      `,
      [
        `${seed.processId}_${key}`,
        seed.workspaceId,
        seed.processId,
        key,
        name,
        position,
        timeoutSeconds,
        source,
      ],
    );
  }
}

export interface MigrationOptions {
  directory?: string;
  seed?: DevelopmentSeedConfig;
}

export async function runMigrations(
  pool: pg.Pool,
  options: MigrationOptions = {},
): Promise<string[]> {
  const directory = options.directory ?? defaultMigrationsDirectory;
  const filenames = (await readdir(directory))
    .filter((filename) => /^\d+.*\.sql$/.test(filename))
    .sort((left, right) => left.localeCompare(right));
  const client = await pool.connect();
  const appliedNow: string[] = [];

  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('outtrace:migrations'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query<AppliedMigration>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.filename, row.checksum]));

    for (const filename of filenames) {
      const migration = await readFile(join(directory, filename), 'utf8');
      const migrationChecksum = checksum(migration);
      const previousChecksum = applied.get(filename);

      if (previousChecksum !== undefined) {
        if (previousChecksum !== migrationChecksum) {
          throw new Error(`Migration ${filename} has changed since it was applied.`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          migrationChecksum,
        ]);
        await client.query('COMMIT');
        appliedNow.push(filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    if (options.seed) {
      await client.query('BEGIN');
      try {
        await seedDevelopmentData(client, options.seed);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext('outtrace:migrations'))`);
    } finally {
      client.release();
    }
  }

  return appliedNow;
}
