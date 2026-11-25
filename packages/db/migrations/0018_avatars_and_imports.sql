-- 0018_avatars_and_imports: profile pictures, and adding photos from the phone's photo library (JB, 2026-11-23).
--
-- Profile pictures
--   * One small picture per person per company (stored on their membership), so company walls apply as usual.
--     The file lives at org/<company>/avatars/<membership>. avatar_updated_at changes on every new picture.
--   * The API lets people change only their own picture. People who can manage the team may remove one.
--
-- Imported photos
--   * capture_source 'imported' (added in 0017) marks a photo added from the phone's library. Who took it is
--     unknown unless it can be reliably established, so the photographer stays empty.
--   * captured_at_known: false when the file had no "date taken", so captured_at is only the time it was added.
--     In-app camera photos always know when they were taken.
--   * New permission photos.import, on for every default role; an owner can switch it off per role.

ALTER TABLE organization_memberships
  ADD COLUMN avatar_storage_key text CHECK (avatar_storage_key IS NULL OR (length(avatar_storage_key) <= 300 AND avatar_storage_key ~ '^[a-z0-9/_-]+$')),
  ADD COLUMN avatar_updated_at timestamptz,
  ADD CONSTRAINT memberships_avatar_consistency CHECK ((avatar_storage_key IS NULL) = (avatar_updated_at IS NULL));
GRANT UPDATE (avatar_storage_key, avatar_updated_at) ON organization_memberships TO rsb_app;

ALTER TABLE photos
  ADD COLUMN captured_at_known boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT photos_in_app_time_known CHECK (capture_source <> 'in_app_camera' OR captured_at_known);

INSERT INTO permissions (key, description) VALUES
  ('photos.import', 'Add photos from the phone''s photo library to a job (marked "Imported"; who took them shows as unknown)');

INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT r.organization_id, r.id, 'photos.import' FROM roles r WHERE r.key IN ('owner', 'manager', 'employee')
ON CONFLICT DO NOTHING;
