import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { sha256Hex } from './crypto.js';
import type { RedisConnection } from './redis.js';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

function fakePool(healthy: boolean, queries: string[] = []): pg.Pool {
  return {
    async end() {},
    async query(sql: string) {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      if (!healthy) {
        throw new Error('postgres unavailable at sensitive-host');
      }
      if (sql.includes('FROM process_ingestion_credentials')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM workspaces')) {
        return {
          rowCount: 1,
          rows: [{ id: 'ws_1', ingestion_key_hash: sha256Hex('valid-secret') }],
        };
      }
      return { rowCount: 1, rows: [{ '?column?': 1 }] };
    },
  } as unknown as pg.Pool;
}

function fakeRedis(healthy: boolean): RedisConnection {
  return {
    async close() {},
    async ping() {
      if (!healthy) {
        throw new Error('redis unavailable at sensitive-host');
      }
      return 'PONG';
    },
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /health', () => {
  it('matches the shared health contract when dependencies are up', async () => {
    const app = await createApp({
      dependencies: { pool: fakePool(true), redis: fakeRedis(true) },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      dependencies: {
        postgres: { status: 'up' },
        redis: { status: 'up' },
      },
      service: 'outtrace-api',
      status: 'ok',
    });
  });

  it('reports degradation without exposing dependency errors', async () => {
    const app = await createApp({
      dependencies: { pool: fakePool(false), redis: fakeRedis(false) },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      dependencies: {
        postgres: { status: 'down' },
        redis: { status: 'down' },
      },
      service: 'outtrace-api',
      status: 'degraded',
    });
    expect(response.body).not.toContain('sensitive-host');

    const readiness = await app.inject({ method: 'GET', url: '/ready' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({ status: 'degraded' });

    const liveness = await app.inject({ method: 'GET', url: '/live' });
    expect(liveness.statusCode).toBe(200);
    expect(liveness.json()).toEqual({ service: 'outtrace-api', status: 'ok' });
  });
});

describe('global API boundary', () => {
  it('rate-limits non-ingestion routes by request origin', async () => {
    const app = await createApp({
      apiRateLimitMax: 2,
      dependencies: { pool: fakePool(true), redis: fakeRedis(true) },
    });
    apps.push(app);

    expect((await app.inject({ method: 'GET', url: '/v1/session' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/session' })).statusCode).toBe(401);
    const limited = await app.inject({ method: 'GET', url: '/v1/session' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many API requests. Please retry later.',
      },
    });
    expect((await app.inject({ method: 'GET', url: '/live' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });
});

describe('POST /v1/events request boundary', () => {
  it('can disable legacy workspace-wide credentials at the application boundary', async () => {
    const app = await createApp({
      allowLegacyWorkspaceCredentials: false,
      dependencies: { pool: fakePool(true), redis: fakeRedis(true) },
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        'x-outtrace-key': 'valid-secret',
        'x-outtrace-key-id': 'key_1',
      },
      method: 'POST',
      payload: {},
      url: '/v1/events',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'AUTHENTICATION_INVALID' },
    });
  });

  it('returns a structured missing-auth error before database access', async () => {
    const app = await createApp({
      dependencies: { pool: fakePool(true), redis: fakeRedis(true) },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      payload: {},
      url: '/v1/events',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Both x-outtrace-key-id and x-outtrace-key headers are required.',
      },
    });
  });

  it('returns useful validation issues without echoing the payload', async () => {
    const queries: string[] = [];
    const app = await createApp({
      dependencies: { pool: fakePool(true, queries), redis: fakeRedis(true) },
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        'x-outtrace-key': 'valid-secret',
        'x-outtrace-key-id': 'key_1',
      },
      method: 'POST',
      payload: { processKey: 'onboarding', sensitivePayload: 'do-not-echo-this' },
      url: '/v1/events',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INVALID_PAYLOAD',
        details: { issues: expect.any(Array) },
      },
    });
    expect(response.body).not.toContain('do-not-echo-this');
    expect(response.body).not.toContain('sensitivePayload');
    expect(queries.some((sql) => sql.includes('FROM workspaces'))).toBe(true);
  });

  it('fully authenticates before parsing or validating the body', async () => {
    const app = await createApp({
      dependencies: { pool: fakePool(true), redis: fakeRedis(true) },
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        'content-type': 'application/json',
        'x-outtrace-key': 'wrong-secret',
        'x-outtrace-key-id': 'key_1',
      },
      method: 'POST',
      payload: '{"invalid":',
      url: '/v1/events',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'AUTHENTICATION_INVALID' },
    });
  });

  it('maps authentication database failures safely before payload validation', async () => {
    const app = await createApp({
      dependencies: { pool: fakePool(false), redis: fakeRedis(true) },
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        'x-outtrace-key': 'valid-secret',
        'x-outtrace-key-id': 'key_1',
      },
      method: 'POST',
      payload: {},
      url: '/v1/events',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'DATABASE_FAILURE' },
    });
    expect(response.body).not.toContain('sensitive-host');
  });

  it('returns UNSUPPORTED_STATUS for an unsupported event status', async () => {
    const app = await createApp({
      dependencies: { pool: fakePool(true), redis: fakeRedis(true) },
    });
    apps.push(app);

    const response = await app.inject({
      headers: {
        'x-outtrace-key': 'valid-secret',
        'x-outtrace-key-id': 'key_1',
      },
      method: 'POST',
      payload: { status: 'waiting' },
      url: '/v1/events',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'UNSUPPORTED_STATUS',
        message: 'The event status is not supported.',
      },
    });
  });

  it('rate limits by the request IP and key ID without echoing either identifier', async () => {
    const app = await createApp({
      dependencies: { pool: fakePool(true), redis: fakeRedis(true) },
      eventRateLimitMax: 1,
    });
    apps.push(app);
    const request = {
      headers: {
        'x-outtrace-key': 'wrong-secret',
        'x-outtrace-key-id': 'sensitive-key-id',
      },
      method: 'POST' as const,
      payload: {},
      url: '/v1/events',
    };

    expect((await app.inject(request)).statusCode).toBe(401);
    const limited = await app.inject(request);

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many event ingestion requests. Please retry later.',
      },
    });
    expect(limited.body).not.toContain('sensitive-key-id');
    expect(limited.body).not.toContain('127.0.0.1');
  });
});
