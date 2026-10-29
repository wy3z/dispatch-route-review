ALTER TABLE cache_refresh_queue
  ADD COLUMN request_generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN claim_generation bigint NOT NULL DEFAULT 0;

ALTER TABLE cache_refresh_queue
  ADD CONSTRAINT cache_refresh_queue_request_generation_check
    CHECK (request_generation >= 1),
  ADD CONSTRAINT cache_refresh_queue_claim_generation_check
    CHECK (claim_generation >= 0);
