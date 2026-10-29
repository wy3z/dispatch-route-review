CREATE TABLE cache_refresh_dead_letters (
  cache_key text PRIMARY KEY,
  kind text NOT NULL CHECK (kind = 'schedule'),
  scope_date date NOT NULL,
  requested_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  failed_at timestamptz NOT NULL DEFAULT now(),
  last_error text NOT NULL,
  CHECK (cache_key = kind || ':' || scope_date::text)
);

CREATE INDEX cache_refresh_dead_letters_requester_idx
  ON cache_refresh_dead_letters (requested_by, failed_at DESC)
  WHERE requested_by IS NOT NULL;
