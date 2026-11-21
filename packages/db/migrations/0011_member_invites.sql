-- 0011_member_invites: owners add people by email; the person's first real sign-in links them.
--
-- How it works:
--   * An owner (members.manage) adds a person: name, email, role(s). That creates an open invite.
--   * When someone signs in through the real identity provider (Microsoft Entra External ID) with a
--     verified email address that matches an open invite, app.claim_invites() creates their account,
--     their membership and their roles, and records it in the audit log.
--   * Someone who signs in without an invite gets no access at all.
--   * Owners can remove or suspend people; a company can never be left without an active owner.

CREATE TABLE member_invites (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  email                    citext NOT NULL CHECK (length(email) BETWEEN 3 AND 320 AND email LIKE '%_@_%'),
  display_name             text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  job_title                text CHECK (job_title IS NULL OR length(job_title) <= 120),
  -- Role ids are re-checked against this company's roles when the invite is accepted.
  role_ids                 uuid[] NOT NULL CHECK (cardinality(role_ids) BETWEEN 1 AND 20),
  invited_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  accepted_at              timestamptz,
  accepted_membership_id   uuid,
  revoked_at               timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, invited_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, accepted_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  CHECK ((accepted_at IS NULL) = (accepted_membership_id IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
-- One open invite per email per company.
CREATE UNIQUE INDEX member_invites_open_email ON member_invites (organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX member_invites_email ON member_invites (email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE member_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY member_invites_tenant_isolation ON member_invites FOR ALL TO rsb_app
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
GRANT SELECT, INSERT ON member_invites TO rsb_app;
GRANT UPDATE (revoked_at) ON member_invites TO rsb_app;

-- Owners may change a person's status (active / suspended / removed) and job title, in their own company only.
GRANT UPDATE (status, job_title) ON organization_memberships TO rsb_app;
CREATE POLICY memberships_update ON organization_memberships FOR UPDATE TO rsb_app
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());

-- Suspending or removing the last active owner is refused, exactly like removing their Owner role (0009).
CREATE CONSTRAINT TRIGGER memberships_keep_owner AFTER UPDATE OF status ON organization_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.require_an_owner();

-- "Add or remove people" is now a working permission (owners only by default, as before).
UPDATE permissions SET description = 'Add people by email, and suspend or remove people' WHERE key = 'members.manage';

-- Links a signed-in identity to every open invite for its verified email address.
-- Called by the API only after the identity provider's token has been verified.
-- Returns the user id when the person is (now) an active user, otherwise NULL.
CREATE FUNCTION app.claim_invites(p_issuer text, p_subject text, p_email text, p_name text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  uid uuid;
  ustatus text;
  mid uuid;
  inv record;
BEGIN
  IF p_email IS NULL OR p_email !~ '^[^@\s]+@[^@\s]+$' OR length(p_email) > 320 THEN
    RETURN NULL;
  END IF;

  SELECT id, status INTO uid, ustatus FROM users WHERE idp_issuer = p_issuer AND idp_subject = p_subject;
  IF uid IS NOT NULL AND ustatus <> 'active' THEN
    RETURN NULL; -- a disabled account never comes back through an invite
  END IF;

  FOR inv IN
    SELECT * FROM member_invites
     WHERE email = p_email::citext AND accepted_at IS NULL AND revoked_at IS NULL
     ORDER BY created_at
     FOR UPDATE
  LOOP
    IF uid IS NULL THEN
      INSERT INTO users (idp_issuer, idp_subject, email, display_name)
      VALUES (p_issuer, p_subject, p_email, COALESCE(NULLIF(btrim(left(p_name, 200)), ''), inv.display_name))
      RETURNING id INTO uid;
    END IF;

    SELECT id INTO mid FROM organization_memberships WHERE organization_id = inv.organization_id AND user_id = uid;
    IF mid IS NULL THEN
      INSERT INTO organization_memberships (organization_id, user_id, job_title)
      VALUES (inv.organization_id, uid, inv.job_title)
      RETURNING id INTO mid;
    ELSE
      -- Re-invited after being removed: start again with the invite's roles only.
      UPDATE organization_memberships SET status = 'active', job_title = COALESCE(inv.job_title, job_title) WHERE id = mid;
      DELETE FROM membership_roles WHERE membership_id = mid;
    END IF;

    INSERT INTO membership_roles (organization_id, membership_id, role_id)
    SELECT inv.organization_id, mid, r.id FROM roles r
     WHERE r.organization_id = inv.organization_id AND r.id = ANY (inv.role_ids)
    ON CONFLICT DO NOTHING;

    UPDATE member_invites SET accepted_at = now(), accepted_membership_id = mid WHERE id = inv.id;

    INSERT INTO audit_events (organization_id, actor_user_id, actor_membership_id, action, outcome, target_type, target_id, metadata)
    VALUES (inv.organization_id, uid, mid, 'member.invite_accepted', 'success', 'membership', mid, jsonb_build_object('inviteId', inv.id));
  END LOOP;

  RETURN uid;
END
$$;
REVOKE ALL ON FUNCTION app.claim_invites(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_invites(text, text, text, text) TO rsb_app;
