# Phase 4 pilot runbook

This runbook covers a two-to-four-week Outtrace design-partner pilot. It turns the Phase 4 features
into a repeatable onboarding, evidence, review, and rollback process. The product remains an
observability system: it accepts telemetry, detects incidents, and records operator feedback; it
does not execute or repair customer workflows.

## Pilot objectives

Use the pilot to answer five questions:

1. Can an agency connect a production process in less than 15 minutes?
2. Does Outtrace find genuine incidents before the agency's client reports them?
3. Is the reviewed-incident false-positive rate below 10%?
4. Will an agency accept one of the proposed paid pilot offers?
5. Do genuine incidents produce repeated, safe, valuable recovery opportunities that merit a
   separate recovery milestone?

The PRD kill thresholds still apply. In particular, investigate or reposition if connection
repeatedly takes more than 30 minutes, false positives exceed 20% of reviewed incidents, or no
design partner will pay after receiving useful detection.

## Cohort and evidence record

Target three agency design partners and at least two agencies with production workflows connected.
For each partner, create one record outside Outtrace containing:

- agency and interview contact;
- pilot owner and operator;
- pilot start and planned review dates;
- selected production processes and source systems;
- onboarding start, first persisted non-duplicate test event, and production enablement times;
- client-reported incident time, when applicable;
- weekly operator check-in attendance;
- pricing interview outcome; and
- recovery interview notes and decision evidence.

Do not put ingestion secrets, customer payloads, authentication headers, or sensitive execution
URLs in the cohort record. Use process and incident identifiers when evidence needs to be reconciled
with Outtrace.

## Entry criteria

Before a partner starts:

- `npm run verify` passes against the release candidate.
- PostgreSQL and Redis backup, monitoring, and operational ownership are agreed for the pilot
  deployment.
- The partner has selected a process with a stable business key and can edit its n8n, Make, or
  custom HTTP steps.
- Expected stages, sources, required/optional status, timeouts, SLA, and owning teams are agreed.
- The metadata allowlist excludes customer payloads, credentials, message bodies, and other
  unnecessary personal or sensitive data.
- The partner can store the process credential in the source platform's encrypted connection or
  secret store.
- The partner understands the credential rotation and revocation procedure and that automatic
  workflow recovery is not available in this slice.

## Onboarding flow

### 1. Create a sandbox definition

Authenticate as a workspace owner and create the complete definition atomically:

```bash
curl --request POST "${OUTTRACE_API_BASE_URL}/v1/processes" \
  --header 'content-type: application/json' \
  --header "x-outtrace-operator-key-id: ${OUTTRACE_OPERATOR_KEY_ID}" \
  --header "x-outtrace-operator-key: ${OUTTRACE_OPERATOR_KEY}" \
  --data '{
    "clientId": "client_REPLACE_ME",
    "key": "client-onboarding-sandbox",
    "name": "Client onboarding sandbox",
    "environment": "sandbox",
    "slaSeconds": 1800,
    "metadataAllowlist": ["executionId", "executionUrl", "externalReference"],
    "stages": [
      {
        "key": "payment_received",
        "name": "Payment received",
        "required": true,
        "timeoutSeconds": 300,
        "source": "make",
        "owningTeam": "Revenue operations"
      },
      {
        "key": "account_created",
        "name": "Account created",
        "required": true,
        "timeoutSeconds": 600,
        "source": "custom",
        "owningTeam": "Platform"
      },
      {
        "key": "workspace_created",
        "name": "Workspace created",
        "required": true,
        "timeoutSeconds": 600,
        "source": "n8n",
        "owningTeam": "Automation"
      }
    ]
  }'
```

Stage array order is evaluation order. Process keys, environment, and stages cannot be edited after
creation in this pilot. Correct mistakes by creating a replacement process, verify it, and archive
the superseded process. New processes start with `lifecycleStatus: "active"`.

The `201` response contains the process, ordered stages, and:

```json
{
  "credential": {
    "keyId": "credential_identifier_returned_by_outtrace",
    "key": "plaintext_secret_returned_once",
    "createdAt": "2026-07-25T00:00:00.000Z"
  }
}
```

Copy the secret directly into the source platform's encrypted credential store, verify the copy,
and clear terminals, screenshots, clipboard managers, and notes that may retain it. Subsequent
process reads never return the plaintext secret.

If the secret is lost, an owner can issue another:

```bash
curl --request POST \
  "${OUTTRACE_API_BASE_URL}/v1/processes/process_REPLACE_ME/credentials" \
  --header "x-outtrace-operator-key-id: ${OUTTRACE_OPERATOR_KEY_ID}" \
  --header "x-outtrace-operator-key: ${OUTTRACE_OPERATOR_KEY}" \
  --header 'content-type: application/json' \
  --data '{}'
```

