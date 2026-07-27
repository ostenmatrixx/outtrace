import { startWorkerApplication } from './app.js';
import { loadWorkerConfig } from './config.js';
import { startWorkerHealthServer } from './health-server.js';
import { createLogger, safeError } from './logger.js';

const logger = createLogger();

async function start(): Promise<void> {
  const config = loadWorkerConfig();
  const application = startWorkerApplication(config, { logger });
  try {
    await startWorkerHealthServer(application, config, logger);
  } catch (error) {
    await application.shutdown('health_server_start_failed');
    throw error;
  }
}

try {
  await start();
} catch (error) {
  logger.error('worker_start_failed', safeError(error));
  process.exitCode = 1;
}
