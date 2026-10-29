-- Entra OIDC `sub` values are application-specific. Keep app_users.id as the
-- stable authorization principal; external_subject remains a rollback mirror.
LOCK TABLE app_users IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  provider_key text NOT NULL CHECK (provider_key = 'entra_oidc_sub'),
  external_subject text NOT NULL
    CHECK (
      external_subject = btrim(external_subject) AND
      char_length(external_subject) BETWEEN 1 AND 512
    ),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  retired_at timestamptz,
  CHECK (NOT is_primary OR retired_at IS NULL),
  UNIQUE (provider_key, external_subject)
);

CREATE UNIQUE INDEX auth_identities_primary_user_idx
  ON auth_identities (user_id, provider_key)
  WHERE is_primary;

CREATE INDEX auth_identities_user_history_idx
  ON auth_identities (user_id, created_at, id);

INSERT INTO auth_identities
  (user_id, provider_key, external_subject, is_primary, created_at, last_seen_at)
SELECT id, 'entra_oidc_sub', external_subject, true, created_at, last_seen_at
  FROM app_users;

COMMENT ON COLUMN app_users.external_subject IS
  'Compatibility mirror of the primary entra_oidc_sub identity. Runtime lookup uses auth_identities.';

COMMENT ON TABLE auth_identities IS
  'Immutable ownership history for exact external authentication subjects. Retired subjects remain reserved.';

CREATE OR REPLACE FUNCTION create_auth_identity_for_legacy_app_user()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth_identities
    (user_id, provider_key, external_subject, is_primary, created_at, last_seen_at)
  VALUES
    (NEW.id, 'entra_oidc_sub', NEW.external_subject, true, NEW.created_at, NEW.last_seen_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER app_users_auth_identity_compatibility
  AFTER INSERT ON app_users
  FOR EACH ROW EXECUTE FUNCTION create_auth_identity_for_legacy_app_user();

CREATE OR REPLACE FUNCTION protect_auth_identity_ownership()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'auth identity ownership history cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.user_id IS DISTINCT FROM OLD.user_id OR
     NEW.provider_key IS DISTINCT FROM OLD.provider_key OR
     NEW.external_subject IS DISTINCT FROM OLD.external_subject OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'auth identity ownership fields are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_identities_ownership_immutable
  BEFORE UPDATE OR DELETE ON auth_identities
  FOR EACH ROW EXECUTE FUNCTION protect_auth_identity_ownership();

CREATE OR REPLACE FUNCTION check_app_user_auth_identity_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  primary_count integer;
  primary_subject text;
BEGIN
  SELECT count(*)::integer, min(external_subject)
    INTO primary_count, primary_subject
    FROM auth_identities
   WHERE user_id = NEW.id
     AND provider_key = 'entra_oidc_sub'
     AND is_primary
     AND retired_at IS NULL;

  IF primary_count <> 1 OR primary_subject IS DISTINCT FROM NEW.external_subject THEN
    RAISE EXCEPTION 'app user auth identity primary/mirror mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION check_auth_identity_app_user_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mirror_subject text;
  primary_count integer;
  primary_subject text;
BEGIN
  SELECT external_subject
    INTO mirror_subject
    FROM app_users
   WHERE id = NEW.user_id;

  SELECT count(*)::integer, min(external_subject)
    INTO primary_count, primary_subject
    FROM auth_identities
   WHERE user_id = NEW.user_id
     AND provider_key = 'entra_oidc_sub'
     AND is_primary
     AND retired_at IS NULL;

  IF primary_count <> 1 OR primary_subject IS DISTINCT FROM mirror_subject THEN
    RAISE EXCEPTION 'auth identity primary/app user mirror mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER app_users_auth_identity_consistency
  AFTER INSERT OR UPDATE ON app_users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_app_user_auth_identity_consistency();

CREATE CONSTRAINT TRIGGER auth_identities_app_user_consistency
  AFTER INSERT OR UPDATE ON auth_identities
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_auth_identity_app_user_consistency();

-- Row triggers do not run for TRUNCATE. Preserve identity ownership and the
-- audit history used to recover it.
CREATE FUNCTION prevent_auth_identity_audit_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER auth_identities_append_only_truncate
  BEFORE TRUNCATE ON auth_identities
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_auth_identity_audit_truncate();

CREATE TRIGGER auth_identity_audit_append_only_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_auth_identity_audit_truncate();
