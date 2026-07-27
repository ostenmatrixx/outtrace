import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './database.js';
import { ProductionRedisConnection } from './redis.js';

async function start(): Promise<void> {
  const config = loadConfig();
  const app = await createApp({
    allowLegacyWorkspaceCredentials: config.allowLegacyWorkspaceCredentials,
    corsOrigin: config.corsOrigin,
    dependencies: {
      pool: createPool(config),
      redis: new ProductionRedisConnection(config.redisUrl),
    },
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['req.headers', 'request.headers'],
        remove: true,
      },
    },
    production: config.nodeEnvironment === 'production',
    trustProxy: config.trustProxy,
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down API');
    try {
      await app.close();
      process.exitCode = 0;
    } catch (error) {
      app.log.error({ err: error }, 'API shutdown failed');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error({ err: error }, 'API failed to start');
    await app.close();
    process.exitCode = 1;
  }
}

void start();
