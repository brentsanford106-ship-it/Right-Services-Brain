-- 0021_photo_issues: issues to fix on photos, with review (JB's spec of 2026-11-23, step 4).
--
--   * An issue is something to fix, shown on a photo (and optionally on one mark, like a red circle).
--     Flags, comments and issues stay separate things.
--   * Status lives on each issue: open -> in_progress -> awaiting_review -> resolved.
--       - Send back:  awaiting_review -> open (with a note saying what's still wrong)
--       - Reopen:     resolved -> open
--   * Anyone who can report issues (photo_issues.create, every default role) can report one. An employee's report
--     goes to the job's Issues list unassigned, for a manager to assign (JB: "Report issue" button).
--   * Managers (photo_issues.manage) assign, approve, send back and reopen. Every fix needs a manager's approval,
--     and nobody approves their own fix, except an issue they assigned to themselves.
--   * The history (photo_issue_events) is add-only: who did what, when, from which status to which, any note, and
--     the "after" photos sent as proof of the fix. The database refuses a status change it doesn't allow.
--   * A photo that has ever had an issue (or was sent as proof of a fix) can't be deleted forever, so the record
--     of the work is never lost. It can still go to Recently Deleted and be restored.

CREATE TABLE photo_issues (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL,
  job_id                     uuid NOT NULL,
  photo_id                   uuid NOT NULL,
  markup_id                  uuid,
  title                      text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  details                    text CHECK (details IS NULL OR length(details) <= 2000),
  status                     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'awaiting_review', 'resolved')),
  assignee_membership_id     uuid,
  created_by_membership_id   uuid NOT NULL,
  submitted_by_membership_id uuid,
  resolved_by_membership_id  uuid,
  resolved_at                timestamptz,
  client_ref                 uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, client_ref),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL AND resolved_by_membership_id IS NOT NULL)),
  CHECK (status <> 'awaiting_review' OR submitted_by_membership_id IS NOT NULL),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, job_id) REFERENCES jobs (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, photo_id) REFERENCES photos (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, photo_id, markup_id) REFERENCES photo_markups (organization_id, photo_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, assignee_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, submitted_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, resolved_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX photo_issues_job_idx ON photo_issues (organization_id, job_id, status);
CREATE INDEX photo_issues_photo_idx ON photo_issues (organization_id, photo_id);
CREATE INDEX photo_issues_assignee_idx ON photo_issues (organization_id, assignee_membership_id, status);

CREATE TABLE photo_issue_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  issue_id             uuid NOT NULL,
  actor_membership_id  uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('reported', 'assigned', 'unassigned', 'started', 'submitted', 'approved',
                                                     'sent_back', 'reopened', 'edited', 'fix_photo_added')),
  from_status          text,
  to_status            text,
  note                 text CHECK (note IS NULL OR length(note) <= 2000),
  assignee_membership_id uuid,
  photo_id             uuid,
  client_ref           uuid,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, client_ref),
  CHECK (kind <> 'fix_photo_added' OR photo_id IS NOT NULL),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, issue_id) REFERENCES photo_issues (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, assignee_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, photo_id) REFERENCES photos (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX photo_issue_events_issue_idx ON photo_issue_events (organization_id, issue_id, created_at);
CREATE INDEX photo_issue_events_photo_idx ON photo_issue_events (organization_id, photo_id) WHERE photo_id IS NOT NULL;

-- Only these status changes exist. Anything else is refused, whoever asks.
CREATE FUNCTION app.photo_issues_check_status() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open'            AND NEW.status IN ('in_progress', 'awaiting_review', 'resolved'))
    OR (OLD.status = 'in_progress'     AND NEW.status IN ('open', 'awaiting_review', 'resolved'))
    OR (OLD.status = 'awaiting_review' AND NEW.status IN ('open', 'resolved'))
    OR (OLD.status = 'resolved'        AND NEW.status = 'open')) THEN
    RAISE EXCEPTION 'an issue cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.photo_id IS DISTINCT FROM OLD.photo_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.created_by_membership_id IS DISTINCT FROM OLD.created_by_membership_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'where an issue is and who reported it cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER photo_issues_check_status BEFORE UPDATE ON photo_issues FOR EACH ROW EXECUTE FUNCTION app.photo_issues_check_status();

