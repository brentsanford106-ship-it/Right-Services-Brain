-- 0019_photo_comments: comments and replies on photos, with @mentions (JB's spec of 2026-11-23, step 2).
--
--   * Anyone who can see a photo (through its job) can read its comments. Writing needs photo_comments.create,
--     which every default role has.
--   * Replies are one level deep: a reply always belongs to a top-level comment on the same photo.
--   * People edit only their own comments. Every earlier wording is kept in photo_comment_revisions (add-only),
--     written by the database itself, so an edit can never hide what was said before.
--   * Deleting a comment hides it ("Comment deleted") but keeps the row and its wording for accountability.
--     People delete their own; photo_comments.moderate (owner by default) lets someone delete anyone's.
--   * Who wrote a comment, which photo it is on and what it replies to can never be changed: the app is only
--     allowed to change the wording and the edited/deleted markers.
--   * Mentions record who was @mentioned (used for alerts in step 5). Only people who can see the job.
--   * "Delete forever" of a photo also removes its comments, revisions and mentions.

CREATE TABLE photo_comments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  photo_id                  uuid NOT NULL,
  parent_id                 uuid,
  author_membership_id      uuid NOT NULL,
  body                      text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  client_ref                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  edited_at                 timestamptz,
  deleted_at                timestamptz,
  deleted_by_membership_id  uuid,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, photo_id, id),
  UNIQUE (organization_id, client_ref),
  CHECK ((deleted_at IS NULL) = (deleted_by_membership_id IS NULL)),
  CHECK (parent_id IS NULL OR parent_id <> id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, photo_id) REFERENCES photos (organization_id, id) ON DELETE RESTRICT,
  -- A reply must be on the same photo as the comment it answers.
  FOREIGN KEY (organization_id, photo_id, parent_id) REFERENCES photo_comments (organization_id, photo_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, author_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, deleted_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX photo_comments_photo_idx ON photo_comments (organization_id, photo_id, created_at);

CREATE TABLE photo_comment_revisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  comment_id       uuid NOT NULL,
  body             text NOT NULL,
  replaced_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, comment_id) REFERENCES photo_comments (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX photo_comment_revisions_comment_idx ON photo_comment_revisions (organization_id, comment_id, replaced_at);

CREATE TABLE photo_comment_mentions (
  organization_id  uuid NOT NULL,
  comment_id       uuid NOT NULL,
  membership_id    uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, comment_id, membership_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, comment_id) REFERENCES photo_comments (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX photo_comment_mentions_person_idx ON photo_comment_mentions (organization_id, membership_id, created_at);

-- Replies are one level deep.
CREATE FUNCTION app.photo_comments_one_level() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM photo_comments c WHERE c.organization_id = NEW.organization_id AND c.id = NEW.parent_id AND c.parent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a reply cannot have replies of its own' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER photo_comments_one_level BEFORE INSERT ON photo_comments FOR EACH ROW EXECUTE FUNCTION app.photo_comments_one_level();

-- Every earlier wording is kept. Runs inside the same change, so an edit without its revision is impossible.
CREATE FUNCTION app.photo_comments_keep_revision() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    INSERT INTO photo_comment_revisions (organization_id, comment_id, body) VALUES (OLD.organization_id, OLD.id, OLD.body);
    NEW.edited_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER photo_comments_keep_revision BEFORE UPDATE OF body ON photo_comments FOR EACH ROW EXECUTE FUNCTION app.photo_comments_keep_revision();

-- Company walls, the same as every other company table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['photo_comments', 'photo_comment_revisions', 'photo_comment_mentions'] LOOP
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
CREATE TRIGGER photo_comments_org_immutable BEFORE UPDATE ON photo_comments FOR EACH ROW EXECUTE FUNCTION app.forbid_org_change();

-- The app may add comments, and change only the wording and the edited/deleted markers.
-- Revisions and mentions are add-only.
GRANT SELECT, INSERT ON photo_comments, photo_comment_revisions, photo_comment_mentions TO rsb_app;
GRANT UPDATE (body, edited_at, deleted_at, deleted_by_membership_id) ON photo_comments TO rsb_app;

-- "Delete forever" also removes the photo's comments (with their revisions and mentions).
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
  DELETE FROM photo_comment_mentions m USING photo_comments c
   WHERE m.organization_id = org AND c.organization_id = org AND m.comment_id = c.id AND c.photo_id = p_photo_id;
  DELETE FROM photo_comment_revisions r USING photo_comments c
   WHERE r.organization_id = org AND c.organization_id = org AND r.comment_id = c.id AND c.photo_id = p_photo_id;
  DELETE FROM photo_comments c WHERE c.organization_id = org AND c.photo_id = p_photo_id AND c.parent_id IS NOT NULL;
  DELETE FROM photo_comments c WHERE c.organization_id = org AND c.photo_id = p_photo_id;
  DELETE FROM photo_flags f WHERE f.organization_id = org AND f.photo_id = p_photo_id;
  RETURN QUERY
    DELETE FROM photos p
     WHERE p.organization_id = org AND p.id = p_photo_id AND p.deleted_at IS NOT NULL
    RETURNING p.job_id, p.storage_key, p.preview_storage_key;
END
$$;
REVOKE ALL ON FUNCTION app.purge_deleted_photo(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_deleted_photo(uuid) TO rsb_app;

INSERT INTO permissions (key, description) VALUES
  ('photo_comments.create', 'Comment on photos and reply to comments on jobs they can see'),
  ('photo_comments.moderate', 'Delete anyone''s comment (the wording is still kept for the record)');

INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT r.organization_id, r.id, 'photo_comments.create' FROM roles r WHERE r.key IN ('owner', 'manager', 'employee')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT r.organization_id, r.id, 'photo_comments.moderate' FROM roles r WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;
