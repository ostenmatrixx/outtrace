import { describe, expect, it } from 'vitest';

import { loadWorkerConfig, WorkerConfigError } from './config.js';

describe('loadWorkerConfig', () => {
  it('loads safe defaults', () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL: 'postgres://localhost/outtrace',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toEqual({
      databaseUrl: 'postgres://localhost/outtrace',
      redisUrl: 'redis://localhost:6379',
      concurrency: 5,
      lockDurationMs: 30_000,
      shutdownTimeoutMs: 30_000,
      redisConnectTimeoutMs: 10_000,
      phase2PollIntervalMs: 1_000,
      phase2SweepIntervalMs: 30_000,
      retentionSweepIntervalMs: 3_600_000,
      slackMinimumSeverity: 'high',
      dashboardBaseUrl: 'http://localhost:5173',
    });
  });

  it('loads explicit worker controls', () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL: 'postgres://localhost/outtrace',
        REDIS_URL: 'rediss://worker:secret@redis.example.com:6380/1',
        WORKER_CONCURRENCY: '12',
        WORKER_LOCK_DURATION_MS: '45000',
        WORKER_SHUTDOWN_TIMEOUT_MS: '15000',
        REDIS_CONNECT_TIMEOUT_MS: '5000',
      }),
    ).toMatchObject({
      concurrency: 12,
      lockDurationMs: 45_000,
      shutdownTimeoutMs: 15_000,
      redisConnectTimeoutMs: 5_000,
    });
  });

  it('requires REDIS_URL without echoing a supplied secret', () => {
    expect(() => loadWorkerConfig({ REDIS_URL: 'redis://localhost:6379' })).toThrowError(
      new WorkerConfigError('DATABASE_URL is required'),
    );

    const secret = 'do-not-log-this';
    expect(() =>
      loadWorkerConfig({ DATABASE_URL: 'postgres://localhost/outtrace', REDIS_URL: secret }),
    ).toThrowError('REDIS_URL must be a valid redis:// or rediss:// URL');
    try {
      loadWorkerConfig({ DATABASE_URL: 'postgres://localhost/outtrace', REDIS_URL: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each([
    ['WORKER_CONCURRENCY', '0'],
    ['WORKER_CONCURRENCY', '1.5'],
    ['WORKER_LOCK_DURATION_MS', '4999'],
    ['WORKER_SHUTDOWN_TIMEOUT_MS', '-1'],
    ['REDIS_CONNECT_TIMEOUT_MS', '120001'],
  ])('rejects an unsafe %s value', (name, value) => {
    expect(() =>
      loadWorkerConfig({
        REDIS_URL: 'redis://localhost:6379',
        DATABASE_URL: 'postgres://localhost/outtrace',
        [name]: value,
      }),
    ).toThrow(WorkerConfigError);
  });
});
