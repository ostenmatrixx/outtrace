import {
  processCreateSchema,
  type ClientSummary,
  type OperatorSession as AgencySession,
  type PilotProcessStatus,
  type PilotSummary,
  type ProcessCreateResponse,
  type ProcessStageCreate,
  type WorkspaceRole,
} from '@outtrace/contracts';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { fetchAgencySession, fetchClients } from './agency';
import type { OperatorSession as OperatorCredentials } from './incidents';
import { createProcess, fetchPilotSummary } from './pilot';

type PilotPanelProps = {
  apiBaseUrl: string;
  credentials: OperatorCredentials;
  onRoleResolved: (role: WorkspaceRole) => void;
  refreshToken: number;
};

type StageDraft = {
  draftId: number;
  key: string;
  name: string;
  source: 'n8n' | 'make' | 'custom';
  timeoutMinutes: string;
  owningTeam: string;
};

let nextDraftId = 1;

function newStage(): StageDraft {
  return {
    draftId: nextDraftId++,
    key: '',
    name: '',
    source: 'n8n',
    timeoutMinutes: '',
    owningTeam: '',
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function percentage(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

function duration(seconds: number | null): string {
  if (seconds === null) return 'Awaiting data';
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} hr`;
}

function connectionCopy(process: PilotProcessStatus): string {
  if (process.connectionStatus === 'awaiting_first_event') return 'Awaiting first event';
  if (!process.lastEventAt) return 'Connected';
  return `Last event ${new Date(process.lastEventAt).toLocaleString()}`;
}

function IntegrationInstructions({
  apiBaseUrl,
  result,
}: {
  apiBaseUrl: string;
  result: ProcessCreateResponse;
}) {
  const firstStage = result.stages[0];
  const payload = useMemo(
    () =>
      JSON.stringify(
        {
          eventId: 'evt_replace_with_unique_id',
          processKey: result.process.key,
          instanceKey: 'business_record_123',
          stage: firstStage?.key ?? 'first_stage',
          status: 'completed',
          source: firstStage?.source ?? 'custom',
          occurredAt: new Date().toISOString(),
          metadata: {},
        },
        null,
        2,
      ),
    [firstStage?.key, firstStage?.source, result.process.key],
  );
  const curl = `curl -X POST '${apiBaseUrl}/v1/events' \\
  -H 'Content-Type: application/json' \\
  -H 'x-outtrace-key-id: ${result.credential.keyId}' \\
  -H 'x-outtrace-key: ${result.credential.key}' \\
  --data '${payload.replaceAll("'", "'\\''")}'`;

  return (
    <section className="integration-reveal" aria-labelledby="integration-title">
      <p className="sr-only" role="status">
        Production workflow created. The one-time ingestion credential is ready to copy.
      </p>
      <div>
        <p className="section-index">CONNECTION KIT</p>
        <h3 id="integration-title">Credential created. Send the first event.</h3>
        <p>
          Copy this credential now. The secret is shown once and should be stored in your workflow
          platform&apos;s credential manager.
        </p>
      </div>
      <dl className="credential-grid">
        <div>
          <dt>Key ID</dt>
          <dd>
            <code>{result.credential.keyId}</code>
          </dd>
        </div>
        <div>
          <dt>Secret key</dt>
          <dd>
            <code>{result.credential.key}</code>
          </dd>
        </div>
      </dl>
      <div className="setup-grid">
        <details open>
          <summary>cURL</summary>
          <pre>
            <code>{curl}</code>
          </pre>
        </details>
        <details>
          <summary>n8n HTTP Request</summary>
          <p>
            POST to <code>{apiBaseUrl}/v1/events</code>. Add the two credential values above as
            headers, choose JSON body mode, and send:
          </p>
          <pre>
            <code>{payload}</code>
          </pre>
        </details>
        <details>
          <summary>Make HTTP module</summary>
          <p>
            Use “Make a request,” POST to <code>{apiBaseUrl}/v1/events</code>, add both credential
            headers, select JSON, and map a unique event and instance ID into:
          </p>
          <pre>
            <code>{payload}</code>
          </pre>
        </details>
      </div>
    </section>
  );
}

function WorkflowForm({
  apiBaseUrl,
  credentials,
  clients,
  onCreated,
}: {
  apiBaseUrl: string;
  credentials: OperatorCredentials;
  clients: ClientSummary[];
  onCreated: (result: ProcessCreateResponse) => Promise<void>;
}) {
  const [stages, setStages] = useState<StageDraft[]>(() => [newStage()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateStage = (draftId: number, update: Partial<StageDraft>) => {
    setStages((current) =>
      current.map((stage) => (stage.draftId === draftId ? { ...stage, ...update } : stage)),
    );
  };

  const moveStage = (index: number, direction: -1 | 1) => {
    setStages((current) => {
      const destination = index + direction;
      if (destination < 0 || destination >= current.length) return current;
      const next = [...current];
      const [stage] = next.splice(index, 1);
      if (!stage) return current;
      next.splice(destination, 0, stage);
      return next;
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const stageInput: ProcessStageCreate[] = stages.map((stage) => ({
      key: stage.key,
      name: stage.name,
      required: true,
      timeoutSeconds: stage.timeoutMinutes ? Math.round(Number(stage.timeoutMinutes) * 60) : null,
      source: stage.source,
      owningTeam: stage.owningTeam.trim() || null,
    }));
    const parsed = processCreateSchema.safeParse({
      clientId: String(data.get('clientId') ?? ''),
      name: String(data.get('processName') ?? ''),
      key: String(data.get('processKey') ?? ''),
      environment: String(data.get('environment') ?? 'production'),
      slaSeconds: data.get('slaMinutes') ? Math.round(Number(data.get('slaMinutes')) * 60) : null,
      metadataAllowlist: String(data.get('metadataAllowlist') ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean),
      stages: stageInput,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Review the workflow definition and try again.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await createProcess(apiBaseUrl, credentials, parsed.data);
      await onCreated(result);
      form.reset();
      setStages([newStage()]);
    } catch (error) {
      setError(errorMessage(error, 'The production workflow could not be connected.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="workflow-form" onSubmit={(event) => void submit(event)}>
      <div className="workflow-form__intro">
        <p className="section-index">GUIDED SETUP / 01</p>
        <h3>Describe the production contract</h3>
        <p>
          Keep the definition operational: identify the client, order the expected stages, and set
          the deadlines that should create incidents.
        </p>
      </div>
      <fieldset className="workflow-fields">
        <legend>Workflow identity</legend>
        <label>
          Client
          <select name="clientId" required defaultValue="">
            <option value="" disabled>
              Select a client
            </option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Process name
          <input name="processName" required maxLength={200} placeholder="Client onboarding" />
        </label>
        <label>
          Process key
          <input
            name="processKey"
            required
            maxLength={120}
            pattern="[a-z0-9]+(?:[-_][a-z0-9]+)*"
            placeholder="client-onboarding"
            aria-describedby="process-key-help"
          />
          <small id="process-key-help">Lowercase letters, numbers, hyphens, and underscores.</small>
        </label>
        <label>
          Environment
          <select name="environment" defaultValue="production">
            <option value="production">Production</option>
            <option value="sandbox">Sandbox</option>
          </select>
        </label>
        <label>
          End-to-end SLA (minutes)
          <input name="slaMinutes" type="number" min="1" max="43200" step="1" placeholder="15" />
        </label>
        <label>
          Allowed metadata keys
          <input
            name="metadataAllowlist"
            placeholder="executionUrl, externalReference"
            aria-describedby="metadata-help"
          />
          <small id="metadata-help">Comma-separated; operational metadata only.</small>
        </label>
      </fieldset>

      <fieldset className="stage-builder">
        <legend>Expected stages, in order</legend>
        <ol>
          {stages.map((stage, index) => (
            <li key={stage.draftId}>
              <div className="stage-builder__header">
                <strong>Stage {index + 1}</strong>
                <div className="stage-builder__actions">
                  <button
                    type="button"
                    onClick={() => moveStage(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move stage ${index + 1} earlier`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStage(index, 1)}
                    disabled={index === stages.length - 1}
                    aria-label={`Move stage ${index + 1} later`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setStages((current) =>
                        current.filter((item) => item.draftId !== stage.draftId),
                      )
                    }
                    disabled={stages.length === 1}
                    aria-label={`Remove stage ${index + 1}`}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div className="stage-builder__fields">
                <label>
                  Stage name
                  <input
                    required
                    maxLength={120}
                    value={stage.name}
                    onChange={(event) => updateStage(stage.draftId, { name: event.target.value })}
                    aria-label={`Stage ${index + 1} name`}
                    placeholder="Payment received"
                  />
                </label>
                <label>
                  Stage key
                  <input
                    required
                    maxLength={64}
                    pattern="[a-z][a-z0-9_]*"
                    value={stage.key}
                    onChange={(event) => updateStage(stage.draftId, { key: event.target.value })}
                    aria-label={`Stage ${index + 1} key`}
                    placeholder="payment_received"
                  />
                </label>
                <label>
                  Source
                  <select
                    value={stage.source}
                    onChange={(event) =>
                      updateStage(stage.draftId, {
                        source: event.target.value as StageDraft['source'],
                      })
                    }
                    aria-label={`Stage ${index + 1} source`}
                  >
                    <option value="n8n">n8n</option>
                    <option value="make">Make</option>
                    <option value="custom">Custom API</option>
                  </select>
                </label>
                <label>
                  Timeout (minutes)
                  <input
                    type="number"
                    min="0.5"
                    max="43200"
                    step="0.5"
                    value={stage.timeoutMinutes}
                    onChange={(event) =>
                      updateStage(stage.draftId, { timeoutMinutes: event.target.value })
                    }
                    aria-label={`Stage ${index + 1} timeout in minutes`}
                    placeholder="10"
                  />
                </label>
                <label>
                  Owning team
                  <input
                    maxLength={120}
                    value={stage.owningTeam}
                    onChange={(event) =>
                      updateStage(stage.draftId, { owningTeam: event.target.value })
                    }
                    aria-label={`Stage ${index + 1} owning team`}
                    placeholder="Automation operations"
                  />
                </label>
              </div>
            </li>
          ))}
        </ol>
        <button
          className="secondary-button"
          type="button"
          onClick={() => setStages((s) => [...s, newStage()])}
        >
          Add another stage
        </button>
      </fieldset>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="workflow-form__footer">
        <p>Creating the workflow also issues its one-time ingestion credential.</p>
        <button className="primary-button" type="submit" disabled={busy || clients.length === 0}>
          {busy ? 'Creating connection…' : 'Create workflow connection'}
        </button>
      </div>
    </form>
  );
}

