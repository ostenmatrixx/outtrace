import type { Logger } from './logger.js';
import { safeError } from './logger.js';

export interface ClosableWorker {
  close(force?: boolean): Promise<void>;
}

export interface ClosableRedis {
  disconnect(): void;
  quit(): Promise<unknown>;
}

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface ShutdownResources {
  worker: ClosableWorker;
  redis: ClosableRedis;
}

export interface ShutdownOptions {
  timeoutMs: number;
  logger: Logger;
}

type OperationResult =
  { status: 'completed' } | { status: 'failed'; error: unknown } | { status: 'timed_out' };

function disconnectRedis(redis: ClosableRedis, logger: Logger): void {
  try {
    redis.disconnect();
  } catch (error) {
    logger.warn('redis_disconnect_failed', safeError(error));
  }
}

async function runBeforeDeadline(
  operation: () => Promise<unknown>,
  deadline: number,
): Promise<OperationResult> {
  let operationPromise: Promise<OperationResult>;
  try {
    operationPromise = operation().then(
      () => ({ status: 'completed' }),
      (error: unknown) => ({ status: 'failed', error }),
    );
  } catch (error) {
    return { status: 'failed', error };
  }

  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) {
    return { status: 'timed_out' };
  }

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<OperationResult>((resolve) => {
    timeout = setTimeout(() => resolve({ status: 'timed_out' }), remainingMs);
    timeout.unref();
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function shutdownResources(
  resources: ShutdownResources,
  options: ShutdownOptions,
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const gracefulClose = await runBeforeDeadline(() => resources.worker.close(false), deadline);

  if (gracefulClose.status === 'timed_out') {
    options.logger.warn('worker_shutdown_timeout', { timeoutMs: options.timeoutMs });
    void runBeforeDeadline(() => resources.worker.close(true), deadline);
    disconnectRedis(resources.redis, options.logger);
    return;
  }

  if (gracefulClose.status === 'failed') {
    options.logger.error('worker_close_failed', safeError(gracefulClose.error));
    const forceClose = await runBeforeDeadline(() => resources.worker.close(true), deadline);
    if (forceClose.status === 'timed_out') {
      options.logger.warn('worker_force_close_timeout', { timeoutMs: options.timeoutMs });
      disconnectRedis(resources.redis, options.logger);
      return;
    }
    if (forceClose.status === 'failed') {
      options.logger.error('worker_force_close_failed', safeError(forceClose.error));
      disconnectRedis(resources.redis, options.logger);
      return;
    }
  }

  const redisQuit = await runBeforeDeadline(() => resources.redis.quit(), deadline);
  if (redisQuit.status === 'timed_out') {
    options.logger.warn('redis_quit_timeout', { timeoutMs: options.timeoutMs });
    disconnectRedis(resources.redis, options.logger);
  } else if (redisQuit.status === 'failed') {
    options.logger.warn('redis_quit_failed', safeError(redisQuit.error));
    disconnectRedis(resources.redis, options.logger);
  }
}

export function createShutdownController(
  resources: ShutdownResources,
  options: ShutdownOptions,
): (reason: string) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return (reason) => {
    if (shutdownPromise === undefined) {
      options.logger.info('worker_shutdown_started', { reason });
      shutdownPromise = shutdownResources(resources, options).then(() => {
        options.logger.info('worker_shutdown_completed', { reason });
      });
    }

    return shutdownPromise;
  };
}

export function installSignalHandlers(
  shutdown: (reason: string) => Promise<void>,
  signalSource: SignalSource = process,
): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      void shutdown(signal);
    };
    handlers.set(signal, handler);
    signalSource.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      signalSource.off(signal, handler);
    }
  };
}
