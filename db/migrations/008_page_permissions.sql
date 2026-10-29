-- Page visibility is now authorization. Collapse the two legacy presentation
-- flags into one permission for the unified Dispatch Review, preserving every
-- existing user's effective `audit OR dispatch` access before retiring the old
-- table. A missing permission row after this migration means denied.
LOCK TABLE app_users, app_user_page_visibility IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE app_user_permissions (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  permission_key text NOT NULL
    CHECK (permission_key IN ('dispatch_review')),
  granted boolean NOT NULL,
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_key)
);

INSERT INTO app_user_permissions (user_id, permission_key, granted)
SELECT users.id,
       'dispatch_review',
       COALESCE(
         bool_or(visibility.visible) FILTER (WHERE visibility.page_key = 'audit'),
         true
       ) OR COALESCE(
         bool_or(visibility.visible) FILTER (WHERE visibility.page_key = 'dispatch'),
         true
       )
  FROM app_users AS users
  LEFT JOIN app_user_page_visibility AS visibility
    ON visibility.user_id = users.id
 GROUP BY users.id;

DROP TABLE app_user_page_visibility;
