-- 0001_foundation: schemas, runtime role, helper functions.
--
-- Security model (see docs/TENANT_ISOLATION.md):
--   * Tables are owned by the migration/admin role.
--   * The API connects as a login that is a member of `rsb_app` only.
--     `rsb_app` is NOLOGIN, NOSUPERUSER, NOBYPASSRLS and owns nothing.
--   * Every request runs in a transaction that sets
--       app.current_user_id  and  app.current_org_id
--     with set_config(..., is_local => true). RLS policies read them through
--     the helper functions below. Unset or empty values mean "no access".

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rsb_app') THEN
    CREATE ROLE rsb_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO rsb_app;

-- The runtime role must not create objects anywhere.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rsb_app;

-- Request context helpers. NULLIF guards against the empty string that a
-- previously-set, now-reset custom setting returns on a pooled connection.
CREATE FUNCTION app.current_org_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app.current_org_id() TO rsb_app;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO rsb_app;

-- Generic updated_at maintenance.
CREATE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Prevent changing the tenant of an existing row (defence in depth on top of RLS WITH CHECK).
CREATE FUNCTION app.forbid_org_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'organization_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
