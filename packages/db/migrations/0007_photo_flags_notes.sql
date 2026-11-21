-- 0007_photo_flags_notes: quick flag/unflag and editable notes on photos (Phase 1 camera workflow).
--
-- The `caption` column becomes the photo's note (longer limit). A photo can be
-- flagged/unflagged at any time, including offline on the phone; the latest
-- state is synchronised. Who flagged and when is kept, and every change is audited.

ALTER TABLE photos DROP CONSTRAINT photos_caption_check;
ALTER TABLE photos ADD CONSTRAINT photos_caption_check CHECK (caption IS NULL OR length(caption) <= 2000);

ALTER TABLE photos
  ADD COLUMN is_flagged               boolean NOT NULL DEFAULT false,
  ADD COLUMN flagged_at               timestamptz,
  ADD COLUMN flagged_by_membership_id uuid,
  ADD COLUMN updated_at               timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT photos_flag_consistency CHECK (is_flagged = (flagged_at IS NOT NULL AND flagged_by_membership_id IS NOT NULL)),
  ADD CONSTRAINT photos_flagged_by_fk FOREIGN KEY (organization_id, flagged_by_membership_id)
      REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT;

-- Only before/during/after are offered for new photos; existing categories stay valid.
CREATE TRIGGER photos_touch BEFORE UPDATE ON photos FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE INDEX photos_org_flagged_idx ON photos (organization_id, job_id) WHERE is_flagged;

-- Job search by number or name.
CREATE INDEX jobs_org_title_idx ON jobs (organization_id, lower(title));
