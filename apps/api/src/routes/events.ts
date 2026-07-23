import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { eventStatuses, ingestEventSchema } from '@outtrace/contracts';

import { authenticateIngestion, readIngestionCredentials } from '../authentication.js';
import { HttpError } from '../errors.js';
import { persistEvent } from '../event-store.js';
import { isSensitiveMetadataKey, sanitizeMetadata } from '../metadata.js';

const supportedStatuses = new Set<string>(eventStatuses);

export function eventRateLimitKey(request: FastifyRequest): string {
  const rawKeyId = request.headers['x-outtrace-key-id'];
  const boundedKeyId =
    typeof rawKeyId === 'string' && rawKeyId.length <= 255 ? rawKeyId.trim() : '[invalid-key-id]';
  const keyIdDigest = createHash('sha256').update(boundedKeyId, 'utf8').digest('hex');
  return `${request.ip}:${keyIdDigest}`;
}

function validationDetails(
  issues: Array<{ code: string; message: string; path: PropertyKey[] }>,
): unknown {
  return {
    issues: issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path.map((segment) =>
        typeof segment === 'string' && isSensitiveMetadataKey(segment) ? '[redacted-key]' : segment,
      ),
    })),
  };
}

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.decorateRequest('outtraceWorkspaceId');

  app.post(
    '/v1/events',
    {
      config: {
        rateLimit: {
          keyGenerator: eventRateLimitKey,
          max: app.outtrace.eventRateLimitMax,
          timeWindow: '1 minute',
        },
      },
      preParsing: async (request, _reply, payload) => {
        const credentials = readIngestionCredentials(request);
        request.outtraceWorkspaceId = await authenticateIngestion(app.outtrace.pool, credentials);
        return payload;
      },
    },
    async (request, reply) => {
      const parsed = ingestEventSchema.safeParse(request.body);

      if (!parsed.success) {
        const body = request.body;
        const status =
          body !== null && typeof body === 'object' && 'status' in body ? body.status : undefined;
        if (typeof status === 'string' && !supportedStatuses.has(status)) {
          throw new HttpError(400, 'UNSUPPORTED_STATUS', 'The event status is not supported.');
        }

        throw new HttpError(
          400,
          'INVALID_PAYLOAD',
          'The event payload is invalid.',
          validationDetails(parsed.error.issues),
        );
      }

      const event = {
        ...parsed.data,
        metadata: sanitizeMetadata(parsed.data.metadata),
      };
      const response = await persistEvent(app.outtrace.pool, request.outtraceWorkspaceId!, event);

      return reply.code(response.duplicate ? 200 : 202).send(response);
    },
  );
}
