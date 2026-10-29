-- Keep obsolete Draft refresh work from being claimed while the cache kind
-- constraints are narrowed. The migration runner applies this file in a
-- transaction, so the locks, cleanup, and constraint changes are atomic.
LOCK TABLE cache_refresh_queue, cache_snapshots IN ACCESS EXCLUSIVE MODE;

DELETE FROM cache_refresh_queue
 WHERE kind = 'draft_queue';

DELETE FROM cache_snapshots
 WHERE kind = 'draft_queue';

ALTER TABLE cache_refresh_queue
  DROP CONSTRAINT cache_refresh_queue_kind_check,
  ADD CONSTRAINT cache_refresh_queue_kind_check
    CHECK (kind IN ('schedule', 'planning_demand'));

ALTER TABLE cache_snapshots
  DROP CONSTRAINT cache_snapshots_kind_check,
  ADD CONSTRAINT cache_snapshots_kind_check
    CHECK (kind IN ('schedule', 'planning_demand'));

DELETE FROM app_user_page_visibility
 WHERE page_key = 'draft';

ALTER TABLE app_user_page_visibility
  DROP CONSTRAINT app_user_page_visibility_page_key_check,
  ADD CONSTRAINT app_user_page_visibility_page_key_check
    CHECK (page_key IN ('audit', 'dispatch'));
