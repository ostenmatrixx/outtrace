import type { FastifyInstance } from 'fastify';

import { getPilotSummary } from '../pilot-store.js';
import { authenticateOperatorRequest, requireRole } from '../operator-access.js';

export async function registerPilotRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/pilot/summary',
    { preHandler: (request) => authenticateOperatorRequest(request, app) },
    async (request) => {
      requireRole(request.outtraceOperator!, ['owner', 'operator']);
      return getPilotSummary(app.outtrace.pool, request.outtraceWorkspaceId!);
    },
  );
}
