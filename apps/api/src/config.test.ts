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
      corsOrigin: 'http://localhost:5173',
      host: '127.0.0.1',
      nodeEnvironment: 'development',
      port: 3000,
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
        ...minimumEnvironment,
        DEV_CLIENT_ID: 'client_1',
        DEV_INGESTION_KEY: 'secret',
        DEV_INGESTION_KEY_ID: 'key_1',
        DEV_PROCESS_ID: 'process_1',
        DEV_PROCESS_KEY: 'onboarding',
        DEV_WORKSPACE_ID: 'workspace_1',
        NODE_ENV: 'production',
        OUTTRACE_SEED_DEVELOPMENT: 'true',
      }),
    ).toThrow(ConfigurationError);
  });
});
