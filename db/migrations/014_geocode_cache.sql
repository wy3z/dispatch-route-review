CREATE TABLE IF NOT EXISTS geocode_cache (
  cache_key text PRIMARY KEY
    CHECK (cache_key ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL
    CHECK (provider IN ('uk_postcode', 'eu_address')),
  provider_host text NOT NULL
    CHECK (provider_host <> '' AND provider_host !~ '[/?#]'),
  outcome text NOT NULL
    CHECK (outcome IN ('resolved', 'not_found')),
  latitude double precision,
  longitude double precision,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (
    (
      outcome = 'resolved'
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND latitude BETWEEN -90 AND 90
      AND longitude BETWEEN -180 AND 180
    )
    OR
    (
      outcome = 'not_found'
      AND latitude IS NULL
      AND longitude IS NULL
    )
  ),
  CHECK (expires_at > refreshed_at)
);

CREATE INDEX IF NOT EXISTS geocode_cache_expires_idx
  ON geocode_cache (expires_at);
