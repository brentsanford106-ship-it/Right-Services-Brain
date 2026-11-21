-- 0008_photo_delete: deleting photos (soft delete, restorable by owners/managers) and
-- sharing/exporting photos out of the app (audited, can be switched off per role).
--
-- A deleted photo is hidden everywhere but kept (row and files) so an accidental
-- delete can be undone. Who deleted it and when is stored, and every delete and
-- restore is audited. Permanent removal (e.g. after 30 days) is a later task.

ALTER TABLE photos
  ADD COLUMN deleted_by_membership_id uuid,
  ADD CONSTRAINT photos_deleted_by_fk FOREIGN KEY (organization_id, deleted_by_membership_id)
      REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT photos_deleted_consistency CHECK ((deleted_at IS NULL) = (deleted_by_membership_id IS NULL));

CREATE INDEX photos_org_deleted_idx ON photos (organization_id, job_id, deleted_at) WHERE deleted_at IS NOT NULL;

INSERT INTO permissions (key, description) VALUES
  ('photos.delete_any', 'Delete or restore any photo on an accessible job (everyone may delete their own)'),
  ('photos.export',     'Send photos out of the app (Messages, Mail, download); every export is audited');

-- Existing companies: owners and managers get the new permission (matches packages/contracts ROLE_TEMPLATES).
INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT r.organization_id, r.id, 'photos.delete_any' FROM roles r WHERE r.key IN ('owner', 'manager')
ON CONFLICT DO NOTHING;

-- Sharing is on for every default role; an owner can remove it from a role later.
INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT r.organization_id, r.id, 'photos.export' FROM roles r WHERE r.key IN ('owner', 'manager', 'employee')
ON CONFLICT DO NOTHING;
