-- Preserve the display order supplied by Autotask ticket-status metadata.
ALTER TABLE third_party_visit_statuses
  ADD COLUMN sort_order integer NOT NULL DEFAULT 2147483647
    CHECK (sort_order >= 0);

CREATE INDEX third_party_visit_statuses_sort_order_idx
  ON third_party_visit_statuses (available DESC, sort_order, status_id);
