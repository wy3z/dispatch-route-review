CREATE TABLE autotask_api_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  entity text NOT NULL CHECK (char_length(entity) BETWEEN 1 AND 100),
  operation text NOT NULL CHECK (operation IN ('query', 'entity_information')),
  method text NOT NULL CHECK (method IN ('GET', 'POST')),
  page_number integer NOT NULL CHECK (page_number > 0),
  status_code integer CHECK (status_code BETWEEN 100 AND 599),
  outcome text NOT NULL
    CHECK (outcome IN ('success', 'http_error', 'timeout', 'network_error')),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0)
);

CREATE INDEX autotask_api_activity_occurred_idx
  ON autotask_api_activity (occurred_at DESC);

CREATE INDEX autotask_api_activity_entity_idx
  ON autotask_api_activity (entity, operation, occurred_at DESC);
