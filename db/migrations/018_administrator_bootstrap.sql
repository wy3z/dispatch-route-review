CREATE TABLE IF NOT EXISTS administrator_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  consumed_at timestamptz,
  consumed_by uuid REFERENCES app_users(id) ON DELETE SET NULL
);

INSERT INTO administrator_bootstrap (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

-- Upgrades that already have an administrator must not expose a fresh
-- bootstrap opportunity after this migration is applied.
UPDATE administrator_bootstrap
   SET consumed_at = now(),
       consumed_by = (
         SELECT id
           FROM app_users
          WHERE role = 'admin'
          ORDER BY created_at, id
          LIMIT 1
       )
 WHERE singleton = true
   AND consumed_at IS NULL
   AND EXISTS (SELECT 1 FROM app_users WHERE role = 'admin');