The replacement response is also shown once. Pass `{"revokeExisting":true}` to revoke prior active
credentials atomically. For a no-downtime rotation, leave the default `false`, canary the new key,
then revoke the prior credential by ID.

### 2. Instrument a sandbox execution

All sources send the same contract:

```bash
curl --request POST "${OUTTRACE_API_BASE_URL}/v1/events" \
  --header 'content-type: application/json' \
  --header "x-outtrace-key-id: ${OUTTRACE_PROCESS_KEY_ID}" \
  --header "x-outtrace-key: ${OUTTRACE_PROCESS_KEY}" \
  --data '{
    "eventId": "evt_unique_for_this_stage_attempt",
    "processKey": "client-onboarding-sandbox",
    "instanceKey": "customer_4821_sandbox",
    "stage": "workspace_created",
    "status": "completed",
    "source": "n8n",
    "occurredAt": "2026-07-25T08:00:00Z",
    "metadata": {
      "executionId": "sandbox-run-42",
      "executionUrl": "https://automation.example/executions/42"
    }
  }'
```

Use a unique, stable `eventId` for retry safety; retry the same event with the same ID. Use the same
stable `instanceKey` for every stage in one business-process occurrence. Stage and process keys must
exactly match the created definition. Send UTC RFC 3339 timestamps. Never place full payloads,
credentials, message bodies, tokens, or unapproved customer identifiers in metadata.

For n8n, use an HTTP Request node and store the two header values in an n8n credential. For Make,
use an HTTP Make a request module and store them in a secured connection or secret variable. For a
custom service, load both values from its runtime secret store. Do not paste either value into
source code, workflow names, logs, screenshots, or `VITE_*` variables.

The first persisted non-duplicate event changes the process from `awaiting_first_event` to
`connected`, persists `connectedAt`, and starts `lastEventAt`. Later newly persisted events advance
only `lastEventAt`. Confirm the timestamp survives an API restart. A connected state proves event
acceptance, not complete instrumentation; run at least one full successful sandbox instance through
every required stage.

### 3. Create and canary the production definition

Create a separate process with `"environment": "production"` and a production-specific immutable
key. Do not reuse the sandbox secret. Start with one low-risk production process and one source
workflow, then instrument the remaining stages and sources after the first event is visible.
Validate the definition in sandbox before creating production.

Confirm:

- the credential is accepted only for its exact production `processKey`;
- duplicate delivery creates one event;
- all stages correlate to the same process instance;
- execution links and allowlisted metadata are useful but minimized;
- a controlled failed or delayed test produces the expected incident; and
- Slack routing, if enabled, points to the intended pilot channel.

Record the time from the start of owner setup to the first persisted non-duplicate production event.
This is the activation time used in the onboarding evidence record; the product summary's
`medianSecondsToFirstEvent` uses persisted process creation and connection timestamps.

### 4. Replace, archive, or reactivate a definition

When stage rules must change, create and verify a new process with a distinct immutable key, move
the source integration to its credential, and archive the superseded process:

```bash
curl --request PATCH \
  "${OUTTRACE_API_BASE_URL}/v1/processes/process_REPLACE_ME" \
  --header 'content-type: application/json' \
  --header "x-outtrace-operator-key-id: ${OUTTRACE_OPERATOR_KEY_ID}" \
  --header "x-outtrace-operator-key: ${OUTTRACE_OPERATOR_KEY}" \
  --data '{"lifecycleStatus":"archived"}'
```

Only an owner can archive or reactivate. An archived process keeps its instances, events, incidents,
feedback, connection timestamps, and audit history, but it rejects new ingestion and is excluded
from the pilot activation denominator and the pilot summary's production process list. Previously
issued credentials must not bypass the archive.

For a controlled rollback, send the same request with `"lifecycleStatus": "active"`, restore the
source integration to that process and credential, and confirm a new event before archiving the
failed replacement.

## Incident review

Owners and operators with access to the incident's client can record feedback:

```bash
curl --request PUT \
  "${OUTTRACE_API_BASE_URL}/v1/incidents/incident_REPLACE_ME/feedback" \
  --header 'content-type: application/json' \
  --header "x-outtrace-operator-key-id: ${OUTTRACE_OPERATOR_KEY_ID}" \
  --header "x-outtrace-operator-key: ${OUTTRACE_OPERATOR_KEY}" \
  --data '{
    "verdict": "false_positive",
    "reason": "timeout_too_short",
    "note": "The production handoff normally completes in eight minutes."
  }'
```

