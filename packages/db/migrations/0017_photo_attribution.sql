-- 0017_photo_attribution: who TOOK each photo, kept separate from who UPLOADED it (JB's spec of 2026-11-23, part 3).
--
--   * photographer_membership_id: the person who took the photo. Empty (NULL) means "unknown", which is what an
--     imported photo shows unless it can be reliably established. People are never deleted (only suspended or
--     removed), so the name keeps showing on old photos after someone leaves.
--   * capture_source: how the photo got into the app. Today every photo comes from the in-app camera.
--     'imported' (from the phone's photo library) and 'web_upload' are reserved for the import feature.
--   * A photo taken with the in-app camera is always credited to the signed-in person who took it: the database
--     refuses anything else.
--   * Who took it, who uploaded it and how it got here can never be changed afterwards.

ALTER TABLE photos
  ADD COLUMN photographer_membership_id uuid,
  ADD COLUMN capture_source text NOT NULL DEFAULT 'in_app_camera'
    CHECK (capture_source IN ('in_app_camera', 'imported', 'web_upload')),
  ADD CONSTRAINT photos_photographer_fk FOREIGN KEY (organization_id, photographer_membership_id)
      REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT;

-- Every existing photo came from the in-app camera, so the person who uploaded it took it.
UPDATE photos SET photographer_membership_id = uploaded_by_membership_id WHERE photographer_membership_id IS NULL;

ALTER TABLE photos ADD CONSTRAINT photos_in_app_photographer CHECK (
  capture_source <> 'in_app_camera' OR photographer_membership_id IS NOT DISTINCT FROM uploaded_by_membership_id
);

-- New in-app photos are credited to their uploader automatically (no caller has to remember to).
CREATE FUNCTION app.photos_default_photographer() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.capture_source = 'in_app_camera' AND NEW.photographer_membership_id IS NULL THEN
    NEW.photographer_membership_id := NEW.uploaded_by_membership_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER photos_default_photographer BEFORE INSERT ON photos FOR EACH ROW EXECUTE FUNCTION app.photos_default_photographer();

CREATE FUNCTION app.photos_keep_attribution() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.uploaded_by_membership_id IS DISTINCT FROM OLD.uploaded_by_membership_id
     OR NEW.photographer_membership_id IS DISTINCT FROM OLD.photographer_membership_id
     OR NEW.capture_source IS DISTINCT FROM OLD.capture_source THEN
    RAISE EXCEPTION 'who took or uploaded a photo cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER photos_keep_attribution BEFORE UPDATE OF uploaded_by_membership_id, photographer_membership_id, capture_source
  ON photos FOR EACH ROW EXECUTE FUNCTION app.photos_keep_attribution();

-- "Show me only John's photos" on a job.
CREATE INDEX photos_job_photographer_idx ON photos (organization_id, job_id, photographer_membership_id) WHERE deleted_at IS NULL;
