export interface WorkerConfig {
  redisUrl: string;
  concurrency: number;
  lockDurationMs: number;
  shutdownTimeoutMs: number;
  redisConnectTimeoutMs: number;
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_LOCK_DURATION_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 10_000;

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
  return {
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
  };
}
