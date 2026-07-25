ALTER TABLE processes
ADD COLUMN environment text NOT NULL DEFAULT 'sandbox'
  CHECK (environment IN ('sandbox', 'production')),
ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'active'
  CHECK (lifecycle_status IN ('active', 'archived')),
ADD COLUMN connected_at timestamptz,
ADD COLUMN last_event_received_at timestamptz,
ADD CONSTRAINT processes_connection_times_ordered CHECK (
  connected_at IS NULL
  OR last_event_received_at IS NULL
  OR connected_at <= last_event_received_at
);

ALTER TABLE process_stages
ADD COLUMN owning_team text
  CHECK (owning_team IS NULL OR btrim(owning_team) <> '');

CREATE TABLE process_ingestion_credentials (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  process_id text NOT NULL,
  key_id text NOT NULL UNIQUE CHECK (btrim(key_id) <> ''),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  created_by_member_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, process_id)
    REFERENCES processes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by_member_id)
    REFERENCES workspace_members(workspace_id, id)
);

CREATE INDEX process_ingestion_credentials_process_idx
ON process_ingestion_credentials (workspace_id, process_id, created_at DESC);

ALTER TABLE incidents
ADD CONSTRAINT incidents_workspace_id_id_unique UNIQUE (workspace_id, id);

CREATE TABLE incident_feedback (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  incident_id text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('genuine', 'false_positive')),
  reason text CHECK (
    reason IS NULL OR reason IN (
      'timeout_too_short',
      'stage_not_required',
      'expected_sequence_variation',
      'test_or_duplicate_traffic',
      'other'
    )
  ),
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  reviewed_by_member_id text,
  reviewed_by_name text NOT NULL CHECK (btrim(reviewed_by_name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, incident_id),
  FOREIGN KEY (workspace_id, incident_id)
    REFERENCES incidents(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, reviewed_by_member_id)
    REFERENCES workspace_members(workspace_id, id),
  CHECK (
    (verdict = 'genuine' AND reason IS NULL)
    OR (verdict = 'false_positive' AND reason IS NOT NULL)
  )
);

CREATE INDEX incident_feedback_workspace_verdict_idx
ON incident_feedback (workspace_id, verdict, updated_at DESC);

ALTER TABLE incident_audit_log
DROP CONSTRAINT incident_audit_log_action_check;

ALTER TABLE incident_audit_log
ADD CONSTRAINT incident_audit_log_action_check CHECK (
  action IN (
    'created',
    'reopened',
    'acknowledged',
    'resolved',
    'assigned',
    'note_added',
    'feedback_recorded'
  )
);
