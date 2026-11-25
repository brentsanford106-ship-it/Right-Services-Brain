-- 0015_claim_invites_race: a person's very first sign-in could fail with "You haven't been added to a company yet"
-- if two requests arrived at the same moment. The second request waited for the first to take the invite, then saw
-- no open invite left. Now it returns the account the first request just created. Nothing else changes.

CREATE OR REPLACE FUNCTION app.claim_invites(p_issuer text, p_subject text, p_email text, p_name text)
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

  -- Two first requests at the same moment (for example the website loading two things right after sign-in):
  -- the second one waits for the first one's invite lock above, then finds the invites already taken. The
  -- account the first one created is visible now, so return it instead of "not added to a company".
  IF uid IS NULL THEN
    SELECT id INTO uid FROM users WHERE idp_issuer = p_issuer AND idp_subject = p_subject AND status = 'active';
  END IF;

  RETURN uid;
END
$$;
