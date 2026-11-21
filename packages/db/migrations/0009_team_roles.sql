-- 0009_team_roles: owners manage roles (built-in and custom) and who has which role.
--
-- Rules enforced here (the API enforces the rest, e.g. "you can't grant what you don't have"):
--   * Every change stays inside the caller's company (existing row-level security policies).
--   * The Owner role is fixed: it always holds every permission and cannot be deleted or renamed.
--   * Built-in roles cannot be deleted (their permissions can be edited, except Owner's).
--   * A company can never be left without an active owner.

INSERT INTO permissions (key, description) VALUES
  ('roles.manage', 'Create and edit roles, and choose which roles each person has');

INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT r.organization_id, r.id, 'roles.manage' FROM roles r WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;

-- The app may now change roles, their permissions and role assignments (still only in its own company,
-- because the tenant-isolation policies from 0004 cover INSERT/UPDATE/DELETE on these tables).
GRANT INSERT, UPDATE, DELETE ON roles, role_permissions, membership_roles TO rsb_app;

-- Owner role: always every permission, cannot be renamed or removed.
CREATE FUNCTION app.protect_owner_role() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_TABLE_NAME = 'roles' THEN
    IF TG_OP = 'DELETE' AND OLD.is_system THEN
      RAISE EXCEPTION 'built-in roles cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.key <> OLD.key OR NEW.is_system <> OLD.is_system OR (OLD.key = 'owner' AND NEW.name <> OLD.name)) THEN
      RAISE EXCEPTION 'built-in role identity cannot change' USING ERRCODE = 'check_violation';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- role_permissions: no permission may be removed from the Owner role.
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM public.roles r WHERE r.id = OLD.role_id AND r.key = 'owner') THEN
    -- Allowed only when the whole role is being deleted (never for owner, see above) — so always refuse.
    RAISE EXCEPTION 'the Owner role always has every permission' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER roles_protect BEFORE UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION app.protect_owner_role();
CREATE TRIGGER role_permissions_protect BEFORE DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION app.protect_owner_role();

-- Never leave a company without an active owner. Checked at the end of the transaction so that
-- "replace all of this person's roles" (delete then insert) works.
CREATE FUNCTION app.require_an_owner() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE org uuid := OLD.organization_id;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM membership_roles mr
      JOIN roles r ON r.id = mr.role_id AND r.organization_id = mr.organization_id
      JOIN organization_memberships m ON m.id = mr.membership_id AND m.organization_id = mr.organization_id
     WHERE mr.organization_id = org AND r.key = 'owner' AND m.status = 'active'
  ) AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = org) THEN
    RAISE EXCEPTION 'a company must keep at least one active owner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.require_an_owner() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER membership_roles_keep_owner AFTER DELETE OR UPDATE ON membership_roles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.require_an_owner();
