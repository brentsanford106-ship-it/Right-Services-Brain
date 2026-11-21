-- 0012_sign_in_interval: owners choose how often people must sign in again (real sign-in only).
-- Enforced by the apps when they are online: an overdue person goes back to the sign-in screen and
-- keeps any unsent photos. It never blocks taking photos offline. Removal is still immediate on the server.
ALTER TABLE organizations
  ADD COLUMN sign_in_every_days integer NOT NULL DEFAULT 30
  CHECK (sign_in_every_days IN (1, 7, 14, 30, 60, 90));
GRANT UPDATE (sign_in_every_days) ON organizations TO rsb_app;
