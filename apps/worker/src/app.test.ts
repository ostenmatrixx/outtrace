import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { startWorkerApplication } from './app.js';
import type { WorkerConfig } from './config.js';
import type { Logger } from './logger.js';
import type { IncidentWorker } from './queue.js';
import type { RedisConnection } from './redis.js';

const config: WorkerConfig = {
  databaseUrl: 'postgres://localhost/outtrace',
  redisUrl: 'redis://localhost:6379',
  concurrency: 5,
  lockDurationMs: 30_000,
  shutdownTimeoutMs: 1_000,
  redisConnectTimeoutMs: 10_000,
  phase2PollIntervalMs: 1_000,
  phase2SweepIntervalMs: 30_000,
  retentionSweepIntervalMs: 3_600_000,
  slackMinimumSeverity: 'high',
  dashboardBaseUrl: 'http://localhost:5173',
};

function loggerSpies(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('worker application', () => {
  it.each([
    ['redis then worker', ['redis', 'worker']],
    ['worker then redis', ['worker', 'redis']],
  ])('becomes ready only after both components are ready: %s', async (_name, eventOrder) => {
    const redis = Object.assign(new EventEmitter(), {
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    });
    const worker = Object.assign(new EventEmitter(), {
      name: 'incident-evaluation',
      close: vi.fn(async () => undefined),
    });
    const signals = new EventEmitter();

    const application = startWorkerApplication(config, {
      logger: loggerSpies(),
      signalSource: signals,
      createRedis: () => redis as unknown as RedisConnection,
      createWorker: () => worker as unknown as IncidentWorker,
    });

    expect(application.getStatus()).toBe('starting');
    for (const component of eventOrder) {
      if (component === 'redis') {
        redis.emit('ready');
      } else {
        worker.emit('ready');
      }
      expect(application.getStatus()).toBe(component === eventOrder.at(-1) ? 'ready' : 'starting');
    }

    await application.shutdown();
    expect(application.getStatus()).toBe('stopped');
  });

  it('does not let one component readiness mask degradation in the other', async () => {
    const redis = Object.assign(new EventEmitter(), {
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    });
    const worker = Object.assign(new EventEmitter(), {
      name: 'incident-evaluation',
      close: vi.fn(async () => undefined),
    });

    const application = startWorkerApplication(config, {
      logger: loggerSpies(),
      signalSource: new EventEmitter(),
      createRedis: () => redis as unknown as RedisConnection,
      createWorker: () => worker as unknown as IncidentWorker,
    });

    redis.emit('ready');
    worker.emit('error', new Error('worker unavailable'));
    redis.emit('ready');
    expect(application.getStatus()).toBe('degraded');

    worker.emit('ready');
    redis.emit('error', new Error('redis unavailable'));
    worker.emit('ready');
    expect(application.getStatus()).toBe('degraded');

    await application.shutdown();
  });

  it('recovers each component independently after reconnecting or becoming ready again', async () => {
    const redis = Object.assign(new EventEmitter(), {
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    });
    const worker = Object.assign(new EventEmitter(), {
      name: 'incident-evaluation',
      close: vi.fn(async () => undefined),
    });

    const application = startWorkerApplication(config, {
      logger: loggerSpies(),
      signalSource: new EventEmitter(),
      createRedis: () => redis as unknown as RedisConnection,
      createWorker: () => worker as unknown as IncidentWorker,
    });

    redis.emit('ready');
    worker.emit('ready');
    expect(application.getStatus()).toBe('ready');

    redis.emit('reconnecting');
    expect(application.getStatus()).toBe('degraded');
    redis.emit('ready');
    expect(application.getStatus()).toBe('ready');

    worker.emit('error', new Error('worker unavailable'));
    expect(application.getStatus()).toBe('degraded');
    worker.emit('ready');
    expect(application.getStatus()).toBe('ready');

    redis.emit('close');
    expect(application.getStatus()).toBe('degraded');
    redis.emit('ready');
    expect(application.getStatus()).toBe('ready');

    await application.shutdown();
  });

  it('keeps shutdown states authoritative over later readiness and error events', async () => {
    let finishWorkerClose: (() => void) | undefined;
    const redis = Object.assign(new EventEmitter(), {
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    });
    const worker = Object.assign(new EventEmitter(), {
      name: 'incident-evaluation',
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishWorkerClose = resolve;
          }),
      ),
    });

    const application = startWorkerApplication(config, {
      logger: loggerSpies(),
      signalSource: new EventEmitter(),
      createRedis: () => redis as unknown as RedisConnection,
      createWorker: () => worker as unknown as IncidentWorker,
    });

    const shutdown = application.shutdown();
    expect(application.getStatus()).toBe('stopping');
    redis.emit('ready');
    worker.emit('ready');
    worker.emit('error', new Error('late worker error'));
    expect(application.getStatus()).toBe('stopping');

    finishWorkerClose?.();
    await shutdown;
    expect(application.getStatus()).toBe('stopped');

    redis.emit('reconnecting');
    worker.emit('ready');
    expect(application.getStatus()).toBe('stopped');
  });

  it('logs failed-job identifiers and errors without logging job data', async () => {
    const redis = Object.assign(new EventEmitter(), {
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    });
    const worker = Object.assign(new EventEmitter(), {
      name: 'incident-evaluation',
      close: vi.fn(async () => undefined),
    });
    const logger = loggerSpies();

    const application = startWorkerApplication(config, {
      logger,
      signalSource: new EventEmitter(),
      createRedis: () => redis as unknown as RedisConnection,
      createWorker: () => worker as unknown as IncidentWorker,
    });

    worker.emit(
      'failed',
      {
        id: 'job_1',
        name: 'incident-evaluation',
        data: { apiToken: 'never-log-this' },
      },
      new Error('invalid job'),
    );

    expect(logger.error).toHaveBeenCalledWith('job_failed', {
      jobId: 'job_1',
      jobName: 'incident-evaluation',
      errorName: 'Error',
      errorMessage: 'invalid job',
    });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('never-log-this');

    await application.shutdown();
  });
});
