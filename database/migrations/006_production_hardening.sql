ALTER TABLE workspaces
ALTER COLUMN ingestion_key_id DROP NOT NULL,
ALTER COLUMN ingestion_key_hash DROP NOT NULL;

ALTER TABLE workspaces
ADD CONSTRAINT workspaces_ingestion_credential_pair CHECK (
  (ingestion_key_id IS NULL AND ingestion_key_hash IS NULL)
  OR (ingestion_key_id IS NOT NULL AND ingestion_key_hash IS NOT NULL)
);

CREATE TABLE event_idempotency_keys (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_event_id text NOT NULL CHECK (btrim(external_event_id) <> ''),
  process_instance_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, external_event_id),
  FOREIGN KEY (workspace_id, process_instance_id)
    REFERENCES process_instances(workspace_id, id)
    ON DELETE CASCADE
);

INSERT INTO event_idempotency_keys (
  workspace_id,
  external_event_id,
  process_instance_id,
  created_at
)
SELECT
  workspace_id,
  external_event_id,
  process_instance_id,
  received_at
FROM events;

CREATE INDEX event_idempotency_keys_retention_idx
ON event_idempotency_keys (created_at, workspace_id, external_event_id);

ALTER TABLE process_ingestion_credentials
ADD COLUMN revoked_at timestamptz,
ADD COLUMN revoked_by_member_id text,
ADD COLUMN revocation_reason text
  CHECK (revocation_reason IS NULL OR char_length(revocation_reason) <= 500),
ADD CONSTRAINT process_ingestion_credentials_revoked_by_fkey
  FOREIGN KEY (workspace_id, revoked_by_member_id)
  REFERENCES workspace_members(workspace_id, id);

CREATE INDEX process_ingestion_credentials_active_idx
ON process_ingestion_credentials (key_id)
WHERE revoked_at IS NULL;

ALTER TABLE incident_notification_outbox
ADD COLUMN claimed_at timestamptz,
ADD COLUMN claim_token text;

ALTER TABLE incident_notification_outbox
ADD CONSTRAINT incident_notification_outbox_claim_pair CHECK (
  (claimed_at IS NULL AND claim_token IS NULL)
  OR (claimed_at IS NOT NULL AND claim_token IS NOT NULL)
);

CREATE INDEX incident_notification_outbox_delivery_idx
ON incident_notification_outbox (workspace_id, available_at, created_at)
WHERE sent_at IS NULL;

CREATE INDEX event_evaluation_outbox_completed_retention_idx
ON event_evaluation_outbox (created_at)
WHERE published_at IS NOT NULL;

CREATE INDEX incident_notification_outbox_completed_retention_idx
ON incident_notification_outbox (created_at)
WHERE sent_at IS NOT NULL;
