-- 0022_notifications: in-app alerts and per-person alert settings (JB's spec of 2026-11-23, step 5).
--
--   * One row per alert per person. The server writes them when something happens that the person should know:
--       mention          someone @mentioned you in a comment
--       reply            someone replied to your comment
--       photo_comment    someone commented on a photo you took
--       issue_assigned   an issue was assigned to you
--       issue_reported   someone reported an issue that nobody is assigned to (to managers on the job)
--       issue_submitted  a fix is waiting for review (to managers on the job)
--       issue_approved   your fix was approved
--       issue_sent_back  your fix was sent back
--       issue_reopened   an issue assigned to you was reopened
--   * Nobody gets an alert about their own action, and only people who can see the job get one.
--     The API also re-checks that the person can still see the job every time alerts are read.
--   * The app may only add alerts and mark them read. Which person, photo and action an alert is about can't change.
--   * notification_preferences: the alert kinds a person switched off (per person, per company).
--   * "Delete forever" of a photo also removes its alerts (and its comments' alerts).

CREATE TABLE notifications (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  recipient_membership_id   uuid NOT NULL,
  actor_membership_id       uuid NOT NULL,
  kind                      text NOT NULL CHECK (kind IN ('mention', 'reply', 'photo_comment', 'issue_assigned', 'issue_reported',
                                                           'issue_submitted', 'issue_approved', 'issue_sent_back', 'issue_reopened')),
  job_id                    uuid NOT NULL,
  photo_id                  uuid NOT NULL,
  comment_id                uuid,
  issue_id                  uuid,
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at                   timestamptz,
  CHECK (recipient_membership_id <> actor_membership_id),
  CHECK ((comment_id IS NOT NULL) = (kind IN ('mention', 'reply', 'photo_comment'))),
  CHECK ((issue_id IS NOT NULL) = (kind LIKE 'issue\_%')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, recipient_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, job_id) REFERENCES jobs (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, photo_id) REFERENCES photos (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, comment_id) REFERENCES photo_comments (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, issue_id) REFERENCES photo_issues (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX notifications_recipient_idx ON notifications (organization_id, recipient_membership_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (organization_id, recipient_membership_id) WHERE read_at IS NULL;
CREATE INDEX notifications_photo_idx ON notifications (organization_id, photo_id);
CREATE INDEX notifications_comment_idx ON notifications (organization_id, comment_id) WHERE comment_id IS NOT NULL;

-- The photo must be on the job, and the comment or issue on the photo.
CREATE FUNCTION app.notifications_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM photos p WHERE p.organization_id = NEW.organization_id AND p.id = NEW.photo_id AND p.job_id = NEW.job_id) THEN
    RAISE EXCEPTION 'the photo is not on this job' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.comment_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM photo_comments c WHERE c.organization_id = NEW.organization_id AND c.id = NEW.comment_id AND c.photo_id = NEW.photo_id) THEN
    RAISE EXCEPTION 'the comment is not on this photo' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.issue_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM photo_issues i WHERE i.organization_id = NEW.organization_id AND i.id = NEW.issue_id AND i.photo_id = NEW.photo_id) THEN
    RAISE EXCEPTION 'the issue is not on this photo' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER notifications_check BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION app.notifications_check();

CREATE TABLE notification_preferences (
  organization_id  uuid NOT NULL,
  membership_id    uuid NOT NULL,
  muted_kinds      text[] NOT NULL DEFAULT '{}' CHECK (muted_kinds <@ ARRAY['mention', 'reply', 'photo_comment', 'issue_assigned', 'issue_reported',
                                                                         'issue_submitted', 'issue_approved', 'issue_sent_back', 'issue_reopened']::text[]),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, membership_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);

-- Company walls, the same as every other company table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences'] LOOP
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
CREATE TRIGGER notifications_org_immutable BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION app.forbid_org_change();
CREATE TRIGGER notification_preferences_org_immutable BEFORE UPDATE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION app.forbid_org_change();

-- The app adds alerts and marks them read; nothing else about an alert can change. Preferences: only the muted list.
GRANT SELECT, INSERT ON notifications, notification_preferences TO rsb_app;
GRANT UPDATE (read_at) ON notifications TO rsb_app;
GRANT UPDATE (muted_kinds, updated_at) ON notification_preferences TO rsb_app;
