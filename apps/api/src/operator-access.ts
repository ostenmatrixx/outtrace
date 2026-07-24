import type { WorkspaceRole } from '@outtrace/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  authenticateOperatorPrincipal,
  readOperatorCredentials,
  type OperatorPrincipal,
} from './authentication.js';
import { authorizationForbidden } from './errors.js';

export async function authenticateOperatorRequest(
  request: FastifyRequest,
  app: FastifyInstance,
): Promise<void> {
  const principal = await authenticateOperatorPrincipal(
    app.outtrace.pool,
    readOperatorCredentials(request),
  );
  request.outtraceWorkspaceId = principal.workspaceId;
  request.outtraceOperator = principal;
}

export function requireRole(
  principal: OperatorPrincipal,
  roles: WorkspaceRole[],
): OperatorPrincipal {
  if (!roles.includes(principal.role)) {
    throw authorizationForbidden();
  }
  return principal;
}

export function requireClientAccess(principal: OperatorPrincipal, clientId: string): void {
  if (principal.clientIds !== null && !principal.clientIds.includes(clientId)) {
    throw authorizationForbidden();
  }
}
