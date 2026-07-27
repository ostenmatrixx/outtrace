# Production runbook

This runbook is the operational contract for a production Outtrace deployment. PostgreSQL is the
system of record. Redis carries BullMQ work and must use persistence, but a Redis backup never
replaces the PostgreSQL backup.

## Release prerequisites

- Managed PostgreSQL 17 with a hostname-valid certificate, encrypted storage, automated backups,
  and point-in-time recovery. The connection URL must use `sslmode=verify-full`.
- Managed Redis 7.4 with TLS, authentication, AOF or equivalent persistence, and eviction disabled.
- An HTTPS ingress or load balancer for the API and dashboard.
- A secret manager capable of mounting values as read-only files.
- Centralized JSON log collection and alerts for failed readiness checks, worker cycle failures,
  queue depth, PostgreSQL saturation, and Redis memory or connection failures.

Do not deploy with the development seed, example credentials, public database ports, or plaintext
secrets in Compose environment values.

`NODE_ENV=production` rejects legacy workspace-wide operator and ingestion credentials. Before
upgrading an existing environment, verify that every workspace has an active owner member key and
that every source has a process-scoped ingestion key. Revoke or remove the old secrets from their
external stores after the cutover.

## Secrets

The production Compose file expects three host paths supplied by the deployment secret manager:

- `OUTTRACE_DATABASE_URL_FILE`: a file containing the TLS PostgreSQL connection URL;
- `OUTTRACE_REDIS_URL_FILE`: a file containing the TLS Redis connection URL; and
- `OUTTRACE_SLACK_WEBHOOK_URLS_FILE`: a file containing a JSON object that maps each workspace ID to
  its own HTTPS incoming webhook.

Example structure, using placeholders only:

```json
{
  "ws_agency_one": "https://hooks.slack.com/services/REDACTED",
  "ws_agency_two": "https://hooks.slack.com/services/REDACTED"
}
```

Never route multiple workspaces through an unscoped webhook. Rotate a Slack webhook in the secret
manager, redeploy the worker, confirm `/ready`, and then revoke the old webhook in Slack.

The API and worker accept `DATABASE_URL_FILE` and `REDIS_URL_FILE`. Direct URL variables remain
available for local development, but setting both the direct and file form is rejected.

## Deploy

Set only public deployment values in the shell:

```bash
export OUTTRACE_DASHBOARD_ORIGIN='https://app.example.com'
export OUTTRACE_PUBLIC_API_URL='https://api.example.com'
export OUTTRACE_DATABASE_URL_FILE='/secure/runtime/database_url'
export OUTTRACE_REDIS_URL_FILE='/secure/runtime/redis_url'
export OUTTRACE_SLACK_WEBHOOK_URLS_FILE='/secure/runtime/slack_webhook_urls.json'
docker compose -f docker-compose.production.yml build --pull
docker compose -f docker-compose.production.yml up -d
```

The one-shot `migrate` service must complete successfully before the API or worker starts. Migration
files are immutable and applied under a PostgreSQL advisory lock.

Validate:

```bash
curl --fail --silent --show-error https://api.example.com/live
curl --fail --silent --show-error https://api.example.com/ready
curl --fail --silent --show-error https://app.example.com/healthz
docker compose -f docker-compose.production.yml ps
```

The worker exposes `/live` and `/ready` on port 3001 inside its container. Keep this port private to
the orchestrator.

## Bootstrap a workspace

After migrations succeed, create each production workspace and its first owner through the
one-shot bootstrap command. The command fails if the workspace ID already exists, writes an audit
entry, and does not create a legacy workspace-wide ingestion credential.

```bash
umask 077
docker compose -f docker-compose.production.yml run --rm \
  --env OUTTRACE_BOOTSTRAP_WORKSPACE_ID='ws_agency_one' \
  --env OUTTRACE_BOOTSTRAP_WORKSPACE_NAME='Agency One' \
  --env OUTTRACE_BOOTSTRAP_OWNER_NAME='Initial Owner' \
  --env OUTTRACE_BOOTSTRAP_OWNER_EMAIL='owner@example.com' \
  api node apps/api/dist/bootstrap-workspace.js > workspace-bootstrap.json
```

The output contains the initial member key once. Move it directly into the owner’s approved secret
manager, validate `GET /v1/session`, and then remove the local bootstrap file according to the
organization’s secure-file procedure. A page refresh or **Lock inbox** removes the key from the
dashboard because operator credentials are retained only in memory.

## Credential rotation and revocation

Only a workspace owner can inspect credential metadata, issue replacements, or revoke a
process-scoped ingestion credential. Plaintext keys are returned once.

List credential metadata:

```bash
curl --request GET "${OUTTRACE_API_BASE_URL}/v1/processes/${PROCESS_ID}/credentials" \
  --header "x-outtrace-operator-key-id: ${OUTTRACE_OPERATOR_KEY_ID}" \
  --header "x-outtrace-operator-key: ${OUTTRACE_OPERATOR_KEY}"
```

