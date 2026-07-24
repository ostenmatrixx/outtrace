export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  concurrency: number;
  lockDurationMs: number;
  shutdownTimeoutMs: number;
  redisConnectTimeoutMs: number;
  phase2PollIntervalMs: number;
  phase2SweepIntervalMs: number;
  slackWebhookUrl?: string;
  slackMinimumSeverity: 'critical' | 'high' | 'medium' | 'low';
  dashboardBaseUrl: string;
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_LOCK_DURATION_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PHASE_2_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PHASE_2_SWEEP_INTERVAL_MS = 30_000;

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
  const slackWebhookUrl = environment.SLACK_WEBHOOK_URL?.trim();
  if (slackWebhookUrl) {
    let parsed: URL;
    try {
      parsed = new URL(slackWebhookUrl);
    } catch {
      throw new WorkerConfigError('SLACK_WEBHOOK_URL must be a valid HTTPS URL');
    }
    if (parsed.protocol !== 'https:') {
      throw new WorkerConfigError('SLACK_WEBHOOK_URL must use https://');
    }
  }

  return {
    databaseUrl: requiredDatabaseUrl(environment.DATABASE_URL),
    redisUrl: requiredRedisUrl(environment.REDIS_URL),
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
    ...(slackWebhookUrl ? { slackWebhookUrl } : {}),
    slackMinimumSeverity: slackMinimumSeverity as WorkerConfig['slackMinimumSeverity'],
    dashboardBaseUrl: (environment.DASHBOARD_BASE_URL ?? 'http://localhost:5173').replace(
      /\/+$/,
      '',
    ),
  };
}
