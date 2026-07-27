import { describe, expect, it, vi } from 'vitest';

import type { WorkerApplication, RuntimeStatus } from './app.js';
import { startWorkerHealthServer } from './health-server.js';
import type { Logger } from './logger.js';

describe('worker health server', () => {
  it('separates liveness from dependency readiness', async () => {
    let status: RuntimeStatus = 'degraded';
    const application = {
      getStatus: () => status,
    } as WorkerApplication;
    const logger: Logger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const server = await startWorkerHealthServer(
      application,
      { healthHost: '127.0.0.1', healthPort: 0 },
      logger,
    );
    try {
      const live = await fetch(`http://127.0.0.1:${server.port}/live`);
      const notReady = await fetch(`http://127.0.0.1:${server.port}/ready`);
      expect(live.status).toBe(200);
      expect(notReady.status).toBe(503);
      expect(await notReady.json()).toMatchObject({ runtimeStatus: 'degraded' });

      status = 'ready';
      const ready = await fetch(`http://127.0.0.1:${server.port}/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ status: 'ok', runtimeStatus: 'ready' });
    } finally {
      await server.close();
    }
  });
});
