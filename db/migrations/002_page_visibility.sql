CREATE TABLE IF NOT EXISTS app_page_visibility (
  page_key text PRIMARY KEY
    CHECK (page_key IN ('audit', 'dispatch', 'draft')),
  visible boolean NOT NULL,
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_page_visibility (page_key, visible)
VALUES
  ('audit', true),
  ('dispatch', true),
  ('draft', false)
ON CONFLICT (page_key) DO NOTHING;
