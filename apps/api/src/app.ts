import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';

import { HttpError } from './errors.js';
import type { RedisConnection } from './redis.js';
import { registerAgencyRoutes } from './routes/agency.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoute } from './routes/health.js';
import { registerIncidentRoutes } from './routes/incidents.js';

export interface AppDependencies {
  pool: pg.Pool;
  redis: RedisConnection;
}

export interface CreateAppOptions {
  corsOrigin?: string;
  dependencies: AppDependencies;
  eventRateLimitMax?: number;
  logger?: FastifyServerOptions['logger'];
}

class EventRateLimitError extends Error {
  readonly statusCode = 429;

  constructor() {
    super('Too many event ingestion requests. Please retry later.');
    this.name = 'EventRateLimitError';
  }

  toResponse() {
    return {
      error: {
        code: 'RATE_LIMITED',
        message: this.message,
      },
    };
  }
}

function isInvalidJsonError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
  );
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
  });

  app.decorate('outtrace', {
    ...options.dependencies,
    eventRateLimitMax: options.eventRateLimitMax ?? 120,
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof EventRateLimitError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }

    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }

    if (isInvalidJsonError(error)) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'The request body must be valid JSON.',
        },
      });
    }

    request.log.error({ err: error }, 'Unhandled API request error');
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
  });

  await app.register(cors, {
    allowedHeaders: [
      'accept',
      'content-type',
      'x-outtrace-key',
      'x-outtrace-key-id',
      'x-outtrace-operator-key',
      'x-outtrace-operator-key-id',
      'x-outtrace-operator-name',
    ],
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    origin: options.corsOrigin ?? 'http://localhost:5173',
  });
  await app.register(rateLimit, {
    errorResponseBuilder: () => new EventRateLimitError(),
    global: false,
  });
  await app.register(registerHealthRoute);
  await app.register(registerEventRoutes);
  await app.register(registerIncidentRoutes);
  await app.register(registerAgencyRoutes);

  app.addHook('onClose', async () => {
    await Promise.allSettled([options.dependencies.pool.end(), options.dependencies.redis.close()]);
  });

  await app.ready();
  return app;
}
