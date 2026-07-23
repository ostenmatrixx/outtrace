# Phase 0 engineering brief

## Workspace inspection

The repository started with only `OUTTRACE_PRD.md`, no `AGENTS.md`, no commits, and no existing
implementation. The PRD is preserved as the product source of truth.

## Phase 1 architecture

1. External systems call the Fastify API with a key identifier and secret.
2. PostgreSQL resolves and verifies the ingestion credential before request-body validation.
3. The API validates the shared Zod event contract, strips unknown top-level fields, redacts
   sensitive keys, and applies the bounded metadata allowlist.
4. PostgreSQL resolves the workspace-unique process for the authenticated workspace.
5. One transaction correlates the process instance, inserts the event idempotently, and updates
   instance state only for a newly accepted event.
6. The response identifies the stable process instance and whether the event was a duplicate.
7. Redis and a BullMQ worker are established for Phase 2, but incident detection is not implemented.
8. The React dashboard provides an accessible operational shell and dependency-health view.

## File ownership for Wave 1

- Root agent: root configuration, Compose, shared contracts, cross-workspace integration, and docs.
- API agent: `apps/api/**`, `database/migrations/**`, and API-specific tests.
- Worker agent: `apps/worker/**` and worker-specific tests.
- Dashboard agent: `apps/dashboard/**` and dashboard-specific tests.

No two active agents own the same files.

## Risk register

| Risk                        | Phase 1 mitigation                                                          |
| --------------------------- | --------------------------------------------------------------------------- |
| Cross-tenant event lookup   | Authenticate workspace first; scope process and event queries to it         |
| Duplicate requests race     | Enforce a database unique constraint and use conflict-safe insertion        |
| Partial writes              | Perform correlation, event insert, and instance update in one transaction   |
| Sensitive payload retention | Strip unknown fields, redact, then retain bounded allowlisted scalar values |
| Plaintext credentials       | Store hashes only; keep the local seed explicitly development-only          |
| Ingestion abuse             | Limit requests in process; use shared storage before horizontal API scaling |
| Ambiguous process keys      | Enforce one process key per workspace                                       |
| Out-of-order events         | Preserve rows; deterministically derive current state and earliest start    |
| Redis unavailable           | Report degraded health and allow clean worker shutdown                      |
| Docker unavailable locally  | Validate configuration when a Docker runtime is available; report limits    |

## Phase 1 definition of done

The root verification scripts pass; Compose validates and services start; migrations apply to an
empty PostgreSQL database; authenticated n8n, Make, and custom events persist; validation and auth
errors are structured; duplicates remain single-row; instance correlation is database-enforced;
metadata handling is verified; all workspaces compile and build; and README instructions match the
verified workflow.
