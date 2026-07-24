ALTER TABLE workspaces
ADD COLUMN operator_key_id text,
ADD COLUMN operator_key_hash text;

ALTER TABLE workspaces
ADD CONSTRAINT workspaces_operator_key_id_nonempty
CHECK (operator_key_id IS NULL OR btrim(operator_key_id) <> ''),
ADD CONSTRAINT workspaces_operator_key_hash_format
CHECK (operator_key_hash IS NULL OR operator_key_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX workspaces_operator_key_id_idx
ON workspaces (operator_key_id)
WHERE operator_key_id IS NOT NULL;

CREATE TABLE incidents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  process_instance_id text NOT NULL,
  incident_type text NOT NULL CHECK (
    incident_type IN (
      'reported_failure',
      'missing_stage',
      'sla_violation',
      'unexpected_sequence'
    )
  ),
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  affected_stage text,
  technical_message text NOT NULL CHECK (btrim(technical_message) <> ''),
  business_message text NOT NULL CHECK (btrim(business_message) <> ''),
  source text,
  execution_url text,
  assigned_to text,
  notification_version integer NOT NULL DEFAULT 1 CHECK (notification_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolution_reason text CHECK (
    resolution_reason IS NULL OR resolution_reason IN ('operator', 'condition_cleared')
  ),
  FOREIGN KEY (workspace_id, process_instance_id)
    REFERENCES process_instances(workspace_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX incidents_instance_rule_idx
ON incidents (
  process_instance_id,
  incident_type,
  COALESCE(affected_stage, '')
);

CREATE INDEX incidents_workspace_inbox_idx
ON incidents (workspace_id, status, severity, created_at DESC);

CREATE INDEX incidents_instance_idx
ON incidents (workspace_id, process_instance_id, created_at);

CREATE TABLE incident_notes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  incident_id text NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  author text NOT NULL CHECK (btrim(author) <> ''),
  body text NOT NULL CHECK (btrim(body) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incident_notes_incident_idx
ON incident_notes (workspace_id, incident_id, created_at);

CREATE TABLE incident_audit_log (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  incident_id text NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (
    action IN ('created', 'reopened', 'acknowledged', 'resolved', 'assigned', 'note_added')
  ),
  actor text NOT NULL CHECK (btrim(actor) <> ''),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incident_audit_incident_idx
ON incident_audit_log (workspace_id, incident_id, created_at);

CREATE TABLE event_evaluation_outbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  process_instance_id text NOT NULL,
  external_event_id text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, external_event_id),
  FOREIGN KEY (workspace_id, process_instance_id)
    REFERENCES process_instances(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX event_evaluation_outbox_pending_idx
ON event_evaluation_outbox (available_at, created_at)
WHERE published_at IS NULL;

CREATE TABLE incident_notification_outbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  incident_id text NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  notification_version integer NOT NULL CHECK (notification_version > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, notification_version)
);

CREATE INDEX incident_notification_outbox_pending_idx
ON incident_notification_outbox (available_at, created_at)
WHERE sent_at IS NULL;
