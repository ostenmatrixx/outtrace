# ADR 0001: Phase 1 foundation and ingestion boundaries

Status: Accepted
Date: 2026-07-23

## Context

Phase 1 must prove a secure, idempotent event-ingestion path without implementing the incident
engine. The event payload identifies a process by `processKey`, but does not carry a separate client
selector.

## Decisions

- Use npm workspaces with one deployable package per application and a shared Zod contract package.
- Use Fastify with the lightweight `pg` client and explicit SQL migrations.
- Make process keys unique inside a workspace. Processes retain a client relationship, but callers
  do not need to send a client identifier to resolve a process.
- Resolve ingestion credentials by a non-secret key identifier. Store only a SHA-256 secret hash and
  verify it with a constant-time comparison in application code.
- Keep the Phase 1 development seed opt-in through environment variables. The documented local
  secret is never compiled into the dashboard.
- Use database uniqueness for both `(process_id, instance_key)` correlation and
  `(workspace_id, external_event_id)` idempotency.
- Persist only allowlisted metadata keys and recursively replace sensitive nested values before any
  database write. Persisted allowlisted values are bounded scalars; arbitrary nested customer
  records are discarded.
- Rate-limit ingestion attempts before persistence using request origin and key identifier. This
  Phase 1 in-process limiter is intentionally simple and must move to shared infrastructure before
  horizontally scaling the API.
- Update instance state by `occurredAt` and external event ID, giving equal-time events a stable
  tie-breaker while retaining the earliest observed `started_at`.
- Define, but do not yet produce, an incident-evaluation queue job. The worker validates and safely
  acknowledges this placeholder job without applying Phase 2 rules.

## Consequences

- A workspace cannot currently reuse the same process key for two clients. This removes ambiguity
  from the Phase 1 event contract and can later evolve through explicit client/process identifiers.
- Ingestion stays synchronous through durable PostgreSQL persistence. Queue delivery is deliberately
  outside the accepted-event transaction until the Phase 2 outbox/job-delivery design is chosen.
- Development setup needs a seed step after migrations so the API can authenticate and resolve a
  known process.
- PostgreSQL integration verification is mandatory: missing `TEST_DATABASE_URL` fails rather than
  silently skipping the persistence suite.
