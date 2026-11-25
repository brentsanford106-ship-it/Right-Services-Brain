-- 0014_admin_tools_rls: let the database ADMIN tools (setup-company, seed, data migrations) work when the
-- admin login is not a superuser, as on Azure Database for PostgreSQL.
--
-- Why: every company table has FORCE ROW LEVEL SECURITY, and its policies are only for the app role (rsb_app).
-- A superuser skips row-level security, so this never showed up locally. A non-superuser admin (the table owner)
-- does NOT skip it, and with no policy for it every read returns nothing and every insert is refused:
-- `pnpm db:setup-company` failed with "new row violates row-level security policy for table organizations".
--
-- Fix: a NOLOGIN role, rsb_admin_tools, given only to the admin login that runs migrations, with a full-access
-- policy on each walled table. This gives the admin nothing it couldn't already do (as the tables' owner it can
-- switch row-level security off). The API's login must never be a member: the API refuses to start if it is
-- (assertRestrictedLogin), and a test checks that no other login holds it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rsb_admin_tools') THEN
    CREATE ROLE rsb_admin_tools NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT pg_has_role(current_user, 'rsb_admin_tools', 'USAGE') THEN
    EXECUTE format('GRANT rsb_admin_tools TO %I', current_user);
  END IF;
END
$$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
     ORDER BY 1
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO rsb_admin_tools USING (true) WITH CHECK (true)', t || '_admin_tools', t);
  END LOOP;
END
$$;
