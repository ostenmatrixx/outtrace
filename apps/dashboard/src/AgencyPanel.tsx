import type {
  ClientReliabilityReport,
  ClientSummary,
  MemberInviteResponse,
  MemberSummary,
  OperatorSession as AgencySession,
  ProcessSummary,
  WorkspaceRole,
  WorkspaceSettings,
} from '@outtrace/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import {
  createClient,
  fetchAgencySession,
  fetchClientReport,
  fetchClients,
  fetchMembers,
  fetchProcesses,
  fetchWorkspaceSettings,
  inviteMember,
  updateMember,
  updateProcess,
  updateWorkspaceSettings,
} from './agency';
import type { OperatorSession as OperatorCredentials } from './incidents';

type AgencyPanelProps = {
  apiBaseUrl: string;
  credentials: OperatorCredentials;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function percentage(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'No resolved incidents';
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} hr`;
}

function ReportPanel({ report }: { report: ClientReliabilityReport | null }) {
  if (!report) {
    return (
      <div className="agency-empty">Select a client to load its process reliability report.</div>
    );
  }
  return (
    <article className="report-panel" aria-live="polite">
      <header>
        <div>
          <p className="section-index">CLIENT REPORT</p>
          <h3>{report.client.name}</h3>
        </div>
        <strong>{percentage(report.completionRate)}</strong>
      </header>
      <dl className="report-metrics">
        <div>
          <dt>Completed</dt>
          <dd>
            {report.completedInstances} / {report.totalInstances}
          </dd>
        </div>
        <div>
          <dt>Incidents</dt>
          <dd>{report.incidentsDetected}</dd>
        </div>
        <div>
          <dt>Resolved</dt>
          <dd>{report.incidentsResolved}</dd>
        </div>
        <div>
          <dt>Median resolution</dt>
          <dd>{formatDuration(report.medianResolutionSeconds)}</dd>
        </div>
      </dl>
      <p className="report-risk">
        <span>Most unreliable stage</span>
        <strong>
          {report.mostUnreliableStage
            ? `${report.mostUnreliableStage.stage} · ${report.mostUnreliableStage.incidentCount}`
            : 'No stage incidents'}
        </strong>
      </p>
    </article>
  );
}

function OwnerControls({
  apiBaseUrl,
  credentials,
  clients,
  members,
  processes,
  settings,
  invitation,
  onChanged,
  onInvitation,
}: {
  apiBaseUrl: string;
  credentials: OperatorCredentials;
  clients: ClientSummary[];
  members: MemberSummary[];
  processes: ProcessSummary[];
  settings: WorkspaceSettings | null;
  invitation: MemberInviteResponse | null;
  onChanged: () => Promise<void>;
  onInvitation: (invitation: MemberInviteResponse) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const perform = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChanged();
    } catch (error) {
      setError(errorMessage(error, 'The workspace change could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const submitClient = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void perform(async () => {
      await createClient(apiBaseUrl, credentials, { name: String(data.get('name') ?? '') });
      form.reset();
    });
  };

  const submitInvitation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void perform(async () => {
      const result = await inviteMember(apiBaseUrl, credentials, {
        name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''),
        role: String(data.get('role') ?? 'viewer') as WorkspaceRole,
        clientIds: data.getAll('clientIds').map(String),
      });
      onInvitation(result);
      form.reset();
    });
  };

  return (
    <section className="owner-controls" aria-labelledby="workspace-admin-title">
      <div className="agency-subhead">
        <div>
          <p className="section-index">OWNER CONTROLS</p>
          <h3 id="workspace-admin-title">Workspace administration</h3>
        </div>
        <p>Every change is written to the workspace audit log.</p>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {invitation ? (
        <div className="credential-reveal" role="status">
          <strong>Copy this access key now—it is shown once.</strong>
          <code>{invitation.accessKeyId}</code>
          <code>{invitation.accessKey}</code>
        </div>
      ) : null}
      <div className="admin-grid">
        <form className="admin-card" onSubmit={submitClient}>
          <div>
            <span className="admin-card__index">01</span>
            <h4>Add a client</h4>
            <p>Create a clean reporting and access boundary.</p>
          </div>
          <label>
            Client name
            <input name="name" required maxLength={200} />
          </label>
          <button type="submit" disabled={busy}>
            Create client
          </button>
        </form>

        <form className="admin-card" onSubmit={submitInvitation}>
          <div>
            <span className="admin-card__index">02</span>
            <h4>Invite a member</h4>
            <p>Viewers can be restricted to selected client accounts.</p>
          </div>
          <label>
            Member name
            <input name="name" required maxLength={120} />
          </label>
          <label>
            Email
            <input name="email" type="email" required />
          </label>
          <label>
            Role
            <select name="role" defaultValue="viewer">
              <option value="viewer">Viewer</option>
              <option value="operator">Operator</option>
              <option value="owner">Owner</option>
            </select>
          </label>
          <fieldset>
            <legend>Viewer client access</legend>
            {clients.map((client) => (
              <label className="check-row" key={client.id}>
                <input type="checkbox" name="clientIds" value={client.id} />
                {client.name}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={busy}>
            Create invitation
          </button>
        </form>

        <form
          className="admin-card"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void perform(async () => {
              await updateWorkspaceSettings(apiBaseUrl, credentials, {
                eventRetentionDays: Number(data.get('eventRetentionDays')),
              });
            });
          }}
        >
          <div>
            <span className="admin-card__index">03</span>
            <h4>Event retention</h4>
            <p>Expired raw event records are removed by the worker.</p>
          </div>
          <label>
            Retention days
            <input
              name="eventRetentionDays"
              type="number"
              min={1}
              max={3650}
              defaultValue={settings?.eventRetentionDays ?? 30}
              key={settings?.eventRetentionDays}
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            Save retention
          </button>
        </form>
      </div>

      <div className="policy-table">
        <h4>Process data policies</h4>
        {processes.length ? (
          <ul>
            {processes.map((process) => (
              <li key={process.id}>
                <div>
                  <strong>{process.name}</strong>
                  <small>{process.key}</small>
                </div>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void perform(async () => {
                      await updateProcess(apiBaseUrl, credentials, process.id, {
                        clientId: String(data.get('clientId') ?? process.clientId),
                        metadataAllowlist: String(data.get('metadataAllowlist') ?? '')
                          .split(',')
                          .map((key) => key.trim())
                          .filter(Boolean),
                      });
                    });
                  }}
                >
                  <label>
                    Client
                    <select name="clientId" defaultValue={process.clientId}>
                      {clients.map((client) => (
                        <option key={client.id} value={client.id}>
                          {client.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Allowed metadata keys
                    <input
                      name="metadataAllowlist"
                      defaultValue={process.metadataAllowlist.join(', ')}
                      aria-describedby={`policy-${process.id}`}
                    />
                    <small id={`policy-${process.id}`}>Comma-separated, up to 32 keys.</small>
                  </label>
                  <button type="submit" disabled={busy}>
                    Save policy
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p>No processes configured.</p>
        )}
      </div>

      <div className="member-table">
        <h4>Members</h4>
        <ul>
          {members.map((member) => (
            <li key={member.id}>
              <div>
                <strong>{member.name}</strong>
                <small>{member.email}</small>
              </div>
              <span className="role-badge">{member.role}</span>
              <span>{member.status}</span>
              {member.status !== 'disabled' ? (
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void perform(async () => {
                      await updateMember(apiBaseUrl, credentials, member.id, {
                        status: 'disabled',
                      });
                    });
                  }}
                >
                  Disable
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function AgencyPanel({ apiBaseUrl, credentials }: AgencyPanelProps) {
  const [session, setSession] = useState<AgencySession | null>(null);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [processes, setProcesses] = useState<ProcessSummary[]>([]);
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [report, setReport] = useState<ClientReliabilityReport | null>(null);
  const [invitation, setInvitation] = useState<MemberInviteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const nextSession = await fetchAgencySession(apiBaseUrl, credentials);
      const [nextClients, nextProcesses] = await Promise.all([
        fetchClients(apiBaseUrl, credentials),
        fetchProcesses(apiBaseUrl, credentials),
      ]);
      setSession(nextSession);
      setClients(nextClients);
      setProcesses(nextProcesses);
      if (nextSession.role === 'owner') {
        const [nextMembers, nextSettings] = await Promise.all([
          fetchMembers(apiBaseUrl, credentials),
          fetchWorkspaceSettings(apiBaseUrl, credentials),
        ]);
        setMembers(nextMembers);
        setSettings(nextSettings);
      } else {
        setMembers([]);
        setSettings(null);
      }
    } catch (error) {
      setError(errorMessage(error, 'The agency workspace could not be loaded.'));
    } finally {
      setBusy(false);
    }
  }, [apiBaseUrl, credentials]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const openReport = async (clientId: string) => {
    setBusy(true);
    setError(null);
    try {
      setReport(await fetchClientReport(apiBaseUrl, credentials, clientId));
    } catch (error) {
      setError(errorMessage(error, 'The client report could not be loaded.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="agency-workspace"
      id="agency"
      aria-labelledby="agency-title"
      aria-busy={busy}
    >
      <div className="incident-workspace__heading">
        <div>
          <p className="section-index">AGENCY WORKSPACE 003</p>
          <h2 id="agency-title">Clients, access &amp; reporting</h2>
        </div>
        {session ? <span className="role-badge">{session.role}</span> : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="agency-overview">
        <div className="client-roster">
          <div className="agency-subhead">
            <div>
              <p className="section-index">CLIENT ROSTER</p>
              <h3>Account boundaries</h3>
            </div>
            <span>{clients.length} visible</span>
          </div>
          {clients.length ? (
            <ul>
              {clients.map((client) => (
                <li key={client.id}>
                  <button type="button" onClick={() => void openReport(client.id)}>
                    <span>
                      <strong>{client.name}</strong>
                      <small>
                        {client.processCount} processes · {client.openIncidentCount} open
                      </small>
                    </span>
                    <span aria-hidden="true">↗</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="agency-empty">{busy ? 'Loading clients…' : 'No visible clients.'}</p>
          )}
        </div>
        <ReportPanel report={report} />
      </div>
      {session?.role === 'owner' ? (
        <OwnerControls
          apiBaseUrl={apiBaseUrl}
          credentials={credentials}
          clients={clients}
          members={members}
          processes={processes}
          settings={settings}
          invitation={invitation}
          onChanged={load}
          onInvitation={setInvitation}
        />
      ) : null}
    </section>
  );
}
