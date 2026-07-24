ALTER TABLE workspaces
ADD COLUMN event_retention_days integer NOT NULL DEFAULT 30
CHECK (event_retention_days BETWEEN 1 AND 3650);

ALTER TABLE processes
ADD COLUMN metadata_allowlist text[] NOT NULL DEFAULT ARRAY[
  'clientId',
  'environment',
  'executionId',
  'executionUrl',
  'externalReference',
  'region'
]::text[]
CHECK (cardinality(metadata_allowlist) <= 32);

CREATE TABLE workspace_members (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  email text NOT NULL CHECK (btrim(email) <> ''),
  role text NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  access_key_id text NOT NULL UNIQUE CHECK (btrim(access_key_id) <> ''),
  access_key_hash text NOT NULL CHECK (access_key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, email)
);

CREATE INDEX workspace_members_workspace_idx
ON workspace_members (workspace_id, role, status);

CREATE TABLE member_client_access (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id text NOT NULL,
  client_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, client_id),
  FOREIGN KEY (workspace_id, member_id)
    REFERENCES workspace_members(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, client_id)
    REFERENCES clients(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX member_client_access_workspace_idx
ON member_client_access (workspace_id, member_id, client_id);

CREATE TABLE workspace_audit_log (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_member_id text,
  actor_name text NOT NULL CHECK (btrim(actor_name) <> ''),
  action text NOT NULL CHECK (btrim(action) <> ''),
  entity_type text NOT NULL CHECK (btrim(entity_type) <> ''),
  entity_id text NOT NULL CHECK (btrim(entity_id) <> ''),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, actor_member_id)
    REFERENCES workspace_members(workspace_id, id)
);

CREATE INDEX workspace_audit_workspace_idx
ON workspace_audit_log (workspace_id, created_at DESC);

CREATE TABLE retention_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  events_deleted integer NOT NULL DEFAULT 0 CHECK (events_deleted >= 0),
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX retention_runs_workspace_idx
ON retention_runs (workspace_id, completed_at DESC);