Allowed false-positive reasons are `timeout_too_short`, `stage_not_required`,
`expected_sequence_variation`, `test_or_duplicate_traffic`, and `other`. A genuine verdict must not
include a false-positive reason:

```json
{
  "verdict": "genuine",
  "note": "Provisioning failed before the client reported it."
}
```

Feedback is independent of `open`, `acknowledged`, and `resolved`. Review the incident first, set
the verdict, then operate its lifecycle normally. If evidence changes, submitting feedback again
updates the verdict and creates another audit entry.

During the pilot:

- review every incident within one business day;
- record why false positives occurred, not merely that they were inconvenient;
- record the client's report time separately when testing early detection;
- do not mark uninvestigated or auto-resolved incidents as genuine; and
- revisit timeouts or definitions by creating a replacement process rather than changing the
  meaning of existing instances.

## Pilot summary and metric definitions

Owners and operators retrieve the fixed summary:

```bash
curl "${OUTTRACE_API_BASE_URL}/v1/pilot/summary" \
  --header "x-outtrace-operator-key-id: ${OUTTRACE_OPERATOR_KEY_ID}" \
  --header "x-outtrace-operator-key: ${OUTTRACE_OPERATOR_KEY}"
```

The incident-quality window is `[generatedAt - 28 days, generatedAt)`. It is server-fixed; clients
cannot select a more favorable range.

| Metric                      | Definition                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `incidentsDetected`         | Production-process incidents created inside the 28-day quality window              |
| `reviewedIncidents`         | `genuineIncidents + falsePositiveIncidents`                                        |
| `unreviewedIncidents`       | Detected incidents without a verdict                                               |
| `falsePositiveRate`         | `falsePositiveIncidents / reviewedIncidents`; `null` when the denominator is zero  |
| `totalProcesses`            | All active production processes, regardless of creation date                       |
| `connectedProcesses`        | Active production processes with a persisted first non-duplicate event             |
| `connectionRate`            | `connectedProcesses / totalProcesses`; zero when there are no production processes |
| `medianSecondsToFirstEvent` | Median creation-to-first-event time for connected production processes             |
| per-process `eventCount`    | Raw events currently retained for the process; not a lifetime or billing counter   |
| per-process `lastEventAt`   | Most recent accepted event time; absence may indicate telemetry drift              |

Never report `falsePositiveIncidents / incidentsDetected` as the false-positive rate. That hides an
unreviewed denominator. Include the reviewed and unreviewed counts whenever sharing the rate.
Sandbox incidents do not contribute to quality metrics. Archived production processes retain their
incident evidence, while archived processes do not contribute to activation. The 28-day restriction
applies to incident quality rather than the active production-process list. Retention can reduce
`eventCount`.

Review the summary at least weekly and at pilot close. Investigate an unexpectedly old
`lastEventAt`; it can mean a quiet process or broken instrumentation, so confirm against the source
platform before treating it as downtime.

## Pricing experiment

Run pricing interviews after the partner has seen their own production evidence. Do not implement
checkout, collect card details, or claim that plan limits are enforced.

Present the same three PRD offers to each partner:

| Offer      | Price      | Included hypothesis                          |
| ---------- | ---------- | -------------------------------------------- |
| Solo       | $49/month  | Five monitored processes                     |
| Agency     | $199/month | 25 monitored processes and five clients      |
| Agency Pro | $499/month | 100 monitored processes and client reporting |

Use this interview sequence:

1. Ask how the partner currently prices and absorbs monitoring and incident response.
2. Ask what the detected incidents and saved checking time were worth before showing prices.
3. Present all three offers with the same wording and ask which, if any, they would choose today.
4. Ask for the main objection, required proof, preferred limit, and whether they would accept a
   paid pilot or signed letter of intent.
5. Record the offer, answer, confidence, and exact follow-up action in the cohort evidence record.

A verbal preference is directional evidence. The PRD commercial signal is at least one agency
accepting a paid pilot; payment processing itself remains outside Outtrace.

## Recovery decision experiment

For every genuine incident, record:

- the manual recovery action and operator;
- systems touched and whether a safe API exists;
- whether the action was idempotent;
- approvals or client communication required;
- time spent and business impact;
- whether a link, checklist, suggested playbook, or approved replay would have helped; and
- the worst credible consequence of performing the action twice or on the wrong instance.

At pilot close, group repeated recovery patterns. Recommend a later recovery milestone only when
the evidence identifies a frequent, valuable action with a clear authorization boundary,
idempotency strategy, audit record, and safe failure behavior. Otherwise retain monitoring-only
scope. Do not run customer actions, retries, replays, compensations, or AI remediation during this
experiment.

