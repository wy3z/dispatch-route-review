-- Engineer management is a separate page permission. Administration itself
-- remains role-gated and is deliberately not represented by this catalog.
ALTER TABLE app_user_permissions
  DROP CONSTRAINT app_user_permissions_permission_key_check,
  ADD CONSTRAINT app_user_permissions_permission_key_check
    CHECK (permission_key IN ('dispatch_review', 'engineer_management'));

-- This migration creates schema only. Tenant-specific roster records must be
-- created through the audited Engineer Management workflow documented in
-- docs/engineer-roster-bootstrap.md, never embedded in source-controlled SQL.
CREATE TABLE engineer_roster (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  autotask_resource_id bigint NOT NULL UNIQUE
    CHECK (
      autotask_resource_id > 0 AND
      autotask_resource_id <= 9007199254740991
    ),
  name text NOT NULL
    CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 256),
  base text NOT NULL
    CHECK (base = btrim(base) AND length(base) BETWEEN 1 AND 256),
  region text NOT NULL
    CHECK (region IN ('North', 'Midlands', 'South', 'Ireland')),
  latitude double precision NOT NULL
    CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL
    CHECK (longitude BETWEEN -180 AND 180),
  active boolean NOT NULL DEFAULT true,
  working_days smallint[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5]::smallint[]
    CHECK (
      cardinality(working_days) > 0 AND
      working_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
    ),
  workday_start time NOT NULL DEFAULT '09:00',
  workday_end time NOT NULL DEFAULT '17:00',
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (workday_end > workday_start)
);

CREATE INDEX engineer_roster_active_region_name_idx
  ON engineer_roster (active DESC, region, name);
