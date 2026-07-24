import {
  incidentDetailSchema,
  incidentListResponseSchema,
  type IncidentDetail,
  type IncidentListResponse,
  type IncidentNoteCreate,
  type IncidentStatusUpdate,
} from '@outtrace/contracts';

export interface OperatorSession {
  keyId: string;
  key: string;
  name: string;
}

const SESSION_KEY = 'outtrace.operator-session';

export function loadOperatorSession(): OperatorSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<OperatorSession>;
    if (!value.keyId || !value.key || !value.name) return null;
    return { keyId: value.keyId, key: value.key, name: value.name };
  } catch {
    return null;
  }
}

export function saveOperatorSession(session: OperatorSession | null): void {
  if (session) {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    window.sessionStorage.removeItem(SESSION_KEY);
  }
}

function headers(session: OperatorSession): HeadersInit {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-outtrace-operator-key-id': session.keyId,
    'x-outtrace-operator-key': session.key,
    'x-outtrace-operator-name': session.name,
  };
}

async function responseJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body &&
      typeof body === 'object' &&
      'error' in body &&
      body.error &&
      typeof body.error === 'object' &&
      'message' in body.error &&
      typeof body.error.message === 'string'
        ? body.error.message
        : `Request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body;
}

export async function fetchIncidents(
  apiBaseUrl: string,
  session: OperatorSession,
  filters: {
    severity?: string | undefined;
    status?: string | undefined;
    type?: string | undefined;
  } = {},
): Promise<IncidentListResponse> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  const response = await fetch(`${apiBaseUrl}/v1/incidents?${query}`, {
    headers: headers(session),
  });
  return incidentListResponseSchema.parse(await responseJson(response));
}

export async function fetchIncident(
  apiBaseUrl: string,
  session: OperatorSession,
  incidentId: string,
): Promise<IncidentDetail> {
  const response = await fetch(`${apiBaseUrl}/v1/incidents/${encodeURIComponent(incidentId)}`, {
    headers: headers(session),
  });
  return incidentDetailSchema.parse(await responseJson(response));
}

export async function patchIncident(
  apiBaseUrl: string,
  session: OperatorSession,
  incidentId: string,
  update: IncidentStatusUpdate,
): Promise<IncidentDetail> {
  const response = await fetch(`${apiBaseUrl}/v1/incidents/${encodeURIComponent(incidentId)}`, {
    method: 'PATCH',
    headers: headers(session),
    body: JSON.stringify(update),
  });
  return incidentDetailSchema.parse(await responseJson(response));
}

export async function postIncidentNote(
  apiBaseUrl: string,
  session: OperatorSession,
  incidentId: string,
  note: IncidentNoteCreate,
): Promise<IncidentDetail> {
  const response = await fetch(
    `${apiBaseUrl}/v1/incidents/${encodeURIComponent(incidentId)}/notes`,
    {
      method: 'POST',
      headers: headers(session),
      body: JSON.stringify(note),
    },
  );
  return incidentDetailSchema.parse(await responseJson(response));
}
