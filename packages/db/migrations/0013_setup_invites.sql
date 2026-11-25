-- 0013_setup_invites: the very first owners of a new company are added by the setup tool (pnpm db:setup-company),
-- because nobody is in the company yet to add them. Such invites have no inviting member (NULL).
ALTER TABLE member_invites ALTER COLUMN invited_by_membership_id DROP NOT NULL;
