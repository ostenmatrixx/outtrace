import { createServer, type Server } from 'node:http';

import type { WorkerConfig } from './config.js';
import type { WorkerApplication } from './app.js';
import type { Logger } from './logger.js';

export interface WorkerHealthServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startWorkerHealthServer(
  application: WorkerApplication,
  config: Pick<WorkerConfig, 'healthHost' | 'healthPort'>,
  logger: Logger,
): Promise<WorkerHealthServer> {
  const server: Server = createServer((request, response) => {
    const status = application.getStatus();
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');

    if (request.url === '/live') {
      const live = status !== 'stopped';
      response.statusCode = live ? 200 : 503;
      response.end(JSON.stringify({ service: 'outtrace-worker', status: live ? 'ok' : 'down' }));
      return;
    }

    if (request.url === '/ready') {
      const ready = status === 'ready';
      response.statusCode = ready ? 200 : 503;
      response.end(
        JSON.stringify({
          service: 'outtrace-worker',
          status: ready ? 'ok' : 'degraded',
          runtimeStatus: status,
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.healthPort, config.healthHost);
  });
  server.unref();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.healthPort;
  logger.info('worker_health_server_ready', {
    host: config.healthHost,
    port,
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
