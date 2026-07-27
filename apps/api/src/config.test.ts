import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from './config.js';

const minimumEnvironment = {
  DATABASE_URL: 'postgres://localhost/outtrace',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('loads safe local defaults without enabling the seed', () => {
    const config = loadConfig(minimumEnvironment);

    expect(config).toMatchObject({
      allowLegacyWorkspaceCredentials: true,
      corsOrigin: 'http://localhost:5173',
      host: '127.0.0.1',
      nodeEnvironment: 'development',
      port: 3000,
      trustProxy: false,
    });
    expect(config.developmentSeed).toBeUndefined();
  });

  it('requires every development seed value when seeding is enabled', () => {
    expect(() => loadConfig({ ...minimumEnvironment, OUTTRACE_SEED_DEVELOPMENT: 'true' })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects malformed ports and dependency URLs without including secrets', () => {
    expect(() => loadConfig({ ...minimumEnvironment, API_PORT: '70000' })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects development seeding in production even when all seed values are present', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://localhost/outtrace?sslmode=require',
        REDIS_URL: 'rediss://localhost:6379',
        API_CORS_ORIGIN: 'https://app.example.com',
        DEV_CLIENT_ID: 'client_1',
        DEV_INGESTION_KEY: 'secret',
        DEV_INGESTION_KEY_ID: 'key_1',
        DEV_OPERATOR_KEY: 'operator-secret',
        DEV_OPERATOR_KEY_ID: 'operator-key-1',
        DEV_PROCESS_ID: 'process_1',
        DEV_PROCESS_KEY: 'onboarding',
        DEV_WORKSPACE_ID: 'workspace_1',
        NODE_ENV: 'production',
        OUTTRACE_SEED_DEVELOPMENT: 'true',
      }),
    ).toThrow(ConfigurationError);
  });

  it('requires encrypted dependency and browser connections in production', () => {
    expect(() => loadConfig({ ...minimumEnvironment, NODE_ENV: 'production' })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://db.example.com/outtrace?sslmode=require',
        REDIS_URL: 'rediss://redis.example.com:6380',
        API_CORS_ORIGIN: 'https://app.example.com',
        NODE_ENV: 'production',
      }),
    ).toThrow('sslmode=verify-full');
    expect(
      loadConfig({
        DATABASE_URL: 'postgres://db.example.com/outtrace?sslmode=verify-full',
        REDIS_URL: 'rediss://redis.example.com:6380',
        API_CORS_ORIGIN: 'https://app.example.com',
        NODE_ENV: 'production',
      }),
    ).toMatchObject({
      allowLegacyWorkspaceCredentials: false,
      nodeEnvironment: 'production',
    });
  });

  it('enables proxy address trust only when explicitly configured', () => {
    expect(loadConfig({ ...minimumEnvironment, API_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });

  it('requires CORS to be configured as one exact origin', () => {
    expect(() =>
      loadConfig({ ...minimumEnvironment, API_CORS_ORIGIN: 'https://app.example.com/path' }),
    ).toThrow('exact origin');
  });

  it('loads dependency URLs from mounted secret files and rejects ambiguous values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'outtrace-api-config-'));
    const databaseFile = join(directory, 'database_url');
    const redisFile = join(directory, 'redis_url');
    writeFileSync(databaseFile, 'postgres://localhost/from-file\n');
    writeFileSync(redisFile, 'rediss://localhost:6380\n');
    try {
      expect(
        loadConfig({
          DATABASE_URL_FILE: databaseFile,
          REDIS_URL_FILE: redisFile,
        }),
      ).toMatchObject({
        databaseUrl: 'postgres://localhost/from-file',
        redisUrl: 'rediss://localhost:6380',
      });
      expect(() =>
        loadConfig({
          DATABASE_URL: 'postgres://localhost/direct',
          DATABASE_URL_FILE: databaseFile,
          REDIS_URL: 'redis://localhost:6379',
        }),
      ).toThrow('DATABASE_URL and DATABASE_URL_FILE cannot both be set');
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
