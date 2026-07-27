# ADR 0005: Production hardening and operational boundaries

- Status: Accepted
- Date: 2026-07-27

## Context

The Phase 4 implementation proved the product workflow but retained single-deployment Slack
routing, unbounded maintenance queries, incomplete credential lifecycle controls, and no deployable
application topology. Those constraints are unsafe for a multi-workspace production service.

## Decision

### Tenant-safe notification delivery

Slack webhook secrets remain outside PostgreSQL and are supplied as a secret-file JSON mapping keyed
by workspace ID. The worker selects only mapped workspaces and resolves each row's webhook from that
workspace key. Pending notification rows are claimed transactionally with `FOR UPDATE SKIP LOCKED`
and a recoverable lease before the external call. Slack delivery remains at-least-once because the
webhook has no idempotency key, but concurrent worker replicas do not intentionally double-send one
row.

### Bounded and fair maintenance

Deadline evaluation uses keyset pagination until every eligible instance in the sweep has been
visited. Event retention deletes bounded batches and limits the number of batches per workspace.
Incomplete instances and instances with unresolved incidents retain their structural event evidence
so retention cannot silently clear an active condition. Completed evaluation and notification
outbox rows use a separate bounded operational-retention window. Lightweight idempotency receipts
survive raw-event deletion so retries cannot collide with the evaluation outbox or recreate an old
event; they use a separate bounded horizon and are deleted only after both raw event and outbox state
are gone.

### Credential lifecycle

Process credential metadata is listable without plaintext secrets. Owners can issue a replacement,
atomically revoke all prior active keys, or revoke one key with an audit reason. Revoked hashes are
rejected during authentication. Member credentials can be atomically rotated; disabling a member is
the immediate revocation control and destroys the old stored key so re-enablement cannot resurrect
it. An owner can rotate a disabled member before re-enabling access. Plaintext keys are still
returned only once and dashboard access keys remain in browser memory rather than Web Storage.

A one-shot bootstrap command creates a named production workspace and its first active owner with an
audit record. New production workspaces do not receive the backward-compatible workspace-wide
ingestion credential; owners issue process-scoped credentials after defining a process. The API
disables both legacy workspace-wide authentication fallbacks in production, while development and
test fixtures remain backward compatible.

### Deployment and dependency security

The API and worker support mounted secret files for PostgreSQL, Redis, and workspace Slack mappings.
Production configuration rejects non-TLS PostgreSQL, Redis, dashboard, and CORS endpoints.
Application images run as non-root or read-only services, the dashboard supplies browser security
headers, and API responses use Fastify security headers. Liveness is process-only; readiness checks
PostgreSQL and Redis for the API and includes database-cycle, Redis, and BullMQ state for the worker.

CI provisions isolated PostgreSQL and Redis services and runs the complete verification and
container-build gates. The production runbook defines migration, backup, restore, rollback,
credential rotation, queue recovery, and incident-response procedures.

## Consequences

- A production Slack mapping cannot intentionally route all workspaces through one global webhook.
- Worker scale-out no longer starves later instance IDs or races the same notification row.
- Maintenance work is bounded per statement and exposes explicit retention controls.
- Operators have executable credential containment procedures.
- Production still requires managed infrastructure, HTTPS ingress, a secret manager, monitoring,
  and periodic restore drills; repository configuration cannot supply those external guarantees.
