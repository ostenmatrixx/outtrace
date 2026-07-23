CREATE TABLE workspaces (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  ingestion_key_id text NOT NULL UNIQUE CHECK (btrim(ingestion_key_id) <> ''),
  ingestion_key_hash text NOT NULL CHECK (ingestion_key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clients (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX clients_workspace_id_idx ON clients (workspace_id);

CREATE TABLE processes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  key text NOT NULL CHECK (btrim(key) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  sla_seconds integer CHECK (sla_seconds IS NULL OR sla_seconds > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, key),
  FOREIGN KEY (workspace_id, client_id)
    REFERENCES clients(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX processes_client_id_idx ON processes (workspace_id, client_id);

CREATE TABLE process_stages (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  process_id text NOT NULL,
  key text NOT NULL CHECK (btrim(key) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  position integer NOT NULL CHECK (position >= 0),
  required boolean NOT NULL DEFAULT true,
  timeout_seconds integer CHECK (timeout_seconds IS NULL OR timeout_seconds > 0),
  source text CHECK (source IS NULL OR btrim(source) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (process_id, key),
  UNIQUE (process_id, position),
  FOREIGN KEY (workspace_id, process_id)
    REFERENCES processes(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX process_stages_process_id_idx ON process_stages (workspace_id, process_id, position);

CREATE TABLE process_instances (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  process_id text NOT NULL,
  instance_key text NOT NULL CHECK (btrim(instance_key) <> ''),
  status text NOT NULL DEFAULT 'started' CHECK (btrim(status) <> ''),
  current_stage text,
  latest_event_occurred_at timestamptz,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (process_id, instance_key),
  FOREIGN KEY (workspace_id, process_id)
    REFERENCES processes(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX process_instances_workspace_updated_idx
  ON process_instances (workspace_id, updated_at DESC);
CREATE INDEX process_instances_process_status_idx
  ON process_instances (workspace_id, process_id, status);

CREATE TABLE events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  process_instance_id text NOT NULL,
  external_event_id text NOT NULL CHECK (btrim(external_event_id) <> ''),
  stage text NOT NULL CHECK (btrim(stage) <> ''),
  status text NOT NULL CHECK (btrim(status) <> ''),
  source text NOT NULL CHECK (btrim(source) <> ''),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, external_event_id),
  FOREIGN KEY (workspace_id, process_instance_id)
    REFERENCES process_instances(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX events_instance_occurred_idx
  ON events (workspace_id, process_instance_id, occurred_at, received_at);
CREATE INDEX events_workspace_received_idx ON events (workspace_id, received_at DESC);
