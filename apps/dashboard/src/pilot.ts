import {
  pilotSummarySchema,
  processCreateResponseSchema,
  processCredentialResponseSchema,
  type PilotSummary,
  type ProcessCreate,
  type ProcessCreateResponse,
  type ProcessCredentialResponse,
} from '@outtrace/contracts';

import {
  operatorHeaders,
  responseJson,
  type OperatorSession as OperatorCredentials,
} from './incidents';

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

export async function createProcess(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
  input: ProcessCreate,
): Promise<ProcessCreateResponse> {
  return processCreateResponseSchema.parse(
    await request(apiBaseUrl, credentials, '/v1/processes', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  );
}

export async function createProcessCredential(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
  processId: string,
): Promise<ProcessCredentialResponse> {
  return processCredentialResponseSchema.parse(
    await request(
      apiBaseUrl,
      credentials,
      `/v1/processes/${encodeURIComponent(processId)}/credentials`,
      { method: 'POST' },
    ),
  );
}

export async function fetchPilotSummary(
  apiBaseUrl: string,
  credentials: OperatorCredentials,
): Promise<PilotSummary> {
  return pilotSummarySchema.parse(await request(apiBaseUrl, credentials, '/v1/pilot/summary'));
}
