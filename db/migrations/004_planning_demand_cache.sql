ALTER TABLE cache_snapshots
  DROP CONSTRAINT IF EXISTS cache_snapshots_kind_check;

ALTER TABLE cache_snapshots
  ADD CONSTRAINT cache_snapshots_kind_check
  CHECK (kind IN ('schedule', 'draft_queue', 'planning_demand'));

ALTER TABLE cache_refresh_queue
  DROP CONSTRAINT IF EXISTS cache_refresh_queue_kind_check;

ALTER TABLE cache_refresh_queue
  ADD CONSTRAINT cache_refresh_queue_kind_check
  CHECK (kind IN ('schedule', 'draft_queue', 'planning_demand'));
