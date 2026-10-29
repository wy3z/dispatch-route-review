CREATE TABLE app_user_page_visibility (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  page_key text NOT NULL CHECK (page_key IN ('audit', 'dispatch', 'draft')),
  visible boolean NOT NULL,
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_key)
);

-- Preserve the effective global setting for everyone already provisioned when
-- moving to individual preferences. Users provisioned after this migration use
-- the catalog defaults until an administrator chooses otherwise.
INSERT INTO app_user_page_visibility (user_id, page_key, visible, updated_by, updated_at)
SELECT users.id, visibility.page_key, visibility.visible, visibility.updated_by, visibility.updated_at
  FROM app_users AS users
 CROSS JOIN app_page_visibility AS visibility
ON CONFLICT (user_id, page_key) DO NOTHING;

DROP TABLE app_page_visibility;
