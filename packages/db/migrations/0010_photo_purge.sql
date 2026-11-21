-- 0010_photo_purge: "Delete forever" from Recently Deleted, and a per-company setting for how long
-- Recently Deleted keeps photos before they are removed automatically.
--
-- Permanently deleting a photo removes its database row (and its review flags); the API then removes
-- the stored image files. The audit log keeps a record that the photo existed and who removed it.
-- The app role gets NO general DELETE right on photos: it can only call app.purge_deleted_photo(),
-- which refuses anything that is not already in Recently Deleted in the caller's own company.

INSERT INTO permissions (key, description) VALUES
  ('photos.purge', 'Permanently delete photos that are in Recently Deleted (cannot be undone)');

INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT r.organization_id, r.id, 'photos.purge' FROM roles r WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;

-- How many days a deleted photo stays in Recently Deleted. Owners (org.manage) can change it.
ALTER TABLE organizations
  ADD COLUMN deleted_photo_retention_days integer NOT NULL DEFAULT 30
      CHECK (deleted_photo_retention_days IN (7, 14, 30, 60, 90));

-- The app may change ONLY this column, and only for the company it is working in.
GRANT UPDATE (deleted_photo_retention_days) ON organizations TO rsb_app;
CREATE POLICY organizations_update_settings ON organizations FOR UPDATE TO rsb_app
  USING (id = app.current_org_id())
  WITH CHECK (id = app.current_org_id());

-- Permanently removes one photo that is already soft-deleted, in the current company only.
-- Returns the storage keys so the API can delete the files after the transaction commits.
CREATE FUNCTION app.purge_deleted_photo(p_photo_id uuid)
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
  DELETE FROM photo_flags f WHERE f.organization_id = org AND f.photo_id = p_photo_id
    AND EXISTS (SELECT 1 FROM photos p WHERE p.organization_id = org AND p.id = p_photo_id AND p.deleted_at IS NOT NULL);
  RETURN QUERY
    DELETE FROM photos p
     WHERE p.organization_id = org AND p.id = p_photo_id AND p.deleted_at IS NOT NULL
    RETURNING p.job_id, p.storage_key, p.preview_storage_key;
END
$$;
REVOKE ALL ON FUNCTION app.purge_deleted_photo(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_deleted_photo(uuid) TO rsb_app;

-- For the scheduled clean-up: which deleted photos (in any company) are past that company's keep time.
-- Returns ids only; each one is then purged inside that company's own context.
CREATE FUNCTION app.photos_past_retention(p_limit integer)
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
   ORDER BY p.deleted_at
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION app.photos_past_retention(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.photos_past_retention(integer) TO rsb_app;
