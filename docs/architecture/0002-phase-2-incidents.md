# ADR 0002: Durable Phase 2 incident evaluation

- Status: Accepted
- Date: 2026-07-24

## Context

Phase 2 must detect reported failures, absent stages, process SLA violations, and unexpected stage
order without weakening the Phase 1 ingestion guarantees. A direct Redis publish after accepting an
event has a crash window: PostgreSQL can commit while the queue publish is lost. Performing Redis
I/O inside the event transaction would increase ingestion latency and still could not atomically
commit across both systems.

Incident evaluation and Slack delivery must also be retryable and inspectable. Missing-stage and
SLA rules must fire without a new event, and repeated jobs must not create duplicate incidents.

## Decision

### Transactional evaluation outbox

Each new event inserts an `event_evaluation_outbox` row in the same transaction as the event and
process-instance state. Duplicate external event IDs do not create another outbox row.

The worker polls unpublished rows and adds BullMQ jobs with the outbox ID as the stable job ID.
Only after Redis accepts the job does it mark the row published. A crash before that update can
repeat the publish, but the stable BullMQ ID deduplicates it.

### Idempotent incident engine

An advisory transaction lock serializes evaluation per workspace/process instance. Incidents use a
unique key of process instance, incident type, and affected stage. Evaluation creates, refreshes,
reopens, or automatically resolves this stable rule record.

Operator resolutions use `resolution_reason = operator` and are not reopened by a repeated
evaluation of the same condition. Automatic resolutions use `condition_cleared` and may reopen if
the condition genuinely recurs.

Reported failures and sequence violations evaluate immediately from event jobs. A periodic
PostgreSQL sweep evaluates active instances for missing-stage and SLA deadlines even during event
silence.

### Notification outbox

Creating or reopening an incident inserts an `incident_notification_outbox` row in the same
transaction. The worker sends eligible rows to an optional HTTPS Slack webhook according to the
configured minimum severity. Successful, skipped-below-threshold, and failed deliveries retain
explicit state; failures use bounded exponential backoff.

### Operator boundary

Workspaces have a separate operator key ID and SHA-256 key hash. Incident APIs resolve the
workspace from those credentials and scope every query and mutation to it. The dashboard accepts
credentials at runtime and stores them only in `sessionStorage`; secrets are never placed in
`VITE_*` variables or production bundles.

## Consequences

- Event acceptance remains independent of Redis and Slack availability.
- Evaluation and notifications survive process restarts and remain inspectable.
- Repeated or concurrently delivered jobs cannot create duplicate incident records.
- Time-based rules are bounded by the configured sweep interval.
- Phase 2 uses deployment-level Slack settings. Per-workspace encrypted webhook configuration,
  user accounts, and roles are deferred to Phase 3.
- Outbox retention/archival will need an explicit production policy as volume grows.
