import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

const mockFetch = vi.fn<typeof fetch>();

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mockFetch.mockReset();
});

describe('dashboard shell', () => {
  it('has an accessible Phase 4 application shell with pilot navigation', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: 'ok',
        service: 'outtrace-api',
        dependencies: {
          postgres: { status: 'up' },
          redis: { status: 'up' },
        },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);

    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pilot' })).toHaveAttribute('aria-current', 'location');
    expect(screen.getByRole('link', { name: 'Incidents' })).toHaveAttribute('href', '#incidents');
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(
      screen.getByRole('heading', { name: 'Connect. Verify. Learn.', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Current release phase: Phase 4')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Open the incident inbox' })).toBeInTheDocument();
  });
});

describe('agency operations', () => {
  it('renders owner controls and a client reliability report', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return jsonResponse({
          status: 'ok',
          service: 'outtrace-api',
          dependencies: {
            postgres: { status: 'up' },
            redis: { status: 'up' },
          },
        });
      }
      if (url.includes('/v1/incidents?')) {
        return jsonResponse({ total: 0, incidents: [] });
      }
      if (url.endsWith('/v1/session')) {
        return jsonResponse({
          workspaceId: 'workspace_1',
          memberId: 'member_1',
          name: 'Mina',
          role: 'owner',
          clientIds: null,
        });
      }
      if (url.endsWith('/v1/clients')) {
        return jsonResponse({
          clients: [
            {
              id: 'client_1',
              name: 'Acme',
              processCount: 2,
              openIncidentCount: 1,
              createdAt: '2026-07-24T01:00:00.000Z',
            },
          ],
        });
      }
      if (url.endsWith('/v1/processes')) {
        return jsonResponse({
          processes: [
            {
              id: 'process_1',
              key: 'onboarding',
              name: 'Client onboarding',
              clientId: 'client_1',
              clientName: 'Acme',
              environment: 'production',
              lifecycleStatus: 'active',
              slaSeconds: 900,
              metadataAllowlist: ['orderId', 'executionUrl'],
              stageCount: 2,
              connectionStatus: 'connected',
              eventCount: 10,
              connectedAt: '2026-07-24T01:05:00.000Z',
              lastEventAt: '2026-07-24T02:00:00.000Z',
              createdAt: '2026-07-24T01:00:00.000Z',
            },
          ],
        });
      }
      if (url.endsWith('/v1/pilot/summary')) {
        return jsonResponse({
          windowDays: 28,
          windowStartedAt: '2026-06-26T00:00:00.000Z',
          generatedAt: '2026-07-24T02:00:00.000Z',
          activation: {
            totalProcesses: 1,
            connectedProcesses: 1,
            awaitingFirstEvent: 0,
            connectionRate: 1,
            medianSecondsToFirstEvent: 300,
          },
          quality: {
            incidentsDetected: 2,
            reviewedIncidents: 2,
            genuineIncidents: 2,
            falsePositiveIncidents: 0,
            unreviewedIncidents: 0,
            falsePositiveRate: 0,
          },
          processes: [
            {
              id: 'process_1',
              key: 'onboarding',
              name: 'Client onboarding',
              clientId: 'client_1',
              clientName: 'Acme',
              connectionStatus: 'connected',
              eventCount: 10,
              connectedAt: '2026-07-24T01:05:00.000Z',
              lastEventAt: '2026-07-24T02:00:00.000Z',
            },
          ],
        });
      }
      if (url.endsWith('/v1/processes/process_1')) {
        return jsonResponse({
          id: 'process_1',
          key: 'onboarding',
          name: 'Client onboarding',
          clientId: 'client_1',
          clientName: 'Acme',
          environment: 'production',
          lifecycleStatus: 'archived',
          slaSeconds: 900,
          metadataAllowlist: ['orderId', 'executionUrl'],
          stageCount: 2,
          connectionStatus: 'connected',
          eventCount: 10,
          connectedAt: '2026-07-24T01:05:00.000Z',
          lastEventAt: '2026-07-24T02:00:00.000Z',
          createdAt: '2026-07-24T01:00:00.000Z',
        });
      }
      if (url.endsWith('/v1/members')) {
        return jsonResponse({
          members: [
            {
              id: 'member_1',
              name: 'Mina',
              email: 'mina@example.com',
              role: 'owner',
              status: 'active',
              clientIds: [],
              createdAt: '2026-07-24T01:00:00.000Z',
            },
          ],
        });
      }
      if (url.endsWith('/v1/workspace/settings')) {
        return jsonResponse({ eventRetentionDays: 30 });
      }
      if (url.endsWith('/v1/clients/client_1/report')) {
        return jsonResponse({
          client: { id: 'client_1', name: 'Acme' },
          totalInstances: 10,
          completedInstances: 9,
          completionRate: 0.9,
          incidentsDetected: 2,
          incidentsResolved: 1,
          medianResolutionSeconds: 300,
          mostUnreliableStage: { stage: 'provisioned', incidentCount: 2 },
        });
      }
      return jsonResponse({ error: { message: `Unexpected test request: ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);
    await user.type(screen.getByLabelText('Operator name'), 'Mina');
    await user.type(screen.getByLabelText('Operator key ID'), 'operator_1');
    await user.type(screen.getByLabelText('Operator key'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Open inbox' }));

    expect(
      await screen.findByRole('heading', { name: 'Clients, access & reporting' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Workspace administration')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Acme/ }));
    expect(await screen.findByText('90%')).toBeInTheDocument();
    expect(screen.getByText('provisioned · 2')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/Monitoring/), 'archived');
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    const lifecycleRequest = mockFetch.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith('/v1/processes/process_1') && init?.method === 'PATCH',
    );
    expect(JSON.parse(String(lifecycleRequest?.[1]?.body))).toMatchObject({
      lifecycleStatus: 'archived',
    });
  });
});

describe('Phase 4 pilot operations', () => {
  it('guides an owner through a production workflow connection and reveals the credential once', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/health')) {
        return jsonResponse({
          status: 'ok',
          service: 'outtrace-api',
          dependencies: {
            postgres: { status: 'up' },
            redis: { status: 'up' },
          },
        });
      }
      if (url.includes('/v1/incidents?')) {
        return jsonResponse({ total: 0, incidents: [] });
      }
      if (url.endsWith('/v1/session')) {
        return jsonResponse({
          workspaceId: 'workspace_1',
          memberId: 'member_1',
          name: 'Mina',
          role: 'owner',
          clientIds: null,
        });
      }
      if (url.endsWith('/v1/clients')) {
        return jsonResponse({
          clients: [
            {
              id: 'client_1',
              name: 'Acme',
              processCount: 0,
              openIncidentCount: 0,
              createdAt: '2026-07-24T01:00:00.000Z',
            },
          ],
        });
      }
      if (url.endsWith('/v1/processes') && method === 'POST') {
        return jsonResponse(
          {
            process: {
              id: 'process_1',
              key: 'client-onboarding',
              name: 'Client onboarding',
              clientId: 'client_1',
              clientName: 'Acme',
              environment: 'production',
              lifecycleStatus: 'active',
              slaSeconds: 900,
              metadataAllowlist: ['executionUrl'],
              stageCount: 2,
              connectionStatus: 'awaiting_first_event',
              eventCount: 0,
              connectedAt: null,
              lastEventAt: null,
              createdAt: '2026-07-24T01:00:00.000Z',
            },
            stages: [
              {
                id: 'stage_1',
                position: 0,
                key: 'payment_received',
                name: 'Payment received',
                required: true,
                timeoutSeconds: 300,
                source: 'make',
                owningTeam: 'Revenue ops',
              },
              {
                id: 'stage_2',
                position: 1,
                key: 'workspace_created',
                name: 'Workspace created',
                required: true,
                timeoutSeconds: 600,
                source: 'n8n',
                owningTeam: 'Automation ops',
              },
            ],
            credential: {
              keyId: 'ing_process_1',
              key: 'ing_secret_once',
              createdAt: '2026-07-24T01:00:00.000Z',
            },
          },
          201,
        );
      }
      if (url.endsWith('/v1/processes')) {
        return jsonResponse({ processes: [] });
      }
      if (url.endsWith('/v1/members')) {
        return jsonResponse({ members: [] });
      }
      if (url.endsWith('/v1/workspace/settings')) {
        return jsonResponse({ eventRetentionDays: 30 });
      }
      if (url.endsWith('/v1/pilot/summary')) {
        return jsonResponse({
          windowDays: 28,
          windowStartedAt: '2026-06-26T00:00:00.000Z',
          generatedAt: '2026-07-24T01:00:00.000Z',
          activation: {
            totalProcesses: 0,
            connectedProcesses: 0,
            awaitingFirstEvent: 0,
            connectionRate: 0,
            medianSecondsToFirstEvent: null,
          },
          quality: {
            incidentsDetected: 0,
            reviewedIncidents: 0,
            genuineIncidents: 0,
            falsePositiveIncidents: 0,
            unreviewedIncidents: 0,
            falsePositiveRate: null,
          },
          processes: [],
        });
      }
      return jsonResponse({ error: { message: `Unexpected test request: ${method} ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);
    await user.type(screen.getByLabelText('Operator name'), 'Mina');
    await user.type(screen.getByLabelText('Operator key ID'), 'operator_1');
    await user.type(screen.getByLabelText('Operator key'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Open inbox' }));

    await user.click(await screen.findByRole('button', { name: 'Connect production workflow' }));
    await user.selectOptions(screen.getByLabelText('Client'), 'client_1');
    await user.type(screen.getByLabelText('Process name'), 'Client onboarding');
    await user.type(screen.getByLabelText(/Process key/), 'client-onboarding');
    await user.type(screen.getByLabelText('End-to-end SLA (minutes)'), '15');
    await user.type(screen.getByLabelText(/Allowed metadata keys/), 'executionUrl');
    await user.type(screen.getByLabelText('Stage 1 name'), 'Payment received');
    await user.type(screen.getByLabelText('Stage 1 key'), 'payment_received');
    await user.selectOptions(screen.getByLabelText('Stage 1 source'), 'make');
    await user.type(screen.getByLabelText('Stage 1 timeout in minutes'), '5');
    await user.type(screen.getByLabelText('Stage 1 owning team'), 'Revenue ops');
    await user.click(screen.getByRole('button', { name: 'Add another stage' }));
    await user.type(screen.getByLabelText('Stage 2 name'), 'Workspace created');
    await user.type(screen.getByLabelText('Stage 2 key'), 'workspace_created');
    await user.type(screen.getByLabelText('Stage 2 timeout in minutes'), '10');
    await user.type(screen.getByLabelText('Stage 2 owning team'), 'Automation ops');
    await user.click(screen.getByRole('button', { name: 'Create workflow connection' }));

    expect(
      await screen.findByRole('heading', {
        name: 'Credential created. Send the first event.',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('ing_process_1')).toBeInTheDocument();
    expect(screen.getByText('ing_secret_once')).toBeInTheDocument();
    expect(screen.getByText('cURL')).toBeInTheDocument();
    expect(screen.getByText('n8n HTTP Request')).toBeInTheDocument();
    expect(screen.getByText('Make HTTP module')).toBeInTheDocument();

    const processRequest = mockFetch.mock.calls.find(
      ([input, init]) => String(input).endsWith('/v1/processes') && init?.method === 'POST',
    );
    expect(processRequest).toBeDefined();
    expect(JSON.parse(String(processRequest?.[1]?.body))).toMatchObject({
      clientId: 'client_1',
      key: 'client-onboarding',
      environment: 'production',
      slaSeconds: 900,
      metadataAllowlist: ['executionUrl'],
      stages: [
        {
          key: 'payment_received',
          source: 'make',
          timeoutSeconds: 300,
          owningTeam: 'Revenue ops',
        },
        {
          key: 'workspace_created',
          source: 'n8n',
          timeoutSeconds: 600,
          owningTeam: 'Automation ops',
        },
      ],
    });
  });

  it('saves false-positive feedback and re-fetches the incident detail', async () => {
    const user = userEvent.setup();
    let detailReads = 0;
    mockFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/health')) {
        return jsonResponse({
          status: 'ok',
          service: 'outtrace-api',
          dependencies: {
            postgres: { status: 'up' },
            redis: { status: 'up' },
          },
        });
      }
      if (url.includes('/v1/incidents?')) {
        return jsonResponse({
          total: 1,
          incidents: [
            {
              id: 'incident_1',
              incidentType: 'missing_stage',
              severity: 'high',
              status: 'resolved',
              affectedStage: 'workspace_created',
              technicalMessage: 'The expected stage did not arrive.',
              businessMessage: 'Client onboarding paused before workspace creation.',
              assignedTo: 'Mina',
              source: 'n8n',
              executionUrl: null,
              createdAt: '2026-07-24T01:00:00.000Z',
              updatedAt: '2026-07-24T01:10:00.000Z',
              acknowledgedAt: '2026-07-24T01:02:00.000Z',
              resolvedAt: '2026-07-24T01:10:00.000Z',
              client: { id: 'client_1', name: 'Acme' },
              process: {
                id: 'process_1',
                key: 'client-onboarding',
                name: 'Client onboarding',
              },
              instance: { id: 'instance_1', key: 'customer_4821', status: 'completed' },
            },
          ],
        });
      }
      if (url.endsWith('/v1/incidents/incident_1/feedback') && method === 'PUT') {
        return jsonResponse({
          incidentId: 'incident_1',
          verdict: 'false_positive',
          reason: 'timeout_too_short',
          note: 'The client approved a longer wait.',
          reviewedBy: 'Mina',
          createdAt: '2026-07-24T01:15:00.000Z',
          updatedAt: '2026-07-24T01:15:00.000Z',
        });
      }
      if (url.endsWith('/v1/incidents/incident_1')) {
        detailReads += 1;
        return jsonResponse({
          id: 'incident_1',
          incidentType: 'missing_stage',
          severity: 'high',
          status: 'resolved',
          affectedStage: 'workspace_created',
          technicalMessage: 'The expected stage did not arrive.',
          businessMessage: 'Client onboarding paused before workspace creation.',
          assignedTo: 'Mina',
          source: 'n8n',
          executionUrl: null,
          createdAt: '2026-07-24T01:00:00.000Z',
          updatedAt: '2026-07-24T01:10:00.000Z',
          acknowledgedAt: '2026-07-24T01:02:00.000Z',
          resolvedAt: '2026-07-24T01:10:00.000Z',
          client: { id: 'client_1', name: 'Acme' },
          process: {
            id: 'process_1',
            key: 'client-onboarding',
            name: 'Client onboarding',
          },
          instance: { id: 'instance_1', key: 'customer_4821', status: 'completed' },
          timeline: [],
          notes: [],
          feedback:
            detailReads > 1
              ? {
                  incidentId: 'incident_1',
                  verdict: 'false_positive',
                  reason: 'timeout_too_short',
                  note: 'The client approved a longer wait.',
                  reviewedBy: 'Mina',
                  createdAt: '2026-07-24T01:15:00.000Z',
                  updatedAt: '2026-07-24T01:15:00.000Z',
                }
              : null,
        });
      }
      if (url.endsWith('/v1/session')) {
        return jsonResponse({
          workspaceId: 'workspace_1',
          memberId: 'member_1',
          name: 'Mina',
          role: 'operator',
          clientIds: null,
        });
      }
      if (url.endsWith('/v1/clients')) {
        return jsonResponse({ clients: [] });
      }
      if (url.endsWith('/v1/processes')) {
        return jsonResponse({ processes: [] });
      }
      if (url.endsWith('/v1/pilot/summary')) {
        return jsonResponse({
          windowDays: 28,
          windowStartedAt: '2026-06-26T00:00:00.000Z',
          generatedAt: '2026-07-24T01:00:00.000Z',
          activation: {
            totalProcesses: 1,
            connectedProcesses: 1,
            awaitingFirstEvent: 0,
            connectionRate: 1,
            medianSecondsToFirstEvent: 300,
          },
          quality: {
            incidentsDetected: 1,
            reviewedIncidents: 0,
            genuineIncidents: 0,
            falsePositiveIncidents: 0,
            unreviewedIncidents: 1,
            falsePositiveRate: null,
          },
          processes: [],
        });
      }
      return jsonResponse({ error: { message: `Unexpected test request: ${method} ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);
    await user.type(screen.getByLabelText('Operator name'), 'Mina');
    await user.type(screen.getByLabelText('Operator key ID'), 'operator_1');
    await user.type(screen.getByLabelText('Operator key'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Open inbox' }));
    await user.click(
      await screen.findByRole('button', {
        name: /Client onboarding paused before workspace creation/,
      }),
    );

    await user.click(await screen.findByRole('radio', { name: /False positive/ }));
    await user.selectOptions(screen.getByLabelText('False-positive reason'), 'timeout_too_short');
    await user.type(
      screen.getByLabelText('Review note (optional)'),
      'The client approved a longer wait.',
    );
    await user.click(screen.getByRole('button', { name: 'Save classification' }));

    expect(await screen.findByText(/Reviewed by/)).toHaveTextContent('Mina');
    expect(detailReads).toBe(2);
    const feedbackRequest = mockFetch.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith('/v1/incidents/incident_1/feedback') && init?.method === 'PUT',
    );
    expect(JSON.parse(String(feedbackRequest?.[1]?.body))).toEqual({
      verdict: 'false_positive',
      reason: 'timeout_too_short',
      note: 'The client approved a longer wait.',
    });
  });

  it('keeps pilot metrics and incident classification read-only for viewers', async () => {
    const user = userEvent.setup();
    const incident = {
      id: 'incident_viewer',
      incidentType: 'reported_failure',
      severity: 'high',
      status: 'open',
      affectedStage: 'account_created',
      technicalMessage: 'A failed event was reported.',
      businessMessage: 'Account creation failed for a visible client.',
      assignedTo: null,
      source: 'n8n',
      executionUrl: null,
      createdAt: '2026-07-24T01:00:00.000Z',
      updatedAt: '2026-07-24T01:00:00.000Z',
      acknowledgedAt: null,
      resolvedAt: null,
      client: { id: 'client_1', name: 'Acme' },
      process: { id: 'process_1', key: 'onboarding', name: 'Client onboarding' },
      instance: { id: 'instance_1', key: 'customer_1', status: 'failed' },
    };
    mockFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return jsonResponse({
          status: 'ok',
          service: 'outtrace-api',
          dependencies: {
            postgres: { status: 'up' },
            redis: { status: 'up' },
          },
        });
      }
      if (url.includes('/v1/incidents?')) {
        return jsonResponse({ total: 1, incidents: [incident] });
      }
      if (url.endsWith('/v1/incidents/incident_viewer')) {
        return jsonResponse({ ...incident, timeline: [], notes: [], feedback: null });
      }
      if (url.endsWith('/v1/session')) {
        return jsonResponse({
          workspaceId: 'workspace_1',
          memberId: 'member_viewer',
          name: 'Client viewer',
          role: 'viewer',
          clientIds: ['client_1'],
        });
      }
      if (url.endsWith('/v1/clients')) {
        return jsonResponse({ clients: [] });
      }
      if (url.endsWith('/v1/processes')) {
        return jsonResponse({ processes: [] });
      }
      return jsonResponse({ error: { message: `Unexpected test request: ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);
    await user.type(screen.getByLabelText('Operator name'), 'Client viewer');
    await user.type(screen.getByLabelText('Operator key ID'), 'viewer_1');
    await user.type(screen.getByLabelText('Operator key'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Open inbox' }));

    expect(
      await screen.findByText(/Pilot-wide metrics are available to workspace owners and operators/),
    ).toBeInTheDocument();
    expect(
      mockFetch.mock.calls.some(([input]) => String(input).endsWith('/v1/pilot/summary')),
    ).toBe(false);
    await user.click(
      screen.getByRole('button', {
        name: /Account creation failed for a visible client/,
      }),
    );
    expect(
      await screen.findByText(/Incident classification is read-only for viewers/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /False positive/ })).not.toBeInTheDocument();
  });
});

describe('incident operations', () => {
  it('authenticates an operator and renders a filterable incident', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'ok',
          service: 'outtrace-api',
          dependencies: {
            postgres: { status: 'up' },
            redis: { status: 'up' },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          total: 1,
          incidents: [
            {
              id: 'incident_1',
              incidentType: 'reported_failure',
              severity: 'high',
              status: 'open',
              affectedStage: 'account_created',
              technicalMessage: 'n8n reported a failed event.',
              businessMessage: 'Account creation failed for customer 4821.',
              assignedTo: null,
              source: 'n8n',
              executionUrl: 'https://n8n.example.com/execution/1',
              createdAt: '2026-07-24T01:00:00.000Z',
              updatedAt: '2026-07-24T01:00:00.000Z',
              acknowledgedAt: null,
              resolvedAt: null,
              client: { id: 'client_1', name: 'Acme' },
              process: { id: 'process_1', key: 'onboarding', name: 'Client onboarding' },
              instance: { id: 'instance_1', key: 'customer_4821', status: 'failed' },
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);
    await user.type(screen.getByLabelText('Operator name'), 'Mina');
    await user.type(screen.getByLabelText('Operator key ID'), 'operator_1');
    await user.type(screen.getByLabelText('Operator key'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Open inbox' }));

    expect(
      await screen.findByText('Account creation failed for customer 4821.'),
    ).toBeInTheDocument();
    expect(screen.getByText('1 incident shown')).toBeInTheDocument();
    expect(mockFetch.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        'x-outtrace-operator-key-id': 'operator_1',
        'x-outtrace-operator-name': 'Mina',
      }),
    });
  });
});

describe('dependency health', () => {
  it('shows honest loading states before the request completes', () => {
    mockFetch.mockReturnValueOnce(new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);

    const list = screen.getByRole('list', { name: 'Service health' });
    expect(within(list).getAllByText('Checking')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Checking API, PostgreSQL, and Redis.');
  });

  it('times out a stalled check and allows an operator to retry', async () => {
    vi.useFakeTimers();
    mockFetch.mockReturnValueOnce(new Promise<Response>(() => undefined)).mockResolvedValueOnce(
      jsonResponse({
        status: 'ok',
        service: 'outtrace-api',
        dependencies: {
          postgres: { status: 'up' },
          redis: { status: 'up' },
        },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    vi.useRealTimers();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The health check timed out after 5 seconds.',
    );
    const retry = screen.getByRole('button', { name: 'Run check' });
    expect(retry).toBeEnabled();

    await act(async () => {
      retry.click();
      await Promise.resolve();
    });

    expect(
      await screen.findByText('Dependency check complete. All three services are up.'),
    ).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('shows API, PostgreSQL, and Redis as up after a successful check', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: 'ok',
        service: 'outtrace-api',
        dependencies: {
          postgres: { status: 'up' },
          redis: { status: 'up' },
        },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);

    expect(
      await screen.findByText('Dependency check complete. All three services are up.'),
    ).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Service health' });
    expect(within(list).getAllByText('Up')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Run check' })).toBeEnabled();
  });

  it('reports a degraded stack without hiding the affected service', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: 'degraded',
        service: 'outtrace-api',
        dependencies: {
          postgres: { status: 'up' },
          redis: { status: 'down' },
        },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);

    const list = screen.getByRole('list', { name: 'Service health' });
    expect(await within(list).findByText('Down')).toBeInTheDocument();
    expect(within(list).getByText('Redis')).toBeInTheDocument();
    expect(screen.getByText('Redis did not pass its connection check.')).toBeInTheDocument();
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('shows unavailable dependencies when the API cannot be reached', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Health endpoint unavailable');
    const list = screen.getByRole('list', { name: 'Service health' });
    expect(within(list).getByText('Down')).toBeInTheDocument();
    expect(within(list).getAllByText('Unavailable')).toHaveLength(2);
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument();
  });

  it('allows an operator to manually rerun the check', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'degraded',
          service: 'outtrace-api',
          dependencies: {
            postgres: { status: 'up' },
            redis: { status: 'down' },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'ok',
          service: 'outtrace-api',
          dependencies: {
            postgres: { status: 'up' },
            redis: { status: 'up' },
          },
        }),
      );
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);
    await screen.findByText('Redis did not pass its connection check.');

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Run check' }));
    });

    expect(
      await screen.findByText('Dependency check complete. All three services are up.'),
    ).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
