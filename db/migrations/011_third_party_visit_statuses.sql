-- Autotask ticket statuses that classify scheduled visits as third-party work.
-- Labels are presentation-only; immutable numeric IDs drive planner behaviour.
CREATE TABLE third_party_visit_statuses (
  status_id bigint PRIMARY KEY
    CHECK (status_id > 0 AND status_id <= 9007199254740991),
  label text NOT NULL
    CHECK (label = btrim(label) AND length(label) BETWEEN 1 AND 256),
  selected boolean NOT NULL DEFAULT false,
  available boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX third_party_visit_statuses_selected_idx
  ON third_party_visit_statuses (selected, label);
