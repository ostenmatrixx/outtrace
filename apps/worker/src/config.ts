import { readFileSync } from 'node:fs';

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  concurrency: number;
  lockDurationMs: number;
  shutdownTimeoutMs: number;
  redisConnectTimeoutMs: number;
  phase2PollIntervalMs: number;
  phase2SweepIntervalMs: number;
  retentionSweepIntervalMs: number;
  retentionBatchSize: number;
  retentionMaxBatchesPerSweep: number;
  idempotencyRetentionDays: number;
  outboxRetentionDays: number;
  slackWebhookUrls: Readonly<Record<string, string>>;
  slackMinimumSeverity: 'critical' | 'high' | 'medium' | 'low';
  dashboardBaseUrl: string;
  healthHost: string;
  healthPort: number;
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_LOCK_DURATION_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PHASE_2_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PHASE_2_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 3_600_000;
const DEFAULT_RETENTION_BATCH_SIZE = 1_000;
const DEFAULT_RETENTION_MAX_BATCHES = 10;
const DEFAULT_IDEMPOTENCY_RETENTION_DAYS = 365;
const DEFAULT_OUTBOX_RETENTION_DAYS = 90;

export class WorkerConfigError extends Error {
  override readonly name = 'WorkerConfigError';
}

function requiredRedisUrl(value: string | undefined): string {
  if (!value?.trim()) {
    throw new WorkerConfigError('REDIS_URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WorkerConfigError('REDIS_URL must be a valid redis:// or rediss:// URL');
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new WorkerConfigError('REDIS_URL must use the redis:// or rediss:// protocol');
  }

  if (!parsed.hostname) {
    throw new WorkerConfigError('REDIS_URL must include a hostname');
  }

  return value.trim();
}

function requiredDatabaseUrl(value: string | undefined): string {
  if (!value?.trim()) {
    throw new WorkerConfigError('DATABASE_URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WorkerConfigError('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new WorkerConfigError('DATABASE_URL must use postgres:// or postgresql://');
  }
  return value.trim();
}

function secretValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  required = true,
): string | undefined {
  const direct = environment[name]?.trim();
  const file = environment[`${name}_FILE`]?.trim();
  if (direct && file) {
    throw new WorkerConfigError(`${name} and ${name}_FILE cannot both be set`);
  }
  if (file) {
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      throw new WorkerConfigError(`${name}_FILE could not be read`);
    }
  }
  if (direct) return direct;
  if (required) throw new WorkerConfigError(`${name} or ${name}_FILE is required`);
  return undefined;
}

function parseSlackWebhookUrls(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const raw = secretValue(environment, 'SLACK_WEBHOOK_URLS_JSON', false);
  const legacyWebhook = environment.SLACK_WEBHOOK_URL?.trim();
  const legacyWorkspaceId = environment.SLACK_SINGLE_WORKSPACE_ID?.trim();
  if (raw && legacyWebhook) {
    throw new WorkerConfigError(
      'SLACK_WEBHOOK_URLS_JSON and SLACK_WEBHOOK_URL cannot both be configured',
    );
  }
  if (legacyWebhook && environment.NODE_ENV === 'production') {
    throw new WorkerConfigError('The legacy SLACK_WEBHOOK_URL is disabled in production');
  }

  let input: unknown = {};
  if (raw) {
    try {
      input = JSON.parse(raw);
    } catch {
      throw new WorkerConfigError('SLACK_WEBHOOK_URLS_JSON must contain a JSON object');
    }
  } else if (legacyWebhook) {
    if (!legacyWorkspaceId) {
      throw new WorkerConfigError(
        'SLACK_SINGLE_WORKSPACE_ID is required with the legacy SLACK_WEBHOOK_URL setting',
      );
    }
    input = { [legacyWorkspaceId]: legacyWebhook };
  }

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkerConfigError('SLACK_WEBHOOK_URLS_JSON must contain a JSON object');
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 1_000) {
    throw new WorkerConfigError('SLACK_WEBHOOK_URLS_JSON cannot contain more than 1000 workspaces');
  }
  const result: Record<string, string> = {};
  for (const [workspaceId, value] of entries) {
    if (!workspaceId.trim() || typeof value !== 'string') {
      throw new WorkerConfigError('Slack webhook mappings require workspace IDs and HTTPS URLs');
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new WorkerConfigError('Slack webhook mappings require valid HTTPS URLs');
    }
    if (parsed.protocol !== 'https:') {
      throw new WorkerConfigError('Slack webhook mappings require HTTPS URLs');
    }
    result[workspaceId] = value;
  }
  return Object.freeze(result);
}

