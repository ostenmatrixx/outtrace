# OpenFlow

OpenFlow is a cross-platform business-process observability product for automation agencies. Phase
1 implements the first complete telemetry path:

```text
n8n / Make / custom service
  → authenticated POST /v1/events
  → validation and metadata minimization
  → idempotent PostgreSQL persistence
  → process-instance correlation
  → inspectable response
```

Incident detection and operational incident workflows begin in Phase 2; they are intentionally not
part of this milestone.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- Docker with Docker Compose

## Quick start

1. Create the local environment file and install dependencies.

   ```bash
   nvm use
   cp .env.example .env
   npm install
   ```

2. Start PostgreSQL and Redis.

   ```bash
   docker compose up -d --wait
   docker compose ps
   ```

3. Apply migrations and create the opt-in development workspace, client, process, and hashed
   ingestion credential.

   ```bash
   npm run db:migrate
   ```

   The checked-in example sets `OPENFLOW_SEED_DEVELOPMENT=true` and uses a public, local-only test
   secret. The API refuses this seed when `NODE_ENV=production`. Never reuse the example secret.

4. Start the API, worker, and dashboard together.

   ```bash
   npm run dev
   ```

   The default endpoints are:

   - API: `http://localhost:3000`
   - API health: `http://localhost:3000/health`
   - Dashboard: the Vite URL printed in the terminal, normally `http://localhost:5173`

## Send a test event

With the values from `.env.example`:

```bash
curl --request POST http://localhost:3000/v1/events \
  --header 'content-type: application/json' \
  --header 'x-openflow-key-id: dev_local' \
  --header 'x-openflow-key: openflow_dev_ingestion_key' \
  --data '{
    "eventId": "evt_01JZ5A8W9TQXM2YF7K3N6R4P1C",
    "processKey": "client-onboarding",
    "instanceKey": "customer_4821",
    "stage": "workspace_created",
    "status": "completed",
    "source": "n8n",
    "occurredAt": "2026-07-23T10:30:00Z",
    "metadata": {
      "clientId": "client_acme",
      "executionUrl": "https://n8n.example.com/execution/9281",
      "token": "this value is never stored",
      "unknownField": "this field is discarded"
    },
    "unknownTopLevel": "discarded by the contract"
  }'
```

A first request returns HTTP 202 with a stable process-instance identifier:

```json
{
  "eventId": "evt_01JZ5A8W9TQXM2YF7K3N6R4P1C",
  "processInstanceId": "pi_...",
  "accepted": true,
  "duplicate": false
}
```

Sending the same event again returns HTTP 200 with `"duplicate": true` and the same
`processInstanceId`; it does not add another event row. Make and custom-service payloads use the
same shape with `"source": "make"` or `"source": "custom"`.

Inspect the stored, minimized record:

```bash
docker compose exec postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT external_event_id, process_instance_id, metadata
    FROM events
    WHERE external_event_id = '\''evt_01JZ5A8W9TQXM2YF7K3N6R4P1C'\'';
  "'
```

This returns one event row. Sending another event with the same `processKey` and `instanceKey`
returns the same process-instance ID.

## Development commands

| Command                    | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `npm run dev`              | Run the API, worker, and dashboard                         |
| `npm run db:migrate`       | Apply pending SQL migrations and optional development seed |
| `npm run format`           | Format source and documentation                            |
| `npm run format:check`     | Verify formatting                                          |
| `npm run lint`             | Run ESLint                                                 |
| `npm run typecheck`        | Type-check every workspace                                 |
| `npm test`                 | Run unit tests                                             |
| `npm run test:integration` | Run PostgreSQL integration tests                           |
| `npm run build`            | Build contracts and all applications                       |
| `npm run verify`           | Run the complete Phase 1 quality suite                     |

The integration command loads `TEST_DATABASE_URL` from the root `.env` and fails if it is missing
or unreachable. It creates a random PostgreSQL schema, migrates and tests inside it, then removes
it. `npm run verify` therefore requires PostgreSQL to be running. Keep tests away from databases
with valuable data.

Applied migration files are immutable: create a new numbered migration instead of editing one
already applied. Re-running the development seed upserts its known workspace, client, and process
and updates the seeded credential hash.

## Environment reference

Only `DEV_INGESTION_KEY` and `POSTGRES_PASSWORD` are secrets. Variables prefixed with `VITE_` are
compiled into browser code and must never contain credentials.

