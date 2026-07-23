import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type HealthSnapshot,
  type ServiceHealth,
  type ServiceState,
  loadingSnapshot,
  parseHealthPayload,
  unavailableSnapshot,
} from './health';

const STATUS_LABELS: Record<ServiceState, string> = {
  loading: 'Checking',
  up: 'Up',
  degraded: 'Degraded',
  down: 'Down',
  unavailable: 'Unavailable',
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const healthUrl = `${apiBaseUrl}/health`;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

function abortError(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function fetchHealthSnapshot(signal?: AbortSignal): Promise<HealthSnapshot> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = window.setTimeout(() => {
    controller.abort(new DOMException('Health check timed out.', 'TimeoutError'));
  }, HEALTH_REQUEST_TIMEOUT_MS);

  try {
    const response = await Promise.race([
      fetch(healthUrl, {
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      }),
      abortError(controller.signal),
    ]);

    if (!response.ok) {
      throw new Error(`Health endpoint returned HTTP ${response.status}.`);
    }

    const payload: unknown = await response.json();
    return parseHealthPayload(payload);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error('The health check timed out after 5 seconds.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function snapshotForError(error: unknown): HealthSnapshot {
  return unavailableSnapshot(
    error instanceof Error ? error.message : 'The health check failed for an unknown reason.',
  );
}

function StatusMark({ state }: { state: ServiceState }) {
  return (
    <span className="status-mark" data-state={state}>
      <span className="status-mark__symbol" aria-hidden="true">
        {state === 'up' ? '✓' : state === 'loading' ? '…' : state === 'degraded' ? '!' : '×'}
      </span>
      <span>{STATUS_LABELS[state]}</span>
    </span>
  );
}

function ServiceRow({ service }: { service: ServiceHealth }) {
  return (
    <li className="service-row">
      <div className="service-row__identity">
        <span className="service-row__rail" data-state={service.state} />
        <div>
          <h3>{service.name}</h3>
          <p>{service.detail}</p>
        </div>
      </div>
      <StatusMark state={service.state} />
    </li>
  );
}

function ShellNavigation() {
  return (
    <aside className="sidebar" aria-label="Application sidebar">
      <div className="brand">
        <span className="brand__signal" aria-hidden="true">
          OF
        </span>
        <div>
          <span className="brand__name">OpenFlow</span>
          <span className="brand__descriptor">Process operations</span>
        </div>
      </div>

      <nav aria-label="Primary navigation">
        <p className="nav-label">Workspace</p>
        <ul className="nav-list">
          <li>
            <a className="nav-item nav-item--active" href="#overview" aria-current="page">
              <span aria-hidden="true">01</span>
              Overview
            </a>
          </li>
          <li>
            <span className="nav-item nav-item--unavailable" aria-disabled="true">
              <span aria-hidden="true">02</span>
              Processes
              <small>Phase 2</small>
            </span>
          </li>
          <li>
            <span className="nav-item nav-item--unavailable" aria-disabled="true">
              <span aria-hidden="true">03</span>
              Incidents
              <small>Phase 2</small>
            </span>
          </li>
        </ul>
      </nav>

      <div className="sidebar__footer">
        <span>Foundation</span>
        <strong>Phase 1</strong>
      </div>
    </aside>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot>(loadingSnapshot);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const activeRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  const requestHealth = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;

    try {
      const result = await fetchHealthSnapshot(controller.signal);
      if (mounted.current && activeRequest.current === controller) {
        setSnapshot(result);
      }
    } catch (error) {
      if (!controller.signal.aborted && mounted.current && activeRequest.current === controller) {
        setSnapshot(snapshotForError(error));
      }
    } finally {
      if (mounted.current && activeRequest.current === controller) {
        activeRequest.current = null;
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => {
      if (mounted.current) {
        void requestHealth();
      }
    });

    return () => {
      mounted.current = false;
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [requestHealth]);

  const liveMessage = useMemo(() => {
    if (snapshot.overall === 'loading') {
      return 'Checking API, PostgreSQL, and Redis.';
    }

    if (snapshot.overall === 'up') {
      return 'Dependency check complete. All three services are up.';
    }

    if (snapshot.overall === 'down') {
      return 'Dependency check failed. The API is down.';
    }

    const issueCount = snapshot.services.filter((service) => service.state !== 'up').length;
    return `Dependency check complete. ${issueCount} ${
      issueCount === 1 ? 'service needs' : 'services need'
    } attention.`;
  }, [snapshot]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <ShellNavigation />

      <main id="main-content" className="main-content">
        <header className="page-header" id="overview">
          <div>
            <p className="eyebrow">Development environment / Overview</p>
            <h1>Operational readiness</h1>
            <p className="page-header__intro">
              A direct view of whether the Phase 1 application stack can accept work. No process or
              incident data is shown yet.
            </p>
          </div>
          <div className="phase-stamp" aria-label="Current release phase: Phase 1">
            <span>Release state</span>
            <strong>PHASE / 01</strong>
          </div>
        </header>

        <section className="health-panel" aria-labelledby="health-title" aria-busy={isRefreshing}>
          <div className="health-panel__header">
            <div>
              <p className="section-index">SYSTEM CHECK 001</p>
              <h2 id="health-title">Dependency health</h2>
              <p>
                Live reachability from the dashboard to the API and its required infrastructure.
              </p>
            </div>

            <div className="health-panel__controls">
              <StatusMark state={snapshot.overall} />
              <button
                className="refresh-button"
                type="button"
                onClick={() => {
                  setIsRefreshing(true);
                  void requestHealth();
                }}
                disabled={isRefreshing}
              >
                <span aria-hidden="true">{isRefreshing ? '↻' : '→'}</span>
                {isRefreshing ? 'Checking…' : 'Run check'}
              </button>
            </div>
          </div>

          <p className="sr-only" role="status" aria-live="polite">
            {liveMessage}
          </p>

          {snapshot.error ? (
            <div className="error-banner" role="alert">
              <strong>Health endpoint unavailable</strong>
              <span>{snapshot.error}</span>
            </div>
          ) : null}

          <ul className="service-list" aria-label="Service health">
            {snapshot.services.map((service) => (
              <ServiceRow key={service.name} service={service} />
            ))}
          </ul>

          <div className="health-panel__footer">
            <div>
              <span className="meta-label">Endpoint</span>
              <code>{healthUrl}</code>
            </div>
            <div>
              <span className="meta-label">Last completed check</span>
              <span>
                {snapshot.checkedAt
                  ? snapshot.checkedAt.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })
                  : 'No completed check'}
              </span>
            </div>
          </div>
        </section>

        <aside className="scope-note" aria-labelledby="scope-title">
          <p className="section-index">PHASE 1 SCOPE</p>
          <h2 id="scope-title">What this check proves</h2>
          <p>
            A successful result means the dashboard can reach the API, and the API can reach
            PostgreSQL and Redis. It does not verify event ingestion, process correlation, or
            incident detection.
          </p>
        </aside>
      </main>
    </div>
  );
}