export function PilotPanel({
  apiBaseUrl,
  credentials,
  onRoleResolved,
  refreshToken,
}: PilotPanelProps) {
  const [session, setSession] = useState<AgencySession | null>(null);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [summary, setSummary] = useState<PilotSummary | null>(null);
  const [created, setCreated] = useState<ProcessCreateResponse | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const nextSession = await fetchAgencySession(apiBaseUrl, credentials);
      setSession(nextSession);
      onRoleResolved(nextSession.role);
      if (nextSession.role === 'viewer') {
        setSummary(null);
        setClients([]);
        return;
      }
      const nextSummary = await fetchPilotSummary(apiBaseUrl, credentials);
      setSummary(nextSummary);
      setClients(nextSession.role === 'owner' ? await fetchClients(apiBaseUrl, credentials) : []);
    } catch (error) {
      setError(errorMessage(error, 'Pilot readiness could not be loaded.'));
    } finally {
      setBusy(false);
    }
  }, [apiBaseUrl, credentials, onRoleResolved]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load, refreshToken]);

  return (
    <section className="pilot-workspace" id="pilot" aria-labelledby="pilot-title" aria-busy={busy}>
      <div className="incident-workspace__heading">
        <div>
          <p className="section-index">PILOT READINESS 002</p>
          <h2 id="pilot-title">Production connections &amp; signal quality</h2>
        </div>
        <div className="pilot-heading__actions">
          {session?.role === 'owner' ? (
            <button
              type="button"
              className="refresh-button"
              aria-expanded={showForm}
              aria-controls="workflow-onboarding"
              onClick={() => setShowForm((value) => !value)}
              disabled={clients.length === 0}
            >
              {showForm ? 'Close setup' : 'Connect production workflow'}
            </button>
          ) : null}
          <button type="button" className="text-button" onClick={() => void load()} disabled={busy}>
            Refresh pilot
          </button>
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {session?.role === 'viewer' ? (
        <p className="pilot-notice">
          Pilot-wide metrics are available to workspace owners and operators. Your assigned client
          incidents and reports remain available below.
        </p>
      ) : summary ? (
        <>
          <div className="pilot-metrics" aria-label="Pilot metrics">
            <div>
              <span>Connected processes</span>
              <strong>
                {summary.activation.connectedProcesses} / {summary.activation.totalProcesses}
              </strong>
              <small>{percentage(summary.activation.connectionRate)} activated</small>
            </div>
            <div>
              <span>Time to first event</span>
              <strong>{duration(summary.activation.medianSecondsToFirstEvent)}</strong>
              <small>Median across connected processes</small>
            </div>
            <div>
              <span>False-positive rate</span>
              <strong>{percentage(summary.quality.falsePositiveRate)}</strong>
              <small>
                {summary.quality.falsePositiveIncidents} of {summary.quality.reviewedIncidents}{' '}
                reviewed
              </small>
            </div>
            <div>
              <span>Review coverage / 28 days</span>
              <strong>
                {summary.quality.reviewedIncidents} / {summary.quality.incidentsDetected}
              </strong>
              <small>{summary.quality.unreviewedIncidents} awaiting classification</small>
            </div>
          </div>
          <div className="connection-roster">
            <div className="agency-subhead">
              <div>
                <p className="section-index">PROCESS CONNECTIONS</p>
                <h3>First-event readiness</h3>
              </div>
              <span>
                28-day quality window starts{' '}
                {new Date(summary.windowStartedAt).toLocaleDateString()}
              </span>
            </div>
            {summary.processes.length ? (
              <ul>
                {summary.processes.map((process) => (
                  <li key={process.id}>
                    <span
                      className="connection-mark"
                      data-state={process.connectionStatus}
                      aria-hidden="true"
                    >
                      {process.connectionStatus === 'connected' ? '✓' : '…'}
                    </span>
                    <div>
                      <strong>{process.name}</strong>
                      <small>
                        {process.clientName} / {process.key}
                      </small>
                    </div>
                    <div className="connection-roster__state">
                      <strong>
                        {process.connectionStatus === 'connected'
                          ? 'Connected'
                          : 'Awaiting first event'}
                      </strong>
                      <small>{connectionCopy(process)}</small>
                    </div>
                    <span>{process.eventCount} events</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="agency-empty">
                No processes yet. Create the first production connection to start measuring
                activation.
              </p>
            )}
          </div>
        </>
      ) : busy ? (
        <p className="agency-empty" role="status">
          Loading pilot readiness…
        </p>
      ) : null}
      {session?.role === 'owner' && clients.length === 0 ? (
        <p className="pilot-notice">
          Create a client in Agency workspace before connecting a production workflow.
        </p>
      ) : null}
      {session?.role === 'owner' && showForm ? (
        <div id="workflow-onboarding" className="workflow-onboarding">
          <WorkflowForm
            apiBaseUrl={apiBaseUrl}
            credentials={credentials}
            clients={clients}
            onCreated={async (result) => {
              setCreated(result);
              setShowForm(false);
              await load();
            }}
          />
        </div>
      ) : null}
      {created ? <IntegrationInstructions apiBaseUrl={apiBaseUrl} result={created} /> : null}
    </section>
  );
}