| Variable                                            | Consumer          | Required/default                 | Notes                                           |
| --------------------------------------------------- | ----------------- | -------------------------------- | ----------------------------------------------- |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Compose           | Local defaults in `.env.example` | PostgreSQL container bootstrap                  |
| `POSTGRES_PORT`                                     | Compose           | `5432`                           | Loopback-only host port                         |
| `DATABASE_URL`                                      | API/migrations    | Required                         | PostgreSQL connection URL                       |
| `TEST_DATABASE_URL`                                 | Integration tests | Required by integration/verify   | Must permit temporary schemas                   |
| `REDIS_PORT`                                        | Compose           | `6379`                           | Loopback-only host port                         |
| `REDIS_URL`                                         | API/worker        | Required                         | `redis://` or `rediss://`                       |
| `NODE_ENV`                                          | API/migrations    | `development`                    | Development seeding is rejected in `production` |
| `API_HOST`, `API_PORT`                              | API               | `127.0.0.1`, `3000`              | Listen address and port                         |
| `API_CORS_ORIGIN`                                   | API               | `http://localhost:5173`          | Must exactly match the dashboard origin         |
| `LOG_LEVEL`                                         | API               | `info`                           | Fastify log level                               |
| `OPENFLOW_SEED_DEVELOPMENT`                         | Migrations        | `false` in code                  | Enables the local-only seed                     |
| `DEV_INGESTION_KEY_ID`, `DEV_INGESTION_KEY`         | Seed              | Required when seed enabled       | Public example values are local-only            |
| `DEV_WORKSPACE_ID`, `DEV_CLIENT_ID`                 | Seed              | Required when seed enabled       | Stable local identifiers                        |
| `DEV_PROCESS_ID`, `DEV_PROCESS_KEY`                 | Seed              | Required when seed enabled       | Stable local process                            |
| `WORKER_CONCURRENCY`                                | Worker            | `5`, range 1–100                 | Parallel BullMQ jobs                            |
| `WORKER_LOCK_DURATION_MS`                           | Worker            | `30000`, range 5000–600000       | BullMQ lock duration                            |
| `WORKER_SHUTDOWN_TIMEOUT_MS`                        | Worker            | `30000`, range 100–120000        | Total shutdown deadline                         |
| `REDIS_CONNECT_TIMEOUT_MS`                          | Worker            | `10000`, range 100–120000        | Initial Redis connection timeout                |
| `VITE_API_BASE_URL`                                 | Dashboard         | `http://localhost:3000`          | Public browser-visible API origin               |

## Repository layout

```text
apps/
  api/        Fastify ingestion API, migration runner, and persistence service
  worker/     BullMQ/Redis worker foundation for later incident evaluation
  dashboard/  React/Vite operational shell and dependency-health view
packages/
  contracts/  Shared Zod request, response, health, error, and queue contracts
database/
  migrations/ Explicit PostgreSQL migrations
docs/
  architecture/ Architecture decisions
```

## Ingestion behavior

The shared contract accepts the initial sources `n8n`, `make`, and `custom`, and statuses `started`,
`completed`, and `failed`. Unknown top-level fields are stripped.

Only these metadata fields are eligible for persistence:

- `clientId`
- `executionId`
- `executionUrl`
- `externalReference`
- `environment`
- `region`

Sensitive keys are recursively replaced before the allowlist is applied. Matching is
case-insensitive for password, passwd, token, secret, authorization, apiKey, api_key, cookie, and
session. Persisted allowlisted values are bounded operational strings; arrays, objects, oversized
values, invalid execution URLs, and unknown metadata fields are discarded.

## Authentication and tenant isolation

Clients send a non-secret key identifier in `x-openflow-key-id` and its secret in
`x-openflow-key`. PostgreSQL stores only the SHA-256 secret hash. The API hashes the presented
secret and performs constant-time comparison.

Authentication resolves the workspace before process lookup. Process lookup, event idempotency, and
all persisted relationships are scoped to that workspace. Process keys are unique per workspace
because the Phase 1 event contract contains no independent client selector.

The ingestion route is rate-limited before database persistence. The limit is keyed from the
request origin and ingestion-key identifier; `429` responses include retry guidance without
echoing the identifier.

Never place an ingestion key in `VITE_*` variables or dashboard source. Variables prefixed with
`VITE_` are compiled into browser assets.

## Persistence guarantees

- `(process_id, instance_key)` is unique, so correlated events share one process instance even under
  concurrent requests.
