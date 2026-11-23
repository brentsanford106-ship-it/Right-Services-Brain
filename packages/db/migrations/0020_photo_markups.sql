-- 0020_photo_markups: drawing on photos (JB's spec of 2026-11-23, step 3).
--
--   * Each mark (circle, arrow, pen line, box, text, numbered pin) is its own row: shape data only, as fractions
--     (0 to 1) of the upright photo. The stored photo file is never touched.
--   * Owners and managers draw (photo_markups.create, JB's decision: employees comment but don't draw).
--     People remove their own marks; photo_markups.manage (owner by default) removes anyone's.
--   * A saved mark never changes. "Editing" is removing it and adding a new one, and removed marks are kept
--     (hidden) with who removed them and when, so the history stays complete.
--   * A comment can point at one mark ("comment on this circle"); the mark must be on the same photo.
--   * "Delete forever" of a photo also removes its marks.

CREATE TABLE photo_markups (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  photo_id                  uuid NOT NULL,
  author_membership_id      uuid NOT NULL,
  kind                      text NOT NULL CHECK (kind IN ('circle', 'arrow', 'pen', 'rect', 'text', 'pin')),
  color                     text NOT NULL CHECK (color IN ('red', 'yellow', 'green', 'blue', 'white', 'black')),
  size                      smallint NOT NULL CHECK (size BETWEEN 1 AND 3),
  -- [[x, y], ...] as fractions of the upright photo. Checked in full by the API; the database checks the outline.
  points                    jsonb NOT NULL CHECK (jsonb_typeof(points) = 'array' AND jsonb_array_length(points) BETWEEN 1 AND 2000),
  label                     text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 200),
  client_ref                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  removed_at                timestamptz,
  removed_by_membership_id  uuid,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, photo_id, id),
  UNIQUE (organization_id, client_ref),
  CHECK ((removed_at IS NULL) = (removed_by_membership_id IS NULL)),
  CHECK (kind = 'pin' OR (kind = 'text') = (label IS NOT NULL)), -- text needs words; a pin may have a short label
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, photo_id) REFERENCES photos (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, author_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, removed_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX photo_markups_photo_idx ON photo_markups (organization_id, photo_id, created_at);

ALTER TABLE photo_markups ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_markups FORCE ROW LEVEL SECURITY;
CREATE POLICY photo_markups_tenant_isolation ON photo_markups FOR ALL TO rsb_app
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY photo_markups_admin_tools ON photo_markups FOR ALL TO rsb_admin_tools USING (true) WITH CHECK (true);
CREATE TRIGGER photo_markups_org_immutable BEFORE UPDATE ON photo_markups FOR EACH ROW EXECUTE FUNCTION app.forbid_org_change();

-- A saved mark can only be marked removed; nothing else about it can change.
GRANT SELECT, INSERT ON photo_markups TO rsb_app;
GRANT UPDATE (removed_at, removed_by_membership_id) ON photo_markups TO rsb_app;

-- Comments on one mark.
ALTER TABLE photo_comments
  ADD COLUMN markup_id uuid,
  ADD CONSTRAINT photo_comments_markup_fk FOREIGN KEY (organization_id, photo_id, markup_id)
      REFERENCES photo_markups (organization_id, photo_id, id) ON DELETE RESTRICT;

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

INSERT INTO permissions (key, description) VALUES
  ('photo_markups.create', 'Draw on photos (circles, arrows, pen, boxes, text, pins) and remove their own marks'),
  ('photo_markups.manage', 'Remove anyone''s marks on photos (removed marks are still kept for the record)');

INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT r.organization_id, r.id, 'photo_markups.create' FROM roles r WHERE r.key IN ('owner', 'manager')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT r.organization_id, r.id, 'photo_markups.manage' FROM roles r WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;
