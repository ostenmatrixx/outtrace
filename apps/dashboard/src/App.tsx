import type {
  IncidentDetail,
  IncidentSeverity,
  IncidentStatus,
  IncidentSummary,
  IncidentType,
} from '@outtrace/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  type HealthSnapshot,
  type ServiceHealth,
  type ServiceState,
  loadingSnapshot,
  parseHealthPayload,
  unavailableSnapshot,
} from './health';
import {
  fetchIncident,
  fetchIncidents,
  loadOperatorSession,
  patchIncident,
  postIncidentNote,
  saveOperatorSession,
  type OperatorSession,
} from './incidents';

const STATUS_LABELS: Record<ServiceState, string> = {
  loading: 'Checking',
  up: 'Up',
  degraded: 'Degraded',
  down: 'Down',
  unavailable: 'Unavailable',
};

const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  reported_failure: 'Reported failure',
  missing_stage: 'Missing stage',
  sla_violation: 'SLA violation',
  unexpected_sequence: 'Unexpected sequence',
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const healthUrl = `${apiBaseUrl}/health`;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

type DashboardFilters = {
  status?: IncidentStatus | undefined;
  severity?: IncidentSeverity | undefined;
  type?: IncidentType | undefined;
};

function abortError(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
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
      fetch(healthUrl, { headers: { Accept: 'application/json' }, signal: controller.signal }),
      abortError(controller.signal),
    ]);
    if (!response.ok) throw new Error(`Health endpoint returned HTTP ${response.status}.`);
    return parseHealthPayload(await response.json());
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
          OT
        </span>
        <div>
          <span className="brand__name">Outtrace</span>
          <span className="brand__descriptor">Process operations</span>
        </div>
      </div>
      <nav aria-label="Primary navigation">
        <p className="nav-label">Workspace</p>
        <ul className="nav-list">
          <li>
            <a className="nav-item" href="#overview">
              <span aria-hidden="true">01</span>
              Overview
            </a>
          </li>
          <li>
            <a className="nav-item nav-item--active" href="#incidents" aria-current="page">
              <span aria-hidden="true">02</span>
              Incidents
            </a>
          </li>
          <li>
            <span className="nav-item nav-item--unavailable" aria-disabled="true">
              <span aria-hidden="true">03</span>
              Reports
              <small>Phase 3</small>
            </span>
          </li>
        </ul>
      </nav>
      <div className="sidebar__footer">
        <span>Incident operations</span>
        <strong>Phase 2</strong>
      </div>
    </aside>
  );
}