function integerInRange(
  name: string,
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    throw new WorkerConfigError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WorkerConfigError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return parsed;
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const slackMinimumSeverity = environment.SLACK_MINIMUM_SEVERITY ?? 'high';
  if (!['critical', 'high', 'medium', 'low'].includes(slackMinimumSeverity)) {
    throw new WorkerConfigError('SLACK_MINIMUM_SEVERITY must be critical, high, medium, or low');
  }
  const dashboardBaseUrl = (environment.DASHBOARD_BASE_URL ?? 'http://localhost:5173').replace(
    /\/+$/,
    '',
  );
  try {
    const parsed = new URL(dashboardBaseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new WorkerConfigError('DASHBOARD_BASE_URL must be a valid HTTP or HTTPS URL');
  }

  const databaseUrl = requiredDatabaseUrl(secretValue(environment, 'DATABASE_URL'));
  const redisUrl = requiredRedisUrl(secretValue(environment, 'REDIS_URL'));
  if (environment.NODE_ENV === 'production') {
    const sslMode = new URL(databaseUrl).searchParams.get('sslmode');
    if (sslMode !== 'verify-full') {
      throw new WorkerConfigError('DATABASE_URL must use sslmode=verify-full in production');
    }
    if (new URL(redisUrl).protocol !== 'rediss:') {
      throw new WorkerConfigError('REDIS_URL must use rediss:// in production');
    }
    if (new URL(dashboardBaseUrl).protocol !== 'https:') {
      throw new WorkerConfigError('DASHBOARD_BASE_URL must use HTTPS in production');
    }
  }

  return {
    databaseUrl,
    redisUrl,
    concurrency: integerInRange(
      'WORKER_CONCURRENCY',
      environment.WORKER_CONCURRENCY,
      DEFAULT_CONCURRENCY,
      1,
      100,
    ),
    lockDurationMs: integerInRange(
      'WORKER_LOCK_DURATION_MS',
      environment.WORKER_LOCK_DURATION_MS,
      DEFAULT_LOCK_DURATION_MS,
      5_000,
      600_000,
    ),
    shutdownTimeoutMs: integerInRange(
      'WORKER_SHUTDOWN_TIMEOUT_MS',
      environment.WORKER_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      100,
      120_000,
    ),
    redisConnectTimeoutMs: integerInRange(
      'REDIS_CONNECT_TIMEOUT_MS',
      environment.REDIS_CONNECT_TIMEOUT_MS,
      DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
      100,
      120_000,
    ),
    phase2PollIntervalMs: integerInRange(
      'PHASE_2_POLL_INTERVAL_MS',
      environment.PHASE_2_POLL_INTERVAL_MS,
      DEFAULT_PHASE_2_POLL_INTERVAL_MS,
      250,
      60_000,
    ),
    phase2SweepIntervalMs: integerInRange(
      'PHASE_2_SWEEP_INTERVAL_MS',
      environment.PHASE_2_SWEEP_INTERVAL_MS,
      DEFAULT_PHASE_2_SWEEP_INTERVAL_MS,
      1_000,
      300_000,
    ),
    retentionSweepIntervalMs: integerInRange(
      'RETENTION_SWEEP_INTERVAL_MS',
      environment.RETENTION_SWEEP_INTERVAL_MS,
      DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
      60_000,
      86_400_000,
    ),
    retentionBatchSize: integerInRange(
      'RETENTION_BATCH_SIZE',
      environment.RETENTION_BATCH_SIZE,
      DEFAULT_RETENTION_BATCH_SIZE,
      100,
      10_000,
    ),
    retentionMaxBatchesPerSweep: integerInRange(
      'RETENTION_MAX_BATCHES_PER_SWEEP',
      environment.RETENTION_MAX_BATCHES_PER_SWEEP,
      DEFAULT_RETENTION_MAX_BATCHES,
      1,
      100,
    ),
    idempotencyRetentionDays: integerInRange(
      'IDEMPOTENCY_RETENTION_DAYS',
      environment.IDEMPOTENCY_RETENTION_DAYS,
      DEFAULT_IDEMPOTENCY_RETENTION_DAYS,
      30,
      3_650,
    ),
    outboxRetentionDays: integerInRange(
      'OUTBOX_RETENTION_DAYS',
      environment.OUTBOX_RETENTION_DAYS,
      DEFAULT_OUTBOX_RETENTION_DAYS,
      7,
      3_650,
    ),
    slackWebhookUrls: parseSlackWebhookUrls(environment),
    slackMinimumSeverity: slackMinimumSeverity as WorkerConfig['slackMinimumSeverity'],
    dashboardBaseUrl,
    healthHost: environment.WORKER_HEALTH_HOST?.trim() || '127.0.0.1',
    healthPort: integerInRange(
      'WORKER_HEALTH_PORT',
      environment.WORKER_HEALTH_PORT,
      3001,
      1,
      65_535,
    ),
  };
}
