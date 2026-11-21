-- 0004_audit_rls_and_grants: append-only audit log, row-level security, least-privilege grants.

CREATE TABLE audit_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL only for security events that happen before an organization is resolved
  -- (for example an authenticated user probing an organization they don't belong to).
  organization_id  uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id uuid,
  action           text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  outcome          text NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  target_type      text CHECK (target_type IS NULL OR target_type ~ '^[a-z_]{1,50}$'),
  target_id        uuid,
  request_id       text CHECK (request_id IS NULL OR length(request_id) <= 100),
  -- Metadata must never contain secrets, tokens, or unnecessary PII. Enforced in application code and reviewed in tests.
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 8192),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX audit_events_org_time_idx ON audit_events (organization_id, occurred_at DESC);

-- Append-only: block UPDATE and DELETE for everyone, including the table owner.
-- (A superuser can still drop the trigger; production admin access is restricted and audited separately.)
CREATE FUNCTION app.audit_events_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_events_immutable();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_visible ON organizations FOR SELECT TO rsb_app
  USING (
    id = app.current_org_id()
    OR EXISTS (
      SELECT 1 FROM organization_memberships m
       WHERE m.organization_id = organizations.id
         AND m.user_id = app.current_user_id()
         AND m.status = 'active')
  );

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON users FOR SELECT TO rsb_app
  USING (
    id = app.current_user_id()
    OR EXISTS (
      SELECT 1 FROM organization_memberships m
       WHERE m.user_id = users.id
         AND m.organization_id = app.current_org_id())
  );

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_visible ON organization_memberships FOR SELECT TO rsb_app
  USING (organization_id = app.current_org_id() OR user_id = app.current_user_id());

-- Tenant tables: one policy covering read and write, scoped to the current organization.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles', 'role_permissions', 'membership_roles',
                           'customers', 'jobs', 'job_assignments', 'documents', 'photos',
                           'photo_flags', 'receipts', 'vehicles', 'vehicle_assignments',
                           'mileage_records', 'maintenance_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO rsb_app
         USING (organization_id = app.current_org_id())
         WITH CHECK (organization_id = app.current_org_id())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_read ON audit_events FOR SELECT TO rsb_app
  USING (organization_id = app.current_org_id());
CREATE POLICY audit_events_write ON audit_events FOR INSERT TO rsb_app
  WITH CHECK (organization_id = app.current_org_id() OR organization_id IS NULL);

-- ---------------------------------------------------------------------------
-- Least-privilege grants for the runtime role. Note: no DELETE anywhere,
-- no TRUNCATE, no DDL. Membership and role management (Phase 2) will add
-- narrowly-scoped privileges with their own tests.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

GRANT SELECT ON organizations, users, organization_memberships, permissions,
                roles, role_permissions, membership_roles TO rsb_app;

GRANT SELECT, INSERT, UPDATE ON customers, jobs, job_assignments, documents, photos, photo_flags,
                               receipts, vehicles, vehicle_assignments, mileage_records,
                               maintenance_records TO rsb_app;

GRANT SELECT, INSERT ON audit_events TO rsb_app;
