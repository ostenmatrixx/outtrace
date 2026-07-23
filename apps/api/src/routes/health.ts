import type { HealthResponse } from '@outtrace/contracts';
import type { FastifyInstance } from 'fastify';

async function dependencyStatus(check: () => Promise<unknown>): Promise<'up' | 'down'> {
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Health check timed out.')), 2_000);
      timeout.unref();

      void check().then(
        () => {
          clearTimeout(timeout);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
    return 'up';
  } catch {
    return 'down';
  }
}

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get('/health', async (): Promise<HealthResponse> => {
    const [postgres, redis] = await Promise.all([
      dependencyStatus(() => app.outtrace.pool.query('SELECT 1')),
      dependencyStatus(() => app.outtrace.redis.ping()),
    ]);

    return {
      dependencies: {
        postgres: { status: postgres },
        redis: { status: redis },
      },
      service: 'outtrace-api',
      status: postgres === 'up' && redis === 'up' ? 'ok' : 'degraded',
    };
  });
}
