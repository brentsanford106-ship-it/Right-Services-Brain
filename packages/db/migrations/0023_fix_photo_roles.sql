-- 0023_fix_photo_roles: which box a fix photo was put in, Before or After (JB, 2026-11-24).
--
--   * "Send fix for review" has a Before box (optional) and an After box (needed). Any photo on the job can go in
--     either box: the photo's own Before/During/After tag doesn't matter, because people forget to change it.
--   * photo_role says which box. Older fix photos (before this) have no role and count as After.
--   * The history stays add-only; this only adds a column that is set when the event is written.

ALTER TABLE photo_issue_events ADD COLUMN photo_role text CHECK (photo_role IN ('before', 'after'));
ALTER TABLE photo_issue_events ADD CONSTRAINT photo_issue_events_role_only_for_fix_photos CHECK (photo_role IS NULL OR kind = 'fix_photo_added');
