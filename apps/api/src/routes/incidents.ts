import {
  incidentFeedbackUpdateSchema,
  incidentNoteCreateSchema,
  incidentSeverities,
  incidentStatuses,
  incidentStatusUpdateSchema,
  incidentTypes,
} from '@outtrace/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { HttpError } from '../errors.js';
import {
  addIncidentNote,
  getIncident,
  listIncidents,
  recordIncidentFeedback,
  updateIncident,
} from '../incident-store.js';
import {
  authenticateOperatorRequest,
  requireClientAccess,
  requireRole,
} from '../operator-access.js';

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

export async function registerIncidentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/incidents',
    { preHandler: (request) => authenticateOperatorRequest(request, app) },
    async (request) =>
      listIncidents(app.outtrace.pool, request.outtraceWorkspaceId!, {
        ...parseOrThrow(querySchema, request.query),
        clientIds: request.outtraceOperator!.clientIds,
      }),
  );

  app.get(
    '/v1/incidents/:incidentId',
    { preHandler: (request) => authenticateOperatorRequest(request, app) },
    async (request) => {
      const { incidentId } = parseOrThrow(paramsSchema, request.params);
      const incident = await getIncident(
        app.outtrace.pool,
        request.outtraceWorkspaceId!,
        incidentId,
      );
      requireClientAccess(request.outtraceOperator!, incident.client.id);
      return incident;
    },
  );

  app.patch(
    '/v1/incidents/:incidentId',
    { preHandler: (request) => authenticateOperatorRequest(request, app) },
    async (request) => {
      requireRole(request.outtraceOperator!, ['owner', 'operator']);
      const { incidentId } = parseOrThrow(paramsSchema, request.params);
      const existing = await getIncident(
        app.outtrace.pool,
        request.outtraceWorkspaceId!,
        incidentId,
      );
      requireClientAccess(request.outtraceOperator!, existing.client.id);
      const update = parseOrThrow(incidentStatusUpdateSchema, request.body);
      return updateIncident(
        app.outtrace.pool,
        request.outtraceWorkspaceId!,
        incidentId,
        update,
        request.outtraceOperator!.name,
      );
    },
  );

  app.post(
    '/v1/incidents/:incidentId/notes',
    { preHandler: (request) => authenticateOperatorRequest(request, app) },
    async (request, reply) => {
      requireRole(request.outtraceOperator!, ['owner', 'operator']);
      const { incidentId } = parseOrThrow(paramsSchema, request.params);
      const existing = await getIncident(
        app.outtrace.pool,
        request.outtraceWorkspaceId!,
        incidentId,
      );
      requireClientAccess(request.outtraceOperator!, existing.client.id);
      const note = parseOrThrow(incidentNoteCreateSchema, request.body);
      const incident = await addIncidentNote(
        app.outtrace.pool,
        request.outtraceWorkspaceId!,
        incidentId,
        { ...note, author: request.outtraceOperator!.name },
      );
      return reply.code(201).send(incident);
    },
  );

  app.put(
    '/v1/incidents/:incidentId/feedback',
    { preHandler: (request) => authenticateOperatorRequest(request, app) },
    async (request) => {
      requireRole(request.outtraceOperator!, ['owner', 'operator']);
      const { incidentId } = parseOrThrow(paramsSchema, request.params);
      const existing = await getIncident(
        app.outtrace.pool,
        request.outtraceWorkspaceId!,
        incidentId,
      );
      requireClientAccess(request.outtraceOperator!, existing.client.id);
      const incident = await recordIncidentFeedback(
        app.outtrace.pool,
        request.outtraceOperator!,
        incidentId,
        parseOrThrow(incidentFeedbackUpdateSchema, request.body),
      );
      return incident.feedback;
    },
  );
}
