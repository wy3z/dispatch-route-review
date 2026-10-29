-- Resource identity uses a persisted palette position. Existing roster rows are
-- assigned once in stable immutable-ID order; later filtering/sorting never
-- participates in colour selection.
ALTER TABLE engineer_roster
  ADD COLUMN colour_index smallint;

WITH ranked AS (
  SELECT id,
         (row_number() OVER (ORDER BY autotask_resource_id) - 1) % 30
           AS colour_index
    FROM engineer_roster
)
UPDATE engineer_roster AS engineer
   SET colour_index = ranked.colour_index
  FROM ranked
 WHERE engineer.id = ranked.id;

ALTER TABLE engineer_roster
  ALTER COLUMN colour_index SET NOT NULL,
  ADD CONSTRAINT engineer_roster_colour_index_check
    CHECK (colour_index BETWEEN 0 AND 29);

CREATE INDEX engineer_roster_colour_index_idx
  ON engineer_roster (colour_index);
