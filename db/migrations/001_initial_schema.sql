CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('viewer', 'scheduler', 'admin')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_idx
  ON app_users (lower(email));

CREATE TABLE IF NOT EXISTS cache_snapshots (
  cache_key text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('schedule', 'draft_queue')),
  scope_date date NOT NULL,
  payload jsonb NOT NULL,
  source_refreshed_at timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  CHECK (cache_key = kind || ':' || scope_date::text)
);

CREATE INDEX IF NOT EXISTS cache_snapshots_due_idx
  ON cache_snapshots (expires_at);

CREATE TABLE IF NOT EXISTS cache_refresh_queue (
  cache_key text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('schedule', 'draft_queue')),
  scope_date date NOT NULL,
  priority smallint NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  attempts integer NOT NULL DEFAULT 0,
  leased_at timestamptz,
  lease_owner text,
  last_error text,
  CHECK (cache_key = kind || ':' || scope_date::text)
);

CREATE INDEX IF NOT EXISTS cache_refresh_queue_claim_idx
  ON cache_refresh_queue (available_at, priority DESC, requested_at)
  WHERE leased_at IS NULL;

CREATE TABLE IF NOT EXISTS scheduler_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_date date NOT NULL,
  region text NOT NULL,
  name text NOT NULL DEFAULT 'Draft plan',
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'archived')),
  current_revision integer NOT NULL DEFAULT 1,
  plan jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES app_users(id),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduler_plans_date_region_idx
  ON scheduler_plans (planning_date, region, updated_at DESC);

CREATE TABLE IF NOT EXISTS scheduler_plan_revisions (
  plan_id uuid NOT NULL REFERENCES scheduler_plans(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  plan jsonb NOT NULL,
  change_summary text NOT NULL,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, revision)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  actor_subject text NOT NULL,
  actor_email text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  request_id text NOT NULL,
  ip_address inet,
  user_agent text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_events_lookup_idx
  ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx
  ON audit_events (actor_user_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION prevent_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

DROP TRIGGER IF EXISTS scheduler_plan_revisions_append_only
  ON scheduler_plan_revisions;
CREATE TRIGGER scheduler_plan_revisions_append_only
  BEFORE UPDATE OR DELETE ON scheduler_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
