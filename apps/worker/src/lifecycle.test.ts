import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createShutdownController, installSignalHandlers, shutdownResources } from './lifecycle.js';
import type { Logger } from './logger.js';

function testLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('worker lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the worker before closing Redis', async () => {
    const order: string[] = [];
    const worker = {
      close: vi.fn(async () => {
        order.push('worker');
      }),
    };
    const redis = {
      quit: vi.fn(async () => {
        order.push('redis');
      }),
      disconnect: vi.fn(),
    };

    await shutdownResources({ worker, redis }, { logger: testLogger(), timeoutMs: 1_000 });

    expect(worker.close).toHaveBeenCalledWith(false);
    expect(redis.disconnect).not.toHaveBeenCalled();
    expect(order).toEqual(['worker', 'redis']);
  });

  it('makes repeated shutdown requests idempotent', async () => {
    const worker = { close: vi.fn(async () => undefined) };
    const redis = {
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    };
    const shutdown = createShutdownController(
      { worker, redis },
      { logger: testLogger(), timeoutMs: 1_000 },
    );

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(redis.quit).toHaveBeenCalledTimes(1);
  });

  it('bounds a hanging graceful close and disconnects after attempting a force close', async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => undefined);
    const worker = {
      close: vi.fn((force?: boolean) => (force ? Promise.resolve() : never)),
    };
    const redis = {
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    };
    const logger = testLogger();

    const shutdown = shutdownResources({ worker, redis }, { logger, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(redis.disconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(worker.close).toHaveBeenNthCalledWith(1, false);
    expect(worker.close).toHaveBeenNthCalledWith(2, true);
    expect(redis.quit).not.toHaveBeenCalled();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('worker_shutdown_timeout', { timeoutMs: 1_000 });
  });

  it('bounds a hanging force close within the original shutdown deadline', async () => {
    vi.useFakeTimers();
    const gracefulError = new Error('graceful close failed');
    let rejectForceClose: ((error: Error) => void) | undefined;
    const worker = {
      close: vi.fn((force?: boolean) =>
        force
          ? new Promise<void>((_resolve, reject) => {
              rejectForceClose = reject;
            })
          : Promise.reject(gracefulError),
      ),
    };
    const redis = {
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    };
    const logger = testLogger();

    const shutdown = shutdownResources({ worker, redis }, { logger, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdown;

    expect(worker.close).toHaveBeenNthCalledWith(2, true);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('worker_close_failed', {
      errorName: 'Error',
      errorMessage: 'graceful close failed',
    });
    expect(logger.warn).toHaveBeenCalledWith('worker_force_close_timeout', {
      timeoutMs: 1_000,
    });

    rejectForceClose?.(new Error('late force close failure'));
    await Promise.resolve();
  });

  it('disconnects and resolves when force close fails', async () => {
    const worker = {
      close: vi
        .fn<(force?: boolean) => Promise<void>>()
        .mockRejectedValueOnce(new Error('graceful failure'))
        .mockRejectedValueOnce(new Error('force failure')),
    };
    const redis = {
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    };
    const logger = testLogger();

    await expect(
      shutdownResources({ worker, redis }, { logger, timeoutMs: 1_000 }),
    ).resolves.toBeUndefined();

    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    expect(redis.quit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('worker_force_close_failed', {
      errorName: 'Error',
      errorMessage: 'force failure',
    });
  });

  it('bounds a hanging Redis quit and ignores a later rejection', async () => {
    vi.useFakeTimers();
    let rejectQuit: ((error: Error) => void) | undefined;
    const worker = { close: vi.fn(async () => undefined) };
    const redis = {
      quit: vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectQuit = reject;
          }),
      ),
      disconnect: vi.fn(),
    };
    const logger = testLogger();

    const shutdown = shutdownResources({ worker, redis }, { logger, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdown;

    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('redis_quit_timeout', { timeoutMs: 1_000 });

    rejectQuit?.(new Error('late quit failure'));
    await Promise.resolve();
  });

  it('shares one total deadline across worker close phases and Redis quit', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const worker = {
      close: vi.fn(
        (force?: boolean) =>
          new Promise<void>((resolve, reject) => {
            setTimeout(
              () => {
                if (force) {
                  resolve();
                } else {
                  reject(new Error('graceful close failed'));
                }
              },
              force ? 400 : 300,
            );
          }),
      ),
    };
    const redis = {
      quit: vi.fn(() => new Promise<never>(() => undefined)),
      disconnect: vi.fn(),
    };

    const shutdown = shutdownResources(
      { worker, redis },
      { logger: testLogger(), timeoutMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdown;

    expect(Date.now() - startedAt).toBe(1_000);
    expect(worker.close).toHaveBeenCalledTimes(2);
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects and resolves when Redis quit fails', async () => {
    const worker = { close: vi.fn(async () => undefined) };
    const redis = {
      quit: vi.fn(async () => {
        throw new Error('quit failed');
      }),
      disconnect: vi.fn(),
    };
    const logger = testLogger();

    await expect(
      shutdownResources({ worker, redis }, { logger, timeoutMs: 1_000 }),
    ).resolves.toBeUndefined();

    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('redis_quit_failed', {
      errorName: 'Error',
      errorMessage: 'quit failed',
    });
  });

  it('wires and removes SIGINT and SIGTERM handlers', async () => {
    const signals = new EventEmitter();
    const shutdown = vi.fn(async () => undefined);
    const removeHandlers = installSignalHandlers(shutdown, signals);

    signals.emit('SIGTERM');
    await Promise.resolve();
    expect(shutdown).toHaveBeenCalledWith('SIGTERM');

    removeHandlers();
    signals.emit('SIGINT');
    await Promise.resolve();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