Atomically issue a replacement and revoke every existing active credential:

```bash
curl --request POST "${OUTTRACE_API_BASE_URL}/v1/processes/${PROCESS_ID}/credentials" \
  --header 'content-type: application/json' \
  --header "x-outtrace-operator-key-id: ${OUTTRACE_OPERATOR_KEY_ID}" \
  --header "x-outtrace-operator-key: ${OUTTRACE_OPERATOR_KEY}" \
  --data '{"revokeExisting":true}'
```

To avoid downtime, issue without revocation, update the source secret, send a canary event, then
revoke the old credential:

```bash
curl --request POST \
  "${OUTTRACE_API_BASE_URL}/v1/processes/${PROCESS_ID}/credentials/${CREDENTIAL_ID}/revoke" \
  --header 'content-type: application/json' \
  --header "x-outtrace-operator-key-id: ${OUTTRACE_OPERATOR_KEY_ID}" \
  --header "x-outtrace-operator-key: ${OUTTRACE_OPERATOR_KEY}" \
  --data '{"reason":"Rotation completed after source canary"}'
```

Revocation is immediate for the next authentication attempt and is recorded in the workspace audit
log.

Rotate a member credential atomically:

```bash
curl --request POST \
  "${OUTTRACE_API_BASE_URL}/v1/members/${MEMBER_ID}/credentials/rotate" \
  --header "x-outtrace-operator-key-id: ${OUTTRACE_OPERATOR_KEY_ID}" \
  --header "x-outtrace-operator-key: ${OUTTRACE_OPERATOR_KEY}"
```

The prior member key stops authenticating immediately. Disabling a member also destroys the stored
key so re-enabling cannot resurrect it. To restore access safely, rotate the credential while the
member remains disabled, deliver the new key, and then re-enable the member.

## Backups and restore tests

- Enable PostgreSQL point-in-time recovery and retain daily backups according to contractual and
  regulatory requirements.
- Encrypt backups with a key separate from the database credentials.
- Run a monthly restore drill into an isolated account, apply `npm run db:migrate`, and execute the
  integration and smoke suites against the restored copy.
- Back up Redis or use managed persistence to reduce queue recovery time.
- Record recovery point, recovery time, row-count checks, and smoke-test evidence for each drill.

Expired event rows for incomplete instances or instances with unresolved incidents are held as
active operational evidence until the instance completes and its incidents resolve. Monitor these
deferred rows and close abandoned pilot instances through an explicit operational review; never
delete evidence merely to force the retention counter down.

Lightweight event-ID receipts default to 365 days. Sources must use globally unique event IDs and
must not rely on retries beyond the configured `IDEMPOTENCY_RETENTION_DAYS` horizon. A receipt is not
pruned while its raw event or evaluation outbox row still exists.

For PostgreSQL logical backup tooling, use a restricted backup identity:

```bash
pg_dump --format=custom --no-owner --file=outtrace.dump "${DATABASE_URL}"
pg_restore --clean --if-exists --no-owner --dbname="${RESTORE_DATABASE_URL}" outtrace.dump
```

Do not run `--clean` against production. Restore into an isolated database first.

If Redis is lost after PostgreSQL is restored, stop all workers, provision an empty persistent Redis
instance, and republish evaluation outbox rows in controlled time windows by setting their
`published_at` to `NULL`. Incident evaluation is idempotent, but this can create substantial queue
load; start with the outage window, monitor database and queue saturation, and widen only when
needed. Notification outbox rows must not be reset without operator review because Slack does not
provide an idempotency key.

## Rollback and incident response

1. Stop ingestion at the ingress if data integrity or tenant isolation is at risk.
2. Preserve API, worker, PostgreSQL, Redis, and ingress logs.
3. Roll application images back to the last verified digest.
4. Do not roll back migration files. Production migrations must follow expand-and-contract
   compatibility so the previous image can run against the upgraded schema.
5. If a process credential may be exposed, revoke it before restoring source traffic.
6. If a Slack mapping is wrong, stop the worker, correct the workspace mapping, rotate the exposed
   webhook, inspect pending notification rows, and then restart.
7. Confirm API and worker readiness, ingest a retry-stable canary event, and verify one event, one
   evaluation, and the intended workspace notification destination.

## Required release evidence

- CI passes formatting, linting, type checks, unit tests, PostgreSQL/Redis integration tests,
  production builds, dependency audit, and all three container builds.
- Migrations pass on a clean database and an upgraded staging database.
- Workspace bootstrap creates one active owner, no legacy ingestion key, and an auditable record.
- API and worker readiness fail when PostgreSQL or Redis is unavailable.
- Two-workspace notification tests prove that each webhook receives only its own workspace data.
- Concurrent notification delivery tests prove that one pending row is claimed by only one worker.
- A restore drill and credential-rotation canary have current recorded evidence.
