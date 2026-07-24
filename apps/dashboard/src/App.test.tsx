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
  window.sessionStorage.clear();
});

describe('dashboard shell', () => {
  it('has an accessible Phase 2 application shell with an incident inbox', async () => {
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
    expect(screen.getByRole('link', { name: 'Incidents' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Reports').closest('[aria-disabled]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(
      screen.getByRole('heading', { name: 'See the broken handoff.', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Open the incident inbox' })).toBeInTheDocument();
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
