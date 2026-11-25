-- 0002_identity_and_access: organizations, users, memberships, roles, permissions.

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- A person. Global (one person may belong to several organizations).
-- Authentication is delegated to an external identity provider; we store
-- only the (issuer, subject) pair and minimal profile data. No passwords.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idp_issuer    text NOT NULL CHECK (length(idp_issuer) BETWEEN 1 AND 500),
  idp_subject   text NOT NULL CHECK (length(idp_subject) BETWEEN 1 AND 255),
  email         citext NOT NULL CHECK (length(email) BETWEEN 3 AND 320 AND email LIKE '%_@_%'),
  display_name  text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idp_issuer, idp_subject)
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE organization_memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  job_title        text CHECK (job_title IS NULL OR length(job_title) <= 120),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, id)
);
CREATE INDEX organization_memberships_user_idx ON organization_memberships (user_id);
CREATE TRIGGER organization_memberships_touch BEFORE UPDATE ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER organization_memberships_org_immutable BEFORE UPDATE ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION app.forbid_org_change();

-- Global permission catalog (code-defined; read-only to the runtime role).
CREATE TABLE permissions (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  description  text NOT NULL
);

-- Roles are per organization so each business can later customise them.
CREATE TABLE roles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  key              text NOT NULL CHECK (key ~ '^[a-z_]{1,50}$'),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  is_system        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key),
  UNIQUE (organization_id, id)
);

CREATE TABLE role_permissions (
  organization_id  uuid NOT NULL,
  role_id          uuid NOT NULL,
  permission_key   text NOT NULL REFERENCES permissions(key) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_key),
  FOREIGN KEY (organization_id, role_id) REFERENCES roles (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE membership_roles (
  organization_id  uuid NOT NULL,
  membership_id    uuid NOT NULL,
  role_id          uuid NOT NULL,
  granted_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, role_id),
  -- Composite FKs: a membership can only receive roles from its own organization.
  FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, role_id) REFERENCES roles (organization_id, id) ON DELETE CASCADE
);

-- Resolve an authenticated identity to an active user id.
-- SECURITY DEFINER because no org context exists yet at authentication time.
-- Returns NULL for unknown or disabled users. Reveals nothing else.
CREATE FUNCTION app.resolve_principal(p_issuer text, p_subject text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT u.id FROM public.users u
     WHERE u.idp_issuer = p_issuer AND u.idp_subject = p_subject AND u.status = 'active'
  $$;
REVOKE ALL ON FUNCTION app.resolve_principal(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_principal(text, text) TO rsb_app;
