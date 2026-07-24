import {
  incidentNoteCreateSchema,
  incidentSeverities,
  incidentStatuses,
  incidentStatusUpdateSchema,
  incidentTypes,
} from '@outtrace/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { authenticateOperator, readOperatorCredentials } from '../authentication.js';
import { HttpError } from '../errors.js';
import { addIncidentNote, getIncident, listIncidents, updateIncident } from '../incident-store.js';

const querySchema = z.object({
  clientId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  processId: z.string().min(1).optional(),
  severity: z.enum(incidentSeverities).optional(),
  source: z.string().min(1).optional(),
  status: z.enum(incidentStatuses).optional(),
  type: z.enum(incidentTypes).optional(),
});

const paramsSchema = z.object({
  incidentId: z.string().min(1).max(200),
});

async function authenticate(request: FastifyRequest, app: FastifyInstance): Promise<void> {
  request.outtraceWorkspaceId = await authenticateOperator(
    app.outtrace.pool,
    readOperatorCredentials(request),
  );
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_PAYLOAD', 'The incident request is invalid.', {
      issues: parsed.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path,
      })),
    });
  }
  return parsed.data;
}

function actor(request: FastifyRequest): string {
  const value = request.headers['x-outtrace-operator-name'];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : 'operator';
}

export async function registerIncidentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/incidents',
    { preHandler: (request) => authenticate(request, app) },
    async (request) =>
      listIncidents(
        app.outtrace.pool,
        request.outtraceWorkspaceId!,
        parseOrThrow(querySchema, request.query),
      ),
  );

  app.get(
    '/v1/incidents/:incidentId',
    { preHandler: (request) => authenticate(request, app) },
    async (request) => {
      const { incidentId } = parseOrThrow(paramsSchema, request.params);
      return getIncident(app.outtrace.pool, request.outtraceWorkspaceId!, incidentId);
    },
  );

  app.patch(
    '/v1/incidents/:incidentId',
    { preHandler: (request) => authenticate(request, app) },
    async (request) => {
      const { incidentId } = parseOrThrow(paramsSchema, request.params);
      const update = parseOrThrow(incidentStatusUpdateSchema, request.body);
      return updateIncident(
        app.outtrace.pool,
        request.outtraceWorkspaceId!,
        incidentId,
        update,
        actor(request),
      );
    },
  );

  app.post(
    '/v1/incidents/:incidentId/notes',
    { preHandler: (request) => authenticate(request, app) },
    async (request, reply) => {
      const { incidentId } = parseOrThrow(paramsSchema, request.params);
      const note = parseOrThrow(incidentNoteCreateSchema, request.body);
      const incident = await addIncidentNote(
        app.outtrace.pool,
        request.outtraceWorkspaceId!,
        incidentId,
        note,
      );
      return reply.code(201).send(incident);
    },
  );
}
