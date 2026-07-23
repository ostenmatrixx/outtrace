ALTER TABLE process_instances
ADD COLUMN latest_event_external_id text;

CREATE INDEX process_instances_latest_event_idx
ON process_instances (
  workspace_id,
  process_id,
  latest_event_occurred_at DESC,
  latest_event_external_id DESC
);
