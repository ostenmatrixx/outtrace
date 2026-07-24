import type { Job } from 'bullmq';

import type { WorkerConfig } from './config.js';
import { createShutdownController, installSignalHandlers, type SignalSource } from './lifecycle.js';
import { createLogger, safeError, type Logger } from './logger.js';
import { createPhase2Runtime, type Phase2Runtime } from './phase2-runtime.js';
import { createIncidentEvaluationWorker, type IncidentWorker } from './queue.js';
import { createRedisConnection, type RedisConnection } from './redis.js';

export type RuntimeStatus = 'starting' | 'ready' | 'degraded' | 'stopping' | 'stopped';

export interface WorkerApplication {
  readonly redis: RedisConnection;
  readonly worker: IncidentWorker;
  getStatus(): RuntimeStatus;
  shutdown(reason?: string): Promise<void>;
}

export interface WorkerApplicationOptions {
  logger?: Logger;
  signalSource?: SignalSource;
  createRedis?: typeof createRedisConnection;
  createWorker?: typeof createIncidentEvaluationWorker;
  createRuntime?: (redis: RedisConnection, config: WorkerConfig, logger: Logger) => Phase2Runtime;
}

type ComponentStatus = 'starting' | 'ready' | 'degraded';
type LifecycleStatus = 'running' | 'stopping' | 'stopped';

export function startWorkerApplication(
  config: WorkerConfig,
  options: WorkerApplicationOptions = {},
): WorkerApplication {
  const logger = options.logger ?? createLogger();
  const redis = (options.createRedis ?? createRedisConnection)(config);
  const runtime =
    options.createRuntime?.(redis, config, logger) ??
    (options.createWorker
      ? {
          pool: {} as Phase2Runtime['pool'],
          async close() {},
          start() {},
          async tick() {},
        }
      : createPhase2Runtime(redis, config, logger));
  const worker = (options.createWorker ?? createIncidentEvaluationWorker)(
    redis,
    config,
    runtime.pool,
  );
  runtime.start();
  let redisStatus: ComponentStatus = 'starting';
  let workerStatus: ComponentStatus = 'starting';
  let lifecycleStatus: LifecycleStatus = 'running';

  const getStatus = (): RuntimeStatus => {
    if (lifecycleStatus !== 'running') {
      return lifecycleStatus;
    }
    if (redisStatus === 'degraded' || workerStatus === 'degraded') {
      return 'degraded';
    }
    if (redisStatus === 'ready' && workerStatus === 'ready') {
      return 'ready';
    }
    return 'starting';
  };

  redis.on('ready', () => {
    redisStatus = 'ready';
    logger.info('redis_ready');
  });
  redis.on('reconnecting', () => {
    redisStatus = 'degraded';
    logger.warn('redis_reconnecting');
  });
  redis.on('close', () => {
    redisStatus = 'degraded';
    if (lifecycleStatus === 'running') {
      logger.warn('redis_connection_closed');
    }
  });
  redis.on('error', (error: Error) => {
    redisStatus = 'degraded';
    logger.error('redis_error', safeError(error));
  });

  worker.on('ready', () => {
    workerStatus = 'ready';
    logger.info('worker_ready', {
      concurrency: config.concurrency,
      queue: worker.name,
    });
  });
  worker.on('completed', (job: Job, result: unknown) => {
    logger.info('job_completed', {
      jobId: job.id ?? null,
      jobName: job.name,
      result,
    });
  });
  worker.on('failed', (job: Job | undefined, error: Error) => {
    logger.error('job_failed', {
      jobId: job?.id ?? null,
      jobName: job?.name ?? null,
      ...safeError(error),
    });
  });
  worker.on('error', (error: Error) => {
    workerStatus = 'degraded';
    logger.error('worker_error', safeError(error));
  });

  logger.info('worker_starting', {
    concurrency: config.concurrency,
    queue: worker.name,
  });

  const performShutdown = createShutdownController(
    {
      redis,
      worker: {
        close: async (force) => {
          await worker.close(force);
          await runtime.close();
        },
      },
    },
    { logger, timeoutMs: config.shutdownTimeoutMs },
  );
  const removeSignalHandlers = installSignalHandlers(async (reason) => {
    lifecycleStatus = 'stopping';
    removeSignalHandlers();
    await performShutdown(reason);
    lifecycleStatus = 'stopped';
  }, options.signalSource);

  return {
    redis,
    worker,
    getStatus,
    shutdown: async (reason = 'application_request') => {
      if (lifecycleStatus !== 'stopped') {
        lifecycleStatus = 'stopping';
        removeSignalHandlers();
        await performShutdown(reason);
        lifecycleStatus = 'stopped';
      }
    },
  };
}
