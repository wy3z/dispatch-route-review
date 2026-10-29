CREATE TABLE cache_review_refresh_requests (
  cache_key text PRIMARY KEY,
  requested_by uuid NOT NULL,
  request_generation bigint NOT NULL CHECK (request_generation >= 1),
  requested_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cache_review_refresh_requests_requester_idx
  ON cache_review_refresh_requests (requested_by, requested_at);
