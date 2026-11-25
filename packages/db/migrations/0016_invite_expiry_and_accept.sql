-- 0016_invite_expiry_and_accept: JB's decisions of 2026-11-23.
--   1. Invites expire. An invite that isn't accepted within 14 days stops working. An owner can renew it.
--   2. People choose to join. Signing in with an invited email no longer adds the person to the company on its
--      own: the app shows "<Company> added you" with Accept and Decline, and only Accept makes them a member.
--
-- How it works now:
--   * app.register_invited_user(): at sign-in, a verified email with at least one live invite gets an account
--     (no company yet), so the person can see their invites. Nobody else gets an account.
--   * app.my_invites(): the live invites for the signed-in person's verified email.
--   * app.respond_to_invite(): Accept (creates or brings back the membership with the invite's roles) or Decline.
--   * app.claim_invites() (which joined people automatically) is removed.

ALTER TABLE member_invites
  ADD COLUMN expires_at  timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  ADD COLUMN declined_at timestamptz,
  ADD CONSTRAINT member_invites_one_outcome CHECK (num_nonnulls(accepted_at, revoked_at, declined_at) <= 1);

-- "Open" now also means not declined. (Expired invites stay open until renewed or cancelled, so the owner sees them.)
DROP INDEX member_invites_open_email;
CREATE UNIQUE INDEX member_invites_open_email ON member_invites (organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL;
DROP INDEX member_invites_email;
CREATE INDEX member_invites_email ON member_invites (email) WHERE accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL;

-- Owners may renew an invite (move its expiry date), in their own company only (RLS policy from 0011).
GRANT UPDATE (expires_at) ON member_invites TO rsb_app;

DROP FUNCTION app.claim_invites(text, text, text, text);

-- Creates the account for a person signing in for the first time, but ONLY if their verified email has a live invite.
-- Returns the user id when the person is an active user (new or existing), otherwise NULL. Adds no company.
CREATE FUNCTION app.register_invited_user(p_issuer text, p_subject text, p_email text, p_name text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  uid uuid;
  ustatus text;
  inv record;
BEGIN
  SELECT id, status INTO uid, ustatus FROM users WHERE idp_issuer = p_issuer AND idp_subject = p_subject;
  IF uid IS NOT NULL THEN
    RETURN CASE WHEN ustatus = 'active' THEN uid END; -- a disabled account never comes back through an invite
  END IF;
  IF p_email IS NULL OR p_email !~ '^[^@\s]+@[^@\s]+$' OR length(p_email) > 320 THEN
    RETURN NULL;
  END IF;

  SELECT i.display_name INTO inv FROM member_invites i JOIN organizations o ON o.id = i.organization_id AND o.status = 'active'
   WHERE i.email = p_email::citext AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.declined_at IS NULL
     AND i.expires_at > now()
   ORDER BY i.created_at LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Two first requests at the same moment: the second one waits here for the first, then uses its account.
  INSERT INTO users (idp_issuer, idp_subject, email, display_name)
  VALUES (p_issuer, p_subject, p_email, COALESCE(NULLIF(btrim(left(p_name, 200)), ''), inv.display_name))
  ON CONFLICT (idp_issuer, idp_subject) DO NOTHING
  RETURNING id INTO uid;
  IF uid IS NULL THEN
    SELECT id INTO uid FROM users WHERE idp_issuer = p_issuer AND idp_subject = p_subject AND status = 'active';
  END IF;
  RETURN uid;
END
$$;
REVOKE ALL ON FUNCTION app.register_invited_user(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_invited_user(text, text, text, text) TO rsb_app;

-- The live invites waiting for this signed-in person (matched by their verified email). Reveals only the
-- company name, the role names and who added them: nothing else about the company.
CREATE FUNCTION app.my_invites(p_issuer text, p_subject text, p_email text)
  RETURNS TABLE (invite_id uuid, organization_id uuid, organization_name text, role_names text[], invited_by text, expires_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT i.id, o.id, o.name,
         ARRAY(SELECT r.name FROM roles r WHERE r.organization_id = i.organization_id AND r.id = ANY (i.role_ids) ORDER BY r.name),
         COALESCE(iu.display_name, 'Company setup'),
         i.expires_at
    FROM users u
    JOIN member_invites i ON i.email = p_email::citext
    JOIN organizations o ON o.id = i.organization_id AND o.status = 'active'
    LEFT JOIN organization_memberships im ON im.organization_id = i.organization_id AND im.id = i.invited_by_membership_id
    LEFT JOIN users iu ON iu.id = im.user_id
   WHERE u.idp_issuer = p_issuer AND u.idp_subject = p_subject AND u.status = 'active'
     AND p_email IS NOT NULL
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.declined_at IS NULL AND i.expires_at > now()
   ORDER BY i.created_at
$$;
REVOKE ALL ON FUNCTION app.my_invites(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_invites(text, text, text) TO rsb_app;

-- Accept or decline one invite. Only the person whose verified email it was sent to, only while it is live.
-- Returns 'accepted', 'declined', or 'gone' (not theirs, used, cancelled, declined or expired: all look the same).
CREATE FUNCTION app.respond_to_invite(p_issuer text, p_subject text, p_email text, p_invite_id uuid, p_accept boolean)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  uid uuid;
  mid uuid;
  inv record;
BEGIN
  SELECT id INTO uid FROM users WHERE idp_issuer = p_issuer AND idp_subject = p_subject AND status = 'active';
  IF uid IS NULL OR p_email IS NULL THEN
    RETURN 'gone';
  END IF;

  SELECT i.* INTO inv FROM member_invites i JOIN organizations o ON o.id = i.organization_id AND o.status = 'active'
   WHERE i.id = p_invite_id AND i.email = p_email::citext
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.declined_at IS NULL AND i.expires_at > now()
   FOR UPDATE OF i;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;

  IF NOT p_accept THEN
    UPDATE member_invites SET declined_at = now() WHERE id = inv.id;
    INSERT INTO audit_events (organization_id, actor_user_id, action, outcome, target_type, target_id, metadata)
    VALUES (inv.organization_id, uid, 'member.invite_declined', 'success', 'member_invite', inv.id, '{}'::jsonb);
    RETURN 'declined';
  END IF;

  SELECT id INTO mid FROM organization_memberships WHERE organization_id = inv.organization_id AND user_id = uid;
  IF mid IS NULL THEN
    INSERT INTO organization_memberships (organization_id, user_id, job_title)
    VALUES (inv.organization_id, uid, inv.job_title)
    RETURNING id INTO mid;
  ELSE
    -- Added again after being removed: start again with the invite's roles only.
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
  RETURN 'accepted';
END
$$;
REVOKE ALL ON FUNCTION app.respond_to_invite(text, text, text, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.respond_to_invite(text, text, text, uuid, boolean) TO rsb_app;
