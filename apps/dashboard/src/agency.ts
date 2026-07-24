import {
  clientReliabilityReportSchema,
  clientSummarySchema,
  memberInviteResponseSchema,
  memberSummarySchema,
  operatorSessionSchema,
  processSummarySchema,
  workspaceSettingsSchema,
  type ClientCreate,
  type ClientReliabilityReport,
  type ClientSummary,
  type MemberInvite,
  type MemberInviteResponse,
  type MemberSummary,
  type MemberUpdate,
  type OperatorSession as AgencySession,
  type ProcessSummary,
  type ProcessUpdate,
  type WorkspaceSettings,
} from '@outtrace/contracts';

import {
  operatorHeaders,
  responseJson,
  type OperatorSession as OperatorCredentials,
} from './incidents';

function collection(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || !(key in value)) {
    throw new Error(`The API response did not include ${key}.`);
  }
  return value[key as keyof typeof value];
}

async function request(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...operatorHeaders(credentials),
      ...init.headers,
    },
  });
  return responseJson(response);
}

export async function fetchAgencySession(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
): Promise<AgencySession> {
  return operatorSessionSchema.parse(await request(apiBaseUrl, credentials, '/v1/session'));
}

export async function fetchClients(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
): Promise<ClientSummary[]> {
  const body = await request(apiBaseUrl, credentials, '/v1/clients');
  return clientSummarySchema.array().parse(collection(body, 'clients'));
}

export async function createClient(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
  input: ClientCreate,
): Promise<ClientSummary> {
  return clientSummarySchema.parse(
    await request(apiBaseUrl, credentials, '/v1/clients', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchMembers(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
): Promise<MemberSummary[]> {
  const body = await request(apiBaseUrl, credentials, '/v1/members');
  return memberSummarySchema.array().parse(collection(body, 'members'));
}

export async function inviteMember(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
  input: MemberInvite,
): Promise<MemberInviteResponse> {
  return memberInviteResponseSchema.parse(
    await request(apiBaseUrl, credentials, '/v1/members', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  );
}

export async function updateMember(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
  memberId: string,
  input: MemberUpdate,
): Promise<MemberSummary> {
  return memberSummarySchema.parse(
    await request(apiBaseUrl, credentials, `/v1/members/${encodeURIComponent(memberId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchProcesses(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
): Promise<ProcessSummary[]> {
  const body = await request(apiBaseUrl, credentials, '/v1/processes');
  return processSummarySchema.array().parse(collection(body, 'processes'));
}

export async function updateProcess(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
  processId: string,
  input: ProcessUpdate,
): Promise<ProcessSummary> {
  return processSummarySchema.parse(
    await request(apiBaseUrl, credentials, `/v1/processes/${encodeURIComponent(processId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchWorkspaceSettings(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
): Promise<WorkspaceSettings> {
  return workspaceSettingsSchema.parse(
    await request(apiBaseUrl, credentials, '/v1/workspace/settings'),
  );
}

export async function updateWorkspaceSettings(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
  input: WorkspaceSettings,
): Promise<WorkspaceSettings> {
  return workspaceSettingsSchema.parse(
    await request(apiBaseUrl, credentials, '/v1/workspace/settings', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchClientReport(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
  clientId: string,
): Promise<ClientReliabilityReport> {
  return clientReliabilityReportSchema.parse(
    await request(apiBaseUrl, credentials, `/v1/clients/${encodeURIComponent(clientId)}/report`),
  );
}
