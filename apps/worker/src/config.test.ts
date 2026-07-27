import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      retentionBatchSize: 1_000,
      retentionMaxBatchesPerSweep: 10,
      idempotencyRetentionDays: 365,
      outboxRetentionDays: 90,
      slackWebhookUrls: {},
      slackMinimumSeverity: 'high',
      dashboardBaseUrl: 'http://localhost:5173',
      healthHost: '127.0.0.1',
      healthPort: 3001,
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
      new WorkerConfigError('DATABASE_URL or DATABASE_URL_FILE is required'),
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

  it('requires tenant-keyed Slack routing', () => {
    expect(() =>
      loadWorkerConfig({
        ...{
          DATABASE_URL: 'postgres://localhost/outtrace',
          REDIS_URL: 'redis://localhost:6379',
        },
        SLACK_WEBHOOK_URL: 'https://hooks.slack.test/services/example',
      }),
    ).toThrow('SLACK_SINGLE_WORKSPACE_ID is required');

    expect(
      loadWorkerConfig({
        DATABASE_URL: 'postgres://localhost/outtrace',
        REDIS_URL: 'redis://localhost:6379',
        SLACK_WEBHOOK_URLS_JSON: JSON.stringify({
          ws_one: 'https://hooks.slack.test/services/one',
          ws_two: 'https://hooks.slack.test/services/two',
        }),
      }).slackWebhookUrls,
    ).toEqual({
      ws_one: 'https://hooks.slack.test/services/one',
      ws_two: 'https://hooks.slack.test/services/two',
    });
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

  it('loads dependency and Slack secrets from mounted files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'outtrace-worker-config-'));
    const databaseFile = join(directory, 'database_url');
    const redisFile = join(directory, 'redis_url');
    const slackFile = join(directory, 'slack_urls');
    writeFileSync(databaseFile, 'postgres://localhost/from-file\n');
    writeFileSync(redisFile, 'rediss://localhost:6380\n');
    writeFileSync(
      slackFile,
      JSON.stringify({ ws_file: 'https://hooks.slack.test/services/from-file' }),
    );
    try {
      expect(
        loadWorkerConfig({
          DATABASE_URL_FILE: databaseFile,
          REDIS_URL_FILE: redisFile,
          SLACK_WEBHOOK_URLS_JSON_FILE: slackFile,
        }),
      ).toMatchObject({
        databaseUrl: 'postgres://localhost/from-file',
        redisUrl: 'rediss://localhost:6380',
        slackWebhookUrls: {
          ws_file: 'https://hooks.slack.test/services/from-file',
        },
      });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('requires encrypted dependencies and dashboard links in production', () => {
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: 'postgres://db.example.com/outtrace',
        REDIS_URL: 'redis://redis.example.com:6379',
        DASHBOARD_BASE_URL: 'http://app.example.com',
        NODE_ENV: 'production',
      }),
    ).toThrow(WorkerConfigError);
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: 'postgres://db.example.com/outtrace?sslmode=require',
        REDIS_URL: 'rediss://redis.example.com:6380',
        DASHBOARD_BASE_URL: 'https://app.example.com',
        NODE_ENV: 'production',
      }),
    ).toThrow('sslmode=verify-full');
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: 'postgres://db.example.com/outtrace?sslmode=verify-full',
        REDIS_URL: 'rediss://redis.example.com:6380',
        DASHBOARD_BASE_URL: 'https://app.example.com',
        NODE_ENV: 'production',
        SLACK_SINGLE_WORKSPACE_ID: 'ws_one',
        SLACK_WEBHOOK_URL: 'https://hooks.slack.test/services/legacy',
      }),
    ).toThrow('legacy SLACK_WEBHOOK_URL is disabled in production');
    expect(
      loadWorkerConfig({
        DATABASE_URL: 'postgres://db.example.com/outtrace?sslmode=verify-full',
        REDIS_URL: 'rediss://redis.example.com:6380',
        DASHBOARD_BASE_URL: 'https://app.example.com',
        NODE_ENV: 'production',
      }),
    ).toMatchObject({
      databaseUrl: 'postgres://db.example.com/outtrace?sslmode=verify-full',
      redisUrl: 'rediss://redis.example.com:6380',
    });
  });
});
