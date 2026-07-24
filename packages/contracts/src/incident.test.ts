import { describe, expect, it } from 'vitest';

import {
  incidentNoteCreateSchema,
  incidentStatusUpdateSchema,
  incidentSummarySchema,
} from './incident.js';

describe('incident contracts', () => {
  it('accepts an incident summary with explicit business context', () => {
    expect(
      incidentSummarySchema.parse({
        id: 'incident_1',
        incidentType: 'reported_failure',
        severity: 'high',
        status: 'open',
        affectedStage: 'account_created',
        technicalMessage: 'A failed event was reported.',
        businessMessage: 'Account creation failed.',
        assignedTo: null,
        source: 'n8n',
        executionUrl: 'https://n8n.example.com/execution/1',
        createdAt: '2026-07-24T01:00:00.000Z',
        updatedAt: '2026-07-24T01:00:00.000Z',
        acknowledgedAt: null,
        resolvedAt: null,
        client: { id: 'client_1', name: 'Acme' },
        process: { id: 'process_1', key: 'onboarding', name: 'Client onboarding' },
        instance: { id: 'instance_1', key: 'customer_1', status: 'failed' },
      }),
    ).toMatchObject({ id: 'incident_1', severity: 'high' });
  });

  it('requires a meaningful status or assignment update', () => {
    expect(incidentStatusUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      incidentStatusUpdateSchema.parse({ status: 'acknowledged', assignedTo: 'Mina' }),
    ).toEqual({
      status: 'acknowledged',
      assignedTo: 'Mina',
    });
  });

  it('trims and bounds incident notes', () => {
    expect(
      incidentNoteCreateSchema.parse({ author: '  Mina  ', body: '  Investigating  ' }),
    ).toEqual({
      author: 'Mina',
      body: 'Investigating',
    });
  });
});
