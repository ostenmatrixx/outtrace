# ADR 0003: Phase 3 agency access and data governance

- Status: Accepted
- Date: 2026-07-24

## Context

Agency teams need to operate several client accounts inside one workspace without exposing one
client's incidents or reports to another. Workspace owners also need simple member administration,
per-process data minimization, auditable changes, and an enforceable event-retention policy.

The Phase 2 operator credential identifies only a workspace. It cannot express a person, role, or
restricted set of clients. Replacing that credential outright would also strand existing local
development workspaces.

## Decision

### Member credentials and authorization

`workspace_members` stores a role, lifecycle status, access-key identifier, and SHA-256 key hash.
Invitation returns the generated secret once; plaintext secrets are never persisted. Active and
invited members can authenticate, and first use activates an invitation.

Owners and operators can access every client in their workspace. Viewers require explicit rows in
`member_client_access`. Authorization is enforced in API preconditions and scoped SQL, including
incident lists, incident details, processes, clients, and reports. The development workspace's
existing operator key is upserted as its owner credential. A legacy workspace operator credential
remains an owner-compatible fallback for migration safety.

Owners are the only role that can create clients, invite or update members, move processes, change
metadata policies, and update retention. The store refuses to disable or demote the last active
owner.

### Client reports

Reports are calculated from tenant-scoped process instances and incidents. They expose lifetime
completion counts and rate, detected and resolved incident counts, median resolution duration, and
the stage with the most incidents. Viewer report access is limited to assigned clients.

### Process-level metadata minimization

Every process stores an allowlist of at most 32 key names. Event metadata is sanitized only after
the authenticated process is resolved, so the process policy—not a browser or caller—controls
persistence. Recursive sensitive-key redaction, known-key validation, value limits, and the total
metadata byte limit continue to apply.

### Retention and audit

Each workspace configures raw-event retention from 1 to 3650 days. The worker performs a bounded
periodic sweep, deleting only expired `events` rows. Process instances, incidents, notes, audit
records, and aggregate relationships remain available.

Owner administration and successful deletion runs append actor, action, target, and structured
details to `workspace_audit_log`. `retention_runs` records deletion counts and timing for
operational inspection.

## Consequences

- One workspace can safely expose different client subsets to different viewers.
- UI visibility mirrors role permissions, while the API remains the security boundary.
- Access-key delivery is intentionally primitive: email delivery, SSO, recovery, and rotation
  require a later identity milestone.
- Client reports are computed live and cover the full retained history; date windows and exports
  require later query and product decisions.
- Deleting raw events reduces sensitive-data exposure without erasing incident operations or the
  audit trail.
