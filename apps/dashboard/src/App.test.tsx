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
  it('has an accessible application shell with future areas unavailable', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: 'ok',
        service: 'openflow-api',
        dependencies: {
          postgres: { status: 'up' },
          redis: { status: 'up' },
        },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    render(<App />);

    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Processes').closest('[aria-disabled]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('Incidents').closest('[aria-disabled]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(
      screen.getByRole('heading', { name: 'Operational readiness', level: 1 }),
    ).toBeInTheDocument();
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
    expect(screen.getByText('No completed check')).toBeInTheDocument();
  });

  it('times out a stalled check and allows an operator to retry', async () => {
    vi.useFakeTimers();
    mockFetch.mockReturnValueOnce(new Promise<Response>(() => undefined)).mockResolvedValueOnce(
      jsonResponse({
        status: 'ok',
        service: 'openflow-api',
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
        service: 'openflow-api',
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
        service: 'openflow-api',
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
          service: 'openflow-api',
          dependencies: {
            postgres: { status: 'up' },
            redis: { status: 'down' },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'ok',
          service: 'openflow-api',
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
