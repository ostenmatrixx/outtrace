import { startWorkerApplication } from './app.js';
import { loadWorkerConfig } from './config.js';
import { createLogger, safeError } from './logger.js';

const logger = createLogger();

try {
  const config = loadWorkerConfig();
  startWorkerApplication(config, { logger });
} catch (error) {
  logger.error('worker_start_failed', safeError(error));
  process.exitCode = 1;
}