## Rollout

1. Back up the pilot database and record the application and migration versions.
2. Apply the new numbered migration; never edit an already-applied migration.
3. Run `npm run verify` and the manual smoke checklist below.
4. Create a sandbox process and validate a complete successful instance.
5. Create one production canary and monitor event acceptance, outbox state, incident quality, and
   notification delivery.
6. Expand one source and stage at a time. Keep a source-side rollback prepared.
7. For a replacement definition, move every source stage and verify the new timeline before
   archiving the superseded process.
8. Review connection freshness and unreviewed incidents daily for the first week, then weekly.

## Rollback and credential incidents

To roll back a source integration, disable its Outtrace HTTP steps and remove the process secret
from the source platform. This stops new telemetry without deleting pilot evidence. Leave the
additive database migration applied; do not attempt an ad hoc destructive down migration.

An application rollback is allowed only to a revision verified against the migrated schema. Keep
PostgreSQL data and audit history intact. After recovery, retry an event with its original
`eventId` to preserve idempotency.

For a definition rollout failure, archive the failed replacement, reactivate the prior process,
restore its source-side credential and process key, and verify a new event. Archival is reversible
and preserves evidence; it is the preferred process-level rollback over deletion.

If a process secret may be compromised, stop that source integration and immediately revoke the
credential through the owner API. For planned rotation, either issue a replacement with
`revokeExisting: true` or canary the replacement before revoking the old credential. Follow the
[production runbook](production-runbook.md) and verify that the revoked key returns `401` before
resuming.

## Manual smoke checklist

Complete this checklist against the release candidate with PostgreSQL and Redis running:

- [ ] Migrations apply to a populated Phase 3 database and a second run is a no-op.
- [ ] Existing workspace and member credentials still authenticate after migration.
- [ ] A viewer cannot create, archive, or reactivate a process, issue a process credential, submit
      feedback, or read the pilot summary.
- [ ] An owner creates a sandbox process and receives ordered stages plus a plaintext credential
      exactly once.
- [ ] Process reads and logs never return the plaintext secret or secret hash.
- [ ] The process credential accepts its matching `processKey` and rejects a different process key.
- [ ] Retrying the same event returns the existing process instance and creates no duplicate event.
- [ ] The first persisted non-duplicate event sets `connectedAt`; later newly persisted events
      update `lastEventAt`; both survive API and worker restarts.
- [ ] Sandbox processes are absent from production activation metrics.
- [ ] Sandbox incidents are absent from the 28-day production quality metrics.
- [ ] Archiving a production process removes it from activation and the pilot summary's production
      process list without deleting its incidents, feedback, timestamps, or audit history.
- [ ] Every credential for an archived process is rejected by event ingestion.
- [ ] Reactivating the process makes it eligible for activation again and allows a valid
      process-scoped credential to ingest its exact `processKey`.
- [ ] A production n8n event and Make event with one `instanceKey` appear in one timeline.
- [ ] Controlled failure, missing-stage, SLA, and sequence cases produce the expected incidents.
- [ ] An owner or operator can save genuine feedback and each valid false-positive reason; invalid
      combinations are rejected.
- [ ] Feedback does not resolve an incident, and automatic resolution does not remove feedback.
- [ ] Cross-workspace and restricted-client reads, writes, and summary queries do not leak data.
- [ ] The pilot summary uses the half-open 28-day quality window, exposes unreviewed incidents, and
      returns `null` for false-positive rate when no incidents are reviewed.
- [ ] Atomic replacement returns a new plaintext secret once, immediately rejects prior keys, and
      records creation and revocation audit entries.
- [ ] Ingestion remains below 500 milliseconds at representative pilot load; events appear in the
      dashboard within 10 seconds; configured Slack notifications arrive within one minute.
- [ ] `npm run verify` passes with no checked-in secrets, logs, reports, or customer data.

## Exit review

At pilot close, publish a decision note containing:

- connected agencies and production processes;
- median observed connection time and the product summary activation metrics;
- detected, reviewed, genuine, false-positive, and unreviewed incident counts;
- detection-before-client-report evidence;
- weekly operator return evidence;
- pricing offers and commitments;
- recovery patterns and the recovery go/no-go decision;
- security or reliability incidents; and
- the decision to proceed, adjust, pause, or reposition against the PRD thresholds.

Do not delete raw evidence before its retention deadline merely to improve the summary. Preserve
incident feedback, audit records, and the metric definitions used for the decision.