function OperatorLogin({
  error,
  onSubmit,
}: {
  error: string | null;
  onSubmit: (session: OperatorSession) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await onSubmit({
        keyId: String(data.get('keyId') ?? ''),
        key: String(data.get('key') ?? ''),
        name: String(data.get('name') ?? ''),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="operator-login" onSubmit={(event) => void submit(event)}>
      <div>
        <p className="section-index">SECURE OPERATOR ACCESS</p>
        <h2>Open the incident inbox</h2>
        <p>
          Operator credentials are kept only in this browser tab and never compiled into the app.
        </p>
      </div>
      <label>
        Operator name
        <input name="name" required maxLength={120} autoComplete="name" />
      </label>
      <label>
        Operator key ID
        <input name="keyId" required autoComplete="username" />
      </label>
      <label>
        Operator key
        <input name="key" type="password" required autoComplete="current-password" />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="refresh-button" type="submit" disabled={busy}>
        {busy ? 'Opening…' : 'Open inbox'}
      </button>
    </form>
  );
}

function IncidentListItem({
  incident,
  selected,
  onSelect,
}: {
  incident: IncidentSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        className="incident-row"
        data-selected={selected}
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
      >
        <span className="severity-badge" data-severity={incident.severity}>
          {incident.severity}
        </span>
        <span>
          <strong>{incident.businessMessage}</strong>
          <small>
            {incident.client.name} / {incident.process.name} / {incident.instance.key}
          </small>
        </span>
        <span className="incident-row__meta">
          {INCIDENT_TYPE_LABELS[incident.incidentType]}
          <small>{new Date(incident.createdAt).toLocaleString()}</small>
        </span>
      </button>
    </li>
  );
}

function IncidentDetailPanel({
  incident,
  busy,
  onUpdate,
  onNote,
}: {
  incident: IncidentDetail | null;
  busy: boolean;
  onUpdate: (update: { status?: 'acknowledged' | 'resolved'; assignedTo?: string | null }) => void;
  onNote: (body: string) => void;
}) {
  const [assignee, setAssignee] = useState(incident?.assignedTo ?? '');
  const [note, setNote] = useState('');
  if (!incident) {
    return (
      <div className="incident-empty">
        Select an incident to inspect its cross-platform timeline.
      </div>
    );
  }
  return (
    <article className="incident-detail" aria-live="polite">
      <header>
        <div>
          <span className="severity-badge" data-severity={incident.severity}>
            {incident.severity}
          </span>
          <h2>{incident.businessMessage}</h2>
          <p>{incident.technicalMessage}</p>
        </div>
        <span className="state-badge">{incident.status}</span>
      </header>
      <dl className="incident-facts">
        <div>
          <dt>Client</dt>
          <dd>{incident.client.name}</dd>
        </div>
        <div>
          <dt>Process</dt>
          <dd>{incident.process.name}</dd>
        </div>
        <div>
          <dt>Instance</dt>
          <dd>{incident.instance.key}</dd>
        </div>
        <div>
          <dt>Affected stage</dt>
          <dd>{incident.affectedStage ?? 'Whole process'}</dd>
        </div>
      </dl>
      <div className="incident-actions">
        <button
          type="button"
          onClick={() => onUpdate({ status: 'acknowledged' })}
          disabled={busy || incident.status !== 'open'}
        >
          Acknowledge
        </button>
        <button
          type="button"
          onClick={() => onUpdate({ status: 'resolved' })}
          disabled={busy || incident.status === 'resolved'}
        >
          Resolve
        </button>
        {incident.executionUrl ? (
          <a href={incident.executionUrl} target="_blank" rel="noreferrer">
            Open source execution ↗
          </a>
        ) : null}
      </div>
      <form
        className="assignment-form"
        onSubmit={(event) => {
          event.preventDefault();
          onUpdate({ assignedTo: assignee.trim() || null });
        }}
      >
        <label>
          Assignment
          <input
            value={assignee}
            onChange={(event) => setAssignee(event.target.value)}
            maxLength={120}
          />
        </label>
        <button type="submit" disabled={busy}>
          Save assignment
        </button>
      </form>
      <section className="timeline" aria-labelledby="timeline-title">
        <h3 id="timeline-title">Cross-platform timeline</h3>
        <ol>
          {incident.timeline.map((event) => (
            <li key={event.id}>
              <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
              <strong>{event.stage}</strong>
              <span>
                {event.source} · {event.status}
              </span>
              {event.executionUrl ? (
                <a href={event.executionUrl} target="_blank" rel="noreferrer">
                  Execution ↗
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
      <section className="notes" aria-labelledby="notes-title">
        <h3 id="notes-title">Internal notes</h3>
        {incident.notes.length ? (
          <ul>
            {incident.notes.map((item) => (
              <li key={item.id}>
                <strong>{item.author}</strong>
                <p>{item.body}</p>
                <time>{new Date(item.createdAt).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        ) : (
          <p>No notes yet.</p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim()) {
              onNote(note.trim());
              setNote('');
            }
          }}
        >
          <label>
            Add a note
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={4000}
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            Add note
          </button>
        </form>
      </section>
    </article>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot>(loadingSnapshot);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [session, setSession] = useState<OperatorSession | null>(() => loadOperatorSession());
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [selected, setSelected] = useState<IncidentDetail | null>(null);
  const [incidentError, setIncidentError] = useState<string | null>(null);
  const [incidentBusy, setIncidentBusy] = useState(false);
  const [filters, setFilters] = useState<DashboardFilters>({});
  const initialSession = useRef(session);
  const activeRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  const requestHealth = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const result = await fetchHealthSnapshot(controller.signal);
      if (mounted.current && activeRequest.current === controller) setSnapshot(result);
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) {
        setSnapshot(
          unavailableSnapshot(error instanceof Error ? error.message : 'Health check failed.'),
        );
      }
    } finally {
      if (mounted.current && activeRequest.current === controller) {
        activeRequest.current = null;
        setIsRefreshing(false);
      }
    }
  }, []);

  const loadInbox = useCallback(
    async (operator: OperatorSession, nextFilters: DashboardFilters = {}) => {
      setIncidentBusy(true);
      setIncidentError(null);
      try {
        const result = await fetchIncidents(apiBaseUrl, operator, nextFilters);
        setIncidents(result.incidents);
        return true;
      } catch (error) {
        setIncidentError(
          error instanceof Error ? error.message : 'The incident inbox could not be loaded.',
        );
        return false;
      } finally {
        setIncidentBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => {
      if (mounted.current) {
        void requestHealth();
        if (initialSession.current) void loadInbox(initialSession.current);
      }
    });
    return () => {
      mounted.current = false;
      activeRequest.current?.abort();
    };
  }, [loadInbox, requestHealth]);

  const openIncident = async (incidentId: string) => {
    if (!session) return;
    setIncidentBusy(true);
    try {
      setSelected(await fetchIncident(apiBaseUrl, session, incidentId));
      setIncidentError(null);
    } catch (error) {
      setIncidentError(
        error instanceof Error ? error.message : 'The incident could not be loaded.',
      );
    } finally {
      setIncidentBusy(false);
    }
  };

  const mutateIncident = async (update: {
    status?: 'acknowledged' | 'resolved';
    assignedTo?: string | null;
  }) => {
    if (!session || !selected) return;
    setIncidentBusy(true);
    try {
      setSelected(await patchIncident(apiBaseUrl, session, selected.id, update));
      await loadInbox(session, filters);
    } catch (error) {
      setIncidentError(
        error instanceof Error ? error.message : 'The incident could not be updated.',
      );
    } finally {
      setIncidentBusy(false);
    }
  };

  const addNote = async (body: string) => {
    if (!session || !selected) return;
    setIncidentBusy(true);
    try {
      setSelected(
        await postIncidentNote(apiBaseUrl, session, selected.id, { author: session.name, body }),
      );
    } catch (error) {
      setIncidentError(error instanceof Error ? error.message : 'The note could not be added.');
    } finally {
      setIncidentBusy(false);
    }
  };

  const liveMessage = useMemo(() => {
    if (snapshot.overall === 'loading') return 'Checking API, PostgreSQL, and Redis.';
    if (snapshot.overall === 'up') return 'Dependency check complete. All three services are up.';
    if (snapshot.overall === 'down') return 'Dependency check failed. The API is down.';
    const issueCount = snapshot.services.filter((service) => service.state !== 'up').length;
    return `Dependency check complete. ${issueCount} ${issueCount === 1 ? 'service needs' : 'services need'} attention.`;
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
            <p className="eyebrow">Operations workspace / Incident command</p>
            <h1>See the broken handoff.</h1>
            <p className="page-header__intro">
              Failure, sequence, missing-stage, and SLA signals correlated into one business-process
              inbox.
            </p>
          </div>
          <div className="phase-stamp" aria-label="Current release phase: Phase 2">
            <span>Release state</span>
            <strong>PHASE / 02</strong>
          </div>
        </header>

        <section
          className="health-panel health-panel--compact"
          aria-labelledby="health-title"
          aria-busy={isRefreshing}
        >
          <div className="health-panel__header">
            <div>
              <p className="section-index">SYSTEM CHECK 001</p>
              <h2 id="health-title">Runtime health</h2>
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
          <ul className="service-list service-list--inline" aria-label="Service health">
            {snapshot.services.map((service) => (
              <ServiceRow key={service.name} service={service} />
            ))}
          </ul>
        </section>

        <section className="incident-workspace" id="incidents" aria-labelledby="incidents-title">
          <div className="incident-workspace__heading">
            <div>
              <p className="section-index">INCIDENT INBOX 002</p>
              <h2 id="incidents-title">Active operations</h2>
            </div>
            {session ? (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  saveOperatorSession(null);
                  setSession(null);
                  setIncidents([]);
                  setSelected(null);
                }}
              >
                Lock inbox
              </button>
            ) : null}
          </div>
          {!session ? (
            <OperatorLogin
              error={incidentError}
              onSubmit={async (candidate) => {
                const accepted = await loadInbox(candidate);
                if (accepted) {
                  saveOperatorSession(candidate);
                  setSession(candidate);
                }
              }}
            />
          ) : (
            <>
              <div className="incident-toolbar">
                <label>
                  Status
                  <select
                    value={filters.status ?? ''}
                    onChange={(event) => {
                      const next = {
                        ...filters,
                        status: (event.target.value || undefined) as IncidentStatus | undefined,
                      };
                      setFilters(next);
                      void loadInbox(session, next);
                    }}
                  >
                    <option value="">All states</option>
                    <option value="open">Open</option>
                    <option value="acknowledged">Acknowledged</option>
                    <option value="resolved">Resolved</option>
                  </select>
                </label>
                <label>
                  Severity
                  <select
                    value={filters.severity ?? ''}
                    onChange={(event) => {
                      const next = {
                        ...filters,
                        severity: (event.target.value || undefined) as IncidentSeverity | undefined,
                      };
                      setFilters(next);
                      void loadInbox(session, next);
                    }}
                  >
                    <option value="">All severities</option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </label>
                <label>
                  Type
                  <select
                    value={filters.type ?? ''}
                    onChange={(event) => {
                      const next = {
                        ...filters,
                        type: (event.target.value || undefined) as IncidentType | undefined,
                      };
                      setFilters(next);
                      void loadInbox(session, next);
                    }}
                  >
                    <option value="">All types</option>
                    {Object.entries(INCIDENT_TYPE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void loadInbox(session, filters)}
                  disabled={incidentBusy}
                >
                  Refresh inbox
                </button>
              </div>
              {incidentError ? (
                <p className="form-error" role="alert">
                  {incidentError}
                </p>
              ) : null}
              <div className="incident-grid" aria-busy={incidentBusy}>
                <div className="incident-list-panel">
                  <p className="incident-count">
                    {incidents.length} incident{incidents.length === 1 ? '' : 's'} shown
                  </p>
                  {incidents.length ? (
                    <ul className="incident-list">
                      {incidents.map((incident) => (
                        <IncidentListItem
                          key={incident.id}
                          incident={incident}
                          selected={selected?.id === incident.id}
                          onSelect={() => void openIncident(incident.id)}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="incident-empty">No incidents match these filters.</p>
                  )}
                </div>
                <IncidentDetailPanel
                  key={selected?.id ?? 'empty'}
                  incident={selected}
                  busy={incidentBusy}
                  onUpdate={(update) => void mutateIncident(update)}
                  onNote={(body) => void addNote(body)}
                />
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
