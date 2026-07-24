import {
  clientCreateSchema,
  memberInviteSchema,
  memberUpdateSchema,
  processUpdateSchema,
  workspaceSettingsSchema,
} from '@outtrace/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  createClient,
  getClientReliabilityReport,
  getWorkspaceSettings,
  inviteMember,
  listClients,
  listMembers,
  listProcesses,
  updateMember,
  updateProcess,
  updateWorkspaceSettings,
} from '../agency-store.js';
import { HttpError } from '../errors.js';
import {
  authenticateOperatorRequest,
  requireClientAccess,
  requireRole,
} from '../operator-access.js';

const clientParamsSchema = z.object({ clientId: z.string().min(1).max(200) });
const memberParamsSchema = z.object({ memberId: z.string().min(1).max(200) });
const processParamsSchema = z.object({ processId: z.string().min(1).max(200) });

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_PAYLOAD', 'The agency request is invalid.', {
      issues: parsed.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path,
      })),
    });
  }
  return parsed.data;
}

export async function registerAgencyRoutes(app: FastifyInstance): Promise<void> {
  const authenticated = (request: Parameters<typeof authenticateOperatorRequest>[0]) =>
    authenticateOperatorRequest(request, app);

  app.get('/v1/session', { preHandler: authenticated }, async (request) => {
    const principal = request.outtraceOperator!;
    return {
      workspaceId: principal.workspaceId,
      memberId: principal.memberId,
      name: principal.name,
      role: principal.role,
      clientIds: principal.clientIds,
    };
  });

  app.get('/v1/clients', { preHandler: authenticated }, async (request) => ({
    clients: await listClients(app.outtrace.pool, request.outtraceOperator!),
  }));

  app.post('/v1/clients', { preHandler: authenticated }, async (request, reply) => {
    requireRole(request.outtraceOperator!, ['owner']);
    const client = await createClient(
      app.outtrace.pool,
      request.outtraceOperator!,
      parseOrThrow(clientCreateSchema, request.body),
    );
    return reply.code(201).send(client);
  });

  app.get('/v1/clients/:clientId/report', { preHandler: authenticated }, async (request) => {
    const { clientId } = parseOrThrow(clientParamsSchema, request.params);
    requireClientAccess(request.outtraceOperator!, clientId);
    return getClientReliabilityReport(app.outtrace.pool, request.outtraceWorkspaceId!, clientId);
  });

  app.get('/v1/members', { preHandler: authenticated }, async (request) => {
    requireRole(request.outtraceOperator!, ['owner']);
    return { members: await listMembers(app.outtrace.pool, request.outtraceWorkspaceId!) };
  });

  app.post('/v1/members', { preHandler: authenticated }, async (request, reply) => {
    requireRole(request.outtraceOperator!, ['owner']);
    const invitation = await inviteMember(
      app.outtrace.pool,
      request.outtraceOperator!,
      parseOrThrow(memberInviteSchema, request.body),
    );
    return reply.code(201).send(invitation);
  });

  app.patch('/v1/members/:memberId', { preHandler: authenticated }, async (request) => {
    requireRole(request.outtraceOperator!, ['owner']);
    const { memberId } = parseOrThrow(memberParamsSchema, request.params);
    return updateMember(
      app.outtrace.pool,
      request.outtraceOperator!,
      memberId,
      parseOrThrow(memberUpdateSchema, request.body),
    );
  });

  app.get('/v1/processes', { preHandler: authenticated }, async (request) => ({
    processes: await listProcesses(app.outtrace.pool, request.outtraceOperator!),
  }));

  app.patch('/v1/processes/:processId', { preHandler: authenticated }, async (request) => {
    requireRole(request.outtraceOperator!, ['owner']);
    const { processId } = parseOrThrow(processParamsSchema, request.params);
    return updateProcess(
      app.outtrace.pool,
      request.outtraceOperator!,
      processId,
      parseOrThrow(processUpdateSchema, request.body),
    );
  });

  app.get('/v1/workspace/settings', { preHandler: authenticated }, async (request) => {
    requireRole(request.outtraceOperator!, ['owner']);
    return getWorkspaceSettings(app.outtrace.pool, request.outtraceWorkspaceId!);
  });

  app.patch('/v1/workspace/settings', { preHandler: authenticated }, async (request) => {
    requireRole(request.outtraceOperator!, ['owner']);
    return updateWorkspaceSettings(
      app.outtrace.pool,
      request.outtraceOperator!,
      parseOrThrow(workspaceSettingsSchema, request.body),
    );
  });
}
