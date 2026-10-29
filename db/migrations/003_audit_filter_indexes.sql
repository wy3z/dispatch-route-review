CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx
  ON audit_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_resource_date_idx
  ON audit_events (lower(actor_email), occurred_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_action_date_idx
  ON audit_events (action, occurred_at DESC);