- `(workspace_id, external_event_id)` is unique, so duplicate event IDs cannot create two events.
- Correlation, event insertion, and instance-state changes occur in one PostgreSQL transaction.
- Out-of-order events remain in the timeline, `started_at` tracks the earliest event, and current
  state uses `occurredAt` plus external event ID as a deterministic tie-breaker.
- Database errors are converted to safe structured responses; SQL, credentials, and stack traces are
  not returned.

## API responses

| HTTP  | Code or response          | Meaning                                                 |
| ----- | ------------------------- | ------------------------------------------------------- |
| `202` | ingestion response        | A new event was accepted                                |
| `200` | ingestion response        | A duplicate was accepted idempotently                   |
| `200` | health response           | Health is `ok` or `degraded`; inspect dependency states |
| `400` | `INVALID_PAYLOAD`         | Malformed JSON, invalid contract, or unsupported source |
| `400` | `UNSUPPORTED_STATUS`      | Status is not `started`, `completed`, or `failed`       |
| `401` | `AUTHENTICATION_REQUIRED` | One or both ingestion headers are missing               |
| `401` | `AUTHENTICATION_INVALID`  | The key identifier or secret is invalid                 |
| `404` | `UNKNOWN_PROCESS`         | Process key is absent from the authenticated workspace  |
| `429` | rate-limit error          | Too many ingestion attempts; retry later                |
| `503` | `DATABASE_FAILURE`        | Persistence failed; retry with the same `eventId`       |
| `500` | `INTERNAL_ERROR`          | Safe unexpected-error response                          |

Errors use one envelope:

```json
{
  "error": {
    "code": "INVALID_PAYLOAD",
    "message": "The event payload is invalid.",
    "details": {
      "issues": [{ "path": ["eventId"], "message": "Invalid input" }]
    }
  }
}
```

## Health and worker foundation

`GET /health` reports API status and separate PostgreSQL/Redis reachability. Dependency failures
produce a degraded result, which the dashboard exposes with text and icons rather than color alone.

The BullMQ worker consumes the shared incident-evaluation queue contract, validates job data, and
returns an explicit Phase 2 no-op result. Phase 1 does not enqueue or evaluate incidents. This is
deliberate: durable queue delivery and incident rules will be designed together in Phase 2.

## Phase 1 boundaries

- The dashboard is a health-only operational shell; it has no process-management or timeline UI.
- `stage` is validated as an identifier but is not yet checked against `process_stages`.
- There is no client/process provisioning UI, credential rotation workflow, or event read API.
- The API does not enqueue events yet; outbox delivery, incident persistence/rules, retention,
  roles, audit logs, and notifications begin in later phases.
- Compose runs PostgreSQL and Redis only, not application containers.
- Production deployment, CI, backups/recovery, and full browser end-to-end coverage remain Phase 6
  work.

## Troubleshooting

### Authentication fails locally

Confirm that `OPENFLOW_SEED_DEVELOPMENT=true` was set when `npm run db:migrate` ran and that both
headers match `DEV_INGESTION_KEY_ID` and `DEV_INGESTION_KEY`. Rerunning migrations is safe.

### The process is unknown

The development seed creates the `DEV_PROCESS_KEY` from the environment. The request's
`processKey` must match it exactly and the process must belong to the authenticated workspace.

### Health is degraded

Run `docker compose ps` and inspect service logs with:

```bash
docker compose logs postgres redis
```

Then verify `DATABASE_URL` and `REDIS_URL` point at those services.

### Port conflict

Set `POSTGRES_PORT` or `REDIS_PORT` before starting Compose, and update `DATABASE_URL` or `REDIS_URL`
to match. The dashboard intentionally requires port 5173; if `API_PORT` changes, update
`VITE_API_BASE_URL`. If the dashboard origin changes, `API_CORS_ORIGIN` must match it exactly.

## Shutdown and cleanup

Press `Ctrl-C` to stop the API, worker, and dashboard. Stop local dependencies with:

```bash
docker compose down
```

`docker compose down -v` also permanently deletes the local PostgreSQL and Redis volumes. Use it
only when you intend to reset all local data.

## Source-control hygiene

`.env`, dependencies, `dist`, coverage, logs, test reports, and Playwright artifacts are ignored.
Do not force-add them. Only `.env.example` is intended for source control, and its credential is a
public local-development value.

## Architecture records

- [Phase 0 engineering brief](docs/phase-0.md)
- [ADR 0001: Phase 1 foundation and ingestion boundaries](docs/architecture/0001-phase-1-foundation.md)
- [Product requirements](OPENFLOW_PRD.md)
