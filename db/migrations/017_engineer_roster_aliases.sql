-- Booked-visit matching falls back to display names when a visit carries no
-- Autotask resource link (see findEngineerBase). Aliases are operator-managed
-- roster data so a new nickname no longer requires a code change or deploy.
ALTER TABLE engineer_roster
  ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';
