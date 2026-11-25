-- 0006_photo_location_and_storage: Phase 1 photo features.
-- Photos are "filed" under their job and can be recalled by job number, date, or location.
--
-- Two stored files per photo:
--   * ORIGINAL: the exact bytes the phone sent, preserved unmodified (may contain
--     embedded EXIF metadata such as GPS). Downloadable only with photos.read_original.
--   * PREVIEW: a re-encoded JPEG with all embedded metadata removed, used for
--     everyday viewing by anyone who can see the job.
-- Key metadata is ALSO stored as separate columns: capture time (captured_at),
-- upload time (stored_at), employee (uploaded_by_membership_id), job (job_id),
-- and optional GPS (latitude/longitude/location_accuracy_m).
--
-- Location is personal data (it reveals where an employee was). It is captured
-- only at the moment a photo is taken, only with the device permission granted,
-- and returned only to members who can already see the photo's job.

-- Fix: PostgreSQL regex repetition counts are limited to 255, so the {1,300}
-- storage-key checks from 0003 raised an error when used. Replace them.
ALTER TABLE photos DROP CONSTRAINT photos_storage_key_check;
ALTER TABLE photos ADD CONSTRAINT photos_storage_key_check CHECK (storage_key IS NULL OR (length(storage_key) <= 300 AND storage_key ~ '^[a-z0-9/_-]+$'));
ALTER TABLE documents DROP CONSTRAINT documents_storage_key_check;
ALTER TABLE documents ADD CONSTRAINT documents_storage_key_check CHECK (length(storage_key) BETWEEN 1 AND 300 AND storage_key ~ '^[a-z0-9/_-]+$');

ALTER TABLE photos DROP CONSTRAINT photos_content_type_check;
ALTER TABLE photos ADD CONSTRAINT photos_content_type_check CHECK (content_type IN ('image/jpeg', 'image/png', 'image/heic'));

ALTER TABLE photos
  ADD COLUMN latitude            double precision CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude           double precision CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  ADD COLUMN location_accuracy_m real CHECK (location_accuracy_m IS NULL OR location_accuracy_m BETWEEN 0 AND 100000),
  ADD COLUMN original_sha256     text CHECK (original_sha256 IS NULL OR original_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN preview_storage_key text CHECK (preview_storage_key IS NULL OR (length(preview_storage_key) <= 300 AND preview_storage_key ~ '^[a-z0-9/_-]+$')),
  ADD COLUMN width_px            integer CHECK (width_px IS NULL OR width_px BETWEEN 1 AND 20000),
  ADD COLUMN height_px           integer CHECK (height_px IS NULL OR height_px BETWEEN 1 AND 20000),
  ADD COLUMN stored_at           timestamptz,
  ADD CONSTRAINT photos_lat_lng_together CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT photos_stored_consistency CHECK (
    (upload_status = 'stored') = (storage_key IS NOT NULL AND original_sha256 IS NOT NULL AND size_bytes IS NOT NULL AND stored_at IS NOT NULL)
  );

CREATE INDEX photos_org_captured_idx ON photos (organization_id, captured_at DESC);
CREATE INDEX photos_org_location_idx ON photos (organization_id, latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX jobs_org_site_name_idx ON jobs (organization_id, lower(site_name));

INSERT INTO permissions (key, description) VALUES
  ('photos.read_original', 'Download original photo files, including embedded metadata');