-- An issue is on its photo's job; a new issue always starts open.
CREATE FUNCTION app.photo_issues_on_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM photos p WHERE p.organization_id = NEW.organization_id AND p.id = NEW.photo_id AND p.job_id = NEW.job_id) THEN
    RAISE EXCEPTION 'the issue must be on the photo''s own job' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'open' THEN
    RAISE EXCEPTION 'a new issue starts open' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER photo_issues_on_insert BEFORE INSERT ON photo_issues FOR EACH ROW EXECUTE FUNCTION app.photo_issues_on_insert();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['photo_issues', 'photo_issue_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO rsb_app
         USING (organization_id = app.current_org_id())
         WITH CHECK (organization_id = app.current_org_id())',
      t || '_tenant_isolation', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO rsb_admin_tools USING (true) WITH CHECK (true)', t || '_admin_tools', t);
  END LOOP;
END
$$;
CREATE TRIGGER photo_issues_org_immutable BEFORE UPDATE ON photo_issues FOR EACH ROW EXECUTE FUNCTION app.forbid_org_change();

GRANT SELECT, INSERT ON photo_issues, photo_issue_events TO rsb_app;
GRANT UPDATE (title, details, status, assignee_membership_id, submitted_by_membership_id, resolved_by_membership_id, resolved_at, updated_at)
  ON photo_issues TO rsb_app;

-- A photo with issue history is never deleted forever (it may still sit in Recently Deleted).
CREATE FUNCTION app.photo_has_issue_history(p_org uuid, p_photo uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  AS $$
  SELECT EXISTS (SELECT 1 FROM photo_issues i WHERE i.organization_id = p_org AND i.photo_id = p_photo)
      OR EXISTS (SELECT 1 FROM photo_issue_events e WHERE e.organization_id = p_org AND e.photo_id = p_photo)
$$;

CREATE OR REPLACE FUNCTION app.purge_deleted_photo(p_photo_id uuid)
  RETURNS TABLE (job_id uuid, storage_key text, preview_storage_key text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE org uuid := app.current_org_id();
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'no company context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM photos p WHERE p.organization_id = org AND p.id = p_photo_id AND p.deleted_at IS NOT NULL) THEN
    RETURN;
  END IF;
  IF app.photo_has_issue_history(org, p_photo_id) THEN
    RAISE EXCEPTION 'this photo is part of an issue''s history and cannot be deleted forever' USING ERRCODE = 'restrict_violation';
  END IF;
  DELETE FROM photo_comment_mentions m USING photo_comments c
   WHERE m.organization_id = org AND c.organization_id = org AND m.comment_id = c.id AND c.photo_id = p_photo_id;
  DELETE FROM photo_comment_revisions r USING photo_comments c
   WHERE r.organization_id = org AND c.organization_id = org AND r.comment_id = c.id AND c.photo_id = p_photo_id;
  DELETE FROM photo_comments c WHERE c.organization_id = org AND c.photo_id = p_photo_id AND c.parent_id IS NOT NULL;
  DELETE FROM photo_comments c WHERE c.organization_id = org AND c.photo_id = p_photo_id;
  DELETE FROM photo_markups k WHERE k.organization_id = org AND k.photo_id = p_photo_id;
  DELETE FROM photo_flags f WHERE f.organization_id = org AND f.photo_id = p_photo_id;
  RETURN QUERY
    DELETE FROM photos p
     WHERE p.organization_id = org AND p.id = p_photo_id AND p.deleted_at IS NOT NULL
    RETURNING p.job_id, p.storage_key, p.preview_storage_key;
END
$$;
REVOKE ALL ON FUNCTION app.purge_deleted_photo(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_deleted_photo(uuid) TO rsb_app;

-- The scheduled clean-up skips photos with issue history (they stay in Recently Deleted).
CREATE OR REPLACE FUNCTION app.photos_past_retention(p_limit integer)
  RETURNS TABLE (organization_id uuid, photo_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT p.organization_id, p.id
    FROM photos p
    JOIN organizations o ON o.id = p.organization_id
   WHERE p.deleted_at IS NOT NULL
     AND p.deleted_at < now() - make_interval(days => o.deleted_photo_retention_days)
     AND NOT app.photo_has_issue_history(p.organization_id, p.id)
   ORDER BY p.deleted_at
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION app.photos_past_retention(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.photos_past_retention(integer) TO rsb_app;

INSERT INTO permissions (key, description) VALUES
  ('photo_issues.create', 'Report an issue on a photo (it goes to the job''s Issues list for a manager to assign)'),
  ('photo_issues.manage', 'Assign issues, approve or send back fixes, and reopen issues');

INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT r.organization_id, r.id, 'photo_issues.create' FROM roles r WHERE r.key IN ('owner', 'manager', 'employee')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT r.organization_id, r.id, 'photo_issues.manage' FROM roles r WHERE r.key IN ('owner', 'manager')
ON CONFLICT DO NOTHING;
