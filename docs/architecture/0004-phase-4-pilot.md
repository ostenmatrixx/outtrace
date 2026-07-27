# ADR 0004: Phase 4 pilot onboarding and evidence model

- Status: Accepted
- Date: 2026-07-25

## Context

Phase 4 must move Outtrace from a seeded development process to a controlled production pilot. An
agency owner needs to define a real process without database access, instrument it with a credential
that cannot submit events for another process, and tell whether the connection is still active.
Operators also need to distinguish genuine incidents from false positives without confusing that
product evidence with the incident lifecycle.

The pilot must answer product, pricing, and recovery questions. It must not introduce billing,
workflow execution, replay, or automated remediation before monitoring value is validated.

## Decision

### Owner-created, immutable process definitions

Only an owner can create a process. Creation stores the client, immutable process key, display name,
`sandbox` or `production` environment, optional process SLA, metadata allowlist, and one to 32
ordered stages in one transaction. Array order is stage order. Stage keys are unique within the
process, at least one stage is required, and at least one stage must be marked required. A stage can
define whether it is required, its timeout, source system, and owning team.

The process key, environment, and stage sequence are immutable in this slice. The existing process
update operation can change client assignment, metadata allowlist, or lifecycle status. Material
definition changes require a new process so an edit cannot reinterpret in-flight or historical
instances and manufacture false-positive incidents.

New processes are `active`. An owner can set `lifecycleStatus` to `archived` or return it to
`active`. Archived processes reject event ingestion even when a previously issued credential is
present. They are excluded from the pilot activation denominator and the pilot summary's production
process list, but their process instances, events, incidents, feedback, connection timestamps, and
audit history remain intact. This provides a safe replacement path: connect the new immutable
definition, move the source integration, then archive the superseded definition.

### Process-scoped ingestion credentials

Process creation returns a credential identifier and plaintext secret once. Only the secret hash is
stored. A process-scoped credential can authenticate `POST /v1/events` only when the event's
`processKey` matches its process. Existing workspace-scoped ingestion credentials originally
remained valid for backward compatibility, but new pilot integrations should use process-scoped
credentials. ADR 0005 limits the legacy fallback to development and test; production accepts
process-scoped ingestion keys.

This Phase 4 decision originally allowed an owner to issue another credential without revoking the
old secret. ADR 0005 supersedes that limitation with credential listing, atomic rotation, audited
revocation, and secret-file deployment configuration.

### Persistent connection evidence

Processes start in `awaiting_first_event`. The first persisted non-duplicate event sets
`connectedAt`; later newly persisted events update `lastEventAt` without moving `connectedAt`.
Connection evidence survives service restarts. `sandbox` processes support safe installation tests.
`production` processes are the only processes included in the activation section of the pilot
summary.

The connection indicator proves that Outtrace accepted telemetry. It does not prove that every
expected production path is instrumented correctly or that a source workflow is healthy now.

### Incident feedback is separate from lifecycle

Owners and operators with access to the affected client can classify an incident as `genuine` or
`false_positive`. A false positive requires one of:

- `timeout_too_short`
- `stage_not_required`
- `expected_sequence_variation`
- `test_or_duplicate_traffic`
- `other`

An optional note captures context. Feedback is upserted, records the reviewing member, and appends a
`feedback_recorded` audit event. A verdict neither resolves an incident nor changes automatic
reopen/resolve behavior. Conversely, acknowledgement or resolution does not imply a verdict. This
separation prevents an automatically resolved genuine failure from being counted as a false
positive.

### Fixed pilot summary

`GET /v1/pilot/summary` is available to owners and operators. It has no date query because the pilot
uses one comparable definition:

- `generatedAt` is the server snapshot time.
- The incident-quality window is the half-open interval
  `[generatedAt - 28 days, generatedAt)`.
- `incidentsDetected` counts production-process incidents created in that interval.
- `reviewedIncidents` is `genuineIncidents + falsePositiveIncidents`.
- `unreviewedIncidents` is `incidentsDetected - reviewedIncidents`.
- `falsePositiveRate` is `falsePositiveIncidents / reviewedIncidents`, and is `null` when no
  incidents have been reviewed.
- Activation includes all active production processes, regardless of creation date.
- `connectionRate` is `connectedProcesses / totalProcesses`, with zero when there are no production
  processes.
- `medianSecondsToFirstEvent` is calculated for connected production processes from process
  creation to their persisted first connection.

Sandbox incidents are excluded from signal-quality metrics so controlled installation tests cannot
inflate genuine-incident counts or distort the false-positive rate. Archiving a production process
does not remove its incidents from the quality window.

The response also lists each active production process with its currently retained raw-event count,
connection state, first connection, and last event time. Retention can reduce that event count. The
summary is an operational pilot view, not a general analytics or billing ledger.

### Pricing and recovery remain experiments

Pricing validation is a structured interview and offer using the PRD hypotheses: Solo at
$49/month, Agency at $199/month, and Agency Pro at $499/month. Outtrace does not collect payment,
enforce plan limits, meter overages, or store billing details in this phase.

Recovery validation records how operators recovered from genuine incidents and whether guided or
approval-based recovery would create enough additional value to justify a later milestone. Phase 4
does not call customer workflows, retry jobs, replay events, execute compensating actions, or
generate recovery actions.

## Consequences

- Owners can connect production workflows without direct database changes.
- A leaked credential has a smaller process-level blast radius, and owners can revoke it
  immediately. External secret-store controls remain mandatory.
- Definition immutability protects historical and in-flight incident semantics at the cost of
  creating a replacement process when stage rules materially change. Archival removes superseded
  definitions from active telemetry and activation metrics without deleting their evidence.
- Persistent connection timestamps make activation measurable across restarts, while the fixed
  28-day quality window makes pilot reviews comparable.
- Feedback quality depends on operators reviewing incidents; the summary exposes unreviewed counts
  so a low false-positive rate cannot be claimed from a small denominator.
- Existing credentials, ingestion behavior, incident lifecycle, client reports, and role boundaries
  remain backward compatible.
- Billing, flexible analytics windows, credential expiry, process editing, and all recovery
  execution are explicitly deferred.
