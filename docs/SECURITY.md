# Security: what is in place, and what isn't

This is a development build. **It is not secure for real data yet.** The items under "Must be done before real data" are blocking.

## In place and tested

**Company separation (multi-tenant)**
- Every company's rows are protected by PostgreSQL row-level security, forced on every table, using the company set by the server for each request. The server's database login cannot bypass it and does not own the tables.
- Cross-company references are blocked by composite foreign keys (a row can only point to rows of the same company).
- Tests try reading, searching, editing and downloading another company's jobs and photos by exact id and by search; all return "not found".

**Access rules**
- Employees see only jobs they are assigned to and only change their own photos. Managers and owners can flag, note and re-stage any photo in their company. Downloading the full-resolution original needs a separate permission and is audited.
- Every rule is enforced by the server. The apps only hide buttons.

**Photo links are not shareable ("bearer") links**
- There are no signed or public URLs. Every image download needs the signed-in person's token in the request header, and the server checks company, job access and permission on every download. Responses are marked `private, no-store`.
- The web app downloads images with the token and shows them from memory. The iPhone app caches server images in memory only.

**Encrypted offline storage on the iPhone**
- Every photo, thumbnail, and photo detail file (job number, notes, GPS, flags) is encrypted with AES-256-GCM before being written to the app's private folder. The file's name is bound into the encryption so files can't be swapped.
- Encryption is done by iOS (Apple CryptoKit, via expo-crypto).
- **The key**: a random 256-bit key created on the phone, stored only in the iOS Keychain with "when unlocked, this device only". It is not in iCloud or computer backups, and it can't be copied to another phone. It is readable only while the phone is unlocked.
- **Sign out**: the app warns if photos have not uploaded, then deletes all files **and destroys the key**, so anything missed can never be decrypted ("crypto-shredding"). A new key is created for the next person.
- **Removed or suspended from the company**: the next time the phone connects (Home screen load), the server answers "not found" for the company and the app does the same wipe, including photos not yet uploaded. With the development sign-in, a refused token also wipes.
- **Real sign-in expired** (Microsoft refresh token ran out or was revoked): back to the sign-in screen, unsent photos are **kept** encrypted and upload after the same person signs in again. A "not signed in" answer from the server is never treated as removal, because it can also be a passing problem (for example Microsoft's key list being unreachable, which the server reports as a temporary error).
- **Different person signs in** while photos are waiting: refused, so one person's photos are never sent under another person's name.
- **Lost or stolen phone**: photos on the phone are encrypted and need the phone's passcode to unlock the key. The account should be disabled on the server; the phone's tokens then stop working.

**Server hardening**
- Strict input validation (unknown fields rejected), magic-byte check of image files, 25 MB limit, re-encoded previews with all metadata removed, original kept byte-for-byte with a SHA-256 checksum.
- Logs never contain tokens, image bytes, notes or coordinates (tested).
- Development sign-in, local disk storage and plain-HTTP database connections are refused by configuration in staging/production.
- Append-only audit log (database triggers block edits and deletes).

## Known limits (honest list)

- **Unencrypted moments on the phone.** The camera writes each new photo to the app's private cache unencrypted; the app encrypts it and deletes that copy within about a second. During upload, a temporary decrypted copy sits in the app's private cache until the upload ends (and is cleared on the next app start if the app was closed mid-upload). Both are inside the app's sandbox, protected by iOS file protection, never in the Photos app. If the app is closed or crashes during that second, the leftover camera and thumbnail files (cache folders `Camera` and `ImageManipulator`) and any upload or share copies (`rsb-scratch`) are deleted at the next app start and on sign-out (added 2026-11-22; before that, camera leftovers stayed until iOS cleared the cache). A photo caught in that one-second window is lost (its counter had not gone up yet, so it never showed as saved).
- **Development sign-in is not secure.** Anyone who can reach the server can pick any test person. That is why the server binds to `127.0.0.1` by default and why only synthetic data is allowed.
- **Plain HTTP on your Wi-Fi during phone testing.** Fine for synthetic data; production will be HTTPS only.
- **No independent security review yet.**

## Must be done before real data

1. Real sign-in switched on and tested against a real Microsoft Entra External ID tenant (code built and tested locally 2026-11-21; see `docs/AUTHENTICATION.md`).
2. Azure Blob Storage adapter (private container, no public access) and deployment over HTTPS only.
3. Backups and a tested restore (database point-in-time restore; blob soft-delete and versioning).
4. Test on real iPhones, including lost-phone and sign-out scenarios.
5. Independent security review and fixes.

## Deleting and sharing photos (added 2026-11-21)

- **Delete is a soft delete.** A deleted photo disappears from every screen and every API answer, but its record and files are kept. Owners and managers (`photos.delete_any`) see it under **Recently deleted** on the job's web page and can restore it. Everyone can delete photos they took themselves; only owners and managers can delete other people's photos. Every delete and restore is in the audit log. Deleted photos are removed for good after the company's keep time (see below).
- **Photos never uploaded** and deleted on the phone are erased from the phone for good (there is no server copy).
- **Sharing/exporting takes a photo outside the app's protection.** Once a photo is sent by Messages or Mail, or downloaded, the company no longer controls that copy. To limit the risk: sharing needs the `photos.export` permission (on for owners, managers and employees by default; it can be removed per role), every shared or downloaded photo is recorded in the audit log *before* it leaves, the shared copy is the display-size JPEG with location data removed (not the original), and on the phone the temporary unencrypted copy is deleted as soon as the share screen closes (and the scratch folder is emptied at every app start).
- Only photos that have finished uploading can be shared, and sharing needs a connection, so the audit record cannot be skipped.

## Delete forever and the Recently Deleted keep time (added 2026-11-21)

- **Delete forever** (`photos.purge`, owners only by default) erases a photo that is already in Recently Deleted: its database record, its review flags and both stored image files. It can't be undone. The audit log keeps a `photo.purged` entry (who, when, which job) but no picture or note text.
- The app's database login has **no general right to delete photos**. It can only call `app.purge_deleted_photo()`, which refuses any photo that isn't already soft-deleted, and only in the company the request is working in. Files are deleted only after the database change has committed, so a failed request never loses a file.
- **Keep time:** each company chooses 7, 14, 30 (default), 60 or 90 days (`org.manage`, owners only by default). The server runs a clean-up every hour (first run 30 seconds after start-up) that removes photos past their own company's keep time, each inside that company's own data scope, audited as `photo.purged` with no person as actor. Clean-up only runs while the server is running; nothing is deployed yet.
- Known limit: if deleting a file fails after the record is gone, the error is logged and the file needs manual clean-up. Backups (when they exist) will still hold purged photos until the backup expires; that must be documented for customers when backups are set up.

## Team & roles (added 2026-11-21)

- Owners (or anyone given `roles.manage`) can create custom roles, edit the Manager and Employee presets, and choose each person's roles, on the website or the phone (Settings > Team & Roles).
- **No escalation:** to create, edit, delete or assign a role you must already hold every permission that role has, before and after the change. So someone with `roles.manage` but not owner can't touch the Owner role, an owner's roles, or create a role stronger than themselves. (A broader permission covers its narrow twin, e.g. "see all jobs" covers "see assigned jobs".)
- **The Owner role is locked** by a database trigger: always every permission, can't be renamed or deleted. Built-in roles can't be deleted.
- **A company always keeps an active owner:** a database trigger rejects any change that would leave none, so both co-owners can be owners, and one can step down only while another remains.
- Everything is company-scoped (row-level security plus explicit checks; another company's ids return 404). Every change is audited (`role.created`, `role.updated`, `role.deleted`, `member.roles_changed`, `org.settings_updated`). Denied attempts are audited too.
- Adding people by email, withdrawing, suspending and removing are built (see `docs/AUTHENTICATION.md`), but can't be used for real until Entra is set up. The phone picks up permission changes the next time Home loads with a connection; the server always checks the current permissions on every request regardless.

## Real sign-in (added 2026-11-21)

- Phone and website use the authorization code flow with PKCE (no app secrets anywhere). Phone: refresh token in the iOS Keychain (this device only), access token in memory. Website: everything in memory; only the one-time PKCE value and a random `state` sit in sessionStorage during the hop to Microsoft and back, then are deleted.
- The server accepts a person only if an owner added their **verified** email (Microsoft's one-time email code proves it). An email that matches no invite gets no account and no access.
- Invites are company-scoped (row-level security), one open invite per email per company, revocable, and checked against the inviter's own permissions. The roles on an invite are re-checked against the company's roles when it is accepted.
- Linking runs in one database function (`app.claim_invites`) with row locks, so two sign-ins at once can't create two accounts.
- The audit log records `member.invited`, `member.invite_revoked`, `member.invite_accepted`, `member.status_changed` without email addresses.
- Known limit: only Microsoft's email one-time code should be enabled. If other sign-in methods are added later, we must confirm each one verifies the email before it is trusted.

## Company walls (checked 2026-11-22)

`apps/api/test/company-walls.test.ts` checks that one company can never read or change another's data, in two independent layers:
- **Database:** every table holding company data has row-level security switched on and forced (checked automatically, so a new table without it fails the test). The app's own database login, working as company B, sees zero company A rows in every table and can't update or delete any.
- **Every API route (44):** company B's owner, who holds every permission, calls each route with company A's ids, both in company A's address (all answer "not found") and smuggled into company B's own address (all refused). No answer contains any company A data, and a fingerprint of all company A rows is identical before and after.

Result: no gaps found. This runs on every change (GitHub "Checks").
