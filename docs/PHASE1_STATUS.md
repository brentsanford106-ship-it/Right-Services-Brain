# Phase 1 status: photo management

Last updated: 2026-11-21. Phase 1 is **not complete**. The acceptance flow passes as an automated test, and most of it has now been done by hand on JB's real iPhone (iOS 26, through Expo Go) and Windows PC. Real sign-in is built and tested locally but not switched on (needs a free Microsoft Entra tenant). Cloud storage and backups are not built.

## Acceptance flow

| Step | Automated test (real server + database, over HTTP) | On a real iPhone |
| --- | --- | --- |
| Create job | Passes | Passed (new job created and saved from the phone) |
| Open camera | Not testable automatically (needs camera hardware) | Passed |
| Take multiple photos without confirming | Passes (queue + encryption) | Passed |
| Flag latest photo | Passes | Passed |
| Review thumbnail | Passes (thumbnail decrypts for display) | Not confirmed yet |
| Add note | Passes | Passed after a fix (notes now also save when you leave the box or screen; first try was lost because it only saved on **Save note**) |
| Resume camera | UI only | Not confirmed yet |
| Capture offline | Passes (network switched off, app restarted while offline) | Passed (Airplane Mode: 3 photos, then a second run of 35 photos; Expo Go fully closed while the 35 were still waiting) |
| Reconnect and synchronize | Passes (nothing lost, no duplicates, originals byte-identical) | Passed (all 3, and later all 35, uploaded on their own after reconnecting and reopening; all 35 visible on the web) |
| View photos on web | Passes (API) and web screen tests pass | Passed (photos, stages and flag visible in Chrome on the PC) |
| Flags, notes, stages and sync states persist | Passes | Not yet tested |

Test file: `apps/api/test/e2e-acceptance.test.ts`. It runs the iPhone app's real queue and upload code, with the iPhone's storage and encryption swapped for Node versions.

## Built

**iPhone/iPad app** (`apps/mobile`)
- Jobs list with search by job number, name or site; works offline from a saved copy.
- New job / edit job (for people allowed to manage jobs; needs a connection).
- Job gallery: thumbnail grid (more columns on iPad), oldest first, filters All / Before / During / After / Flagged, upload status on every tile, red border and flag badge on flagged photos.
- Continuous camera tied to the job: shoot repeatedly with no confirm step; each photo is saved encrypted and assigned to the job immediately; Before/During/After switch; latest thumbnail; big flag button for the latest photo; optional GPS; shutter feedback.
- Review screen: full-size photo, flag/unflag, note, stage, location, upload status, back to camera.
- Uploads screen: counts, "Upload now", plain explanation of iPhone upload limits, failed photos with **Try again** and **Delete** (delete always asks first).
- Settings: who is signed in, sign out with a clear warning if photos have not uploaded.

**Offline storage and upload** (`packages/photo-sync`)
- Every photo, thumbnail and photo detail (job, note, GPS) is encrypted on the phone (AES-256-GCM). The key is in the iPhone Keychain. See `docs/SECURITY.md`.
- Upload in three safe-to-repeat steps (details, file, later edits). Automatic retry with increasing waits; "needs attention" instead of silent failure; nothing deleted automatically except the full-size copy *after* the server confirms it has it.
- Edits made during an upload are not lost. Edits made offline are sent later. Changes made in the office show up on the phone.

**Web** (`apps/web`)
- Overview with photo counts and the flagged photos.
- Jobs with search, create and edit.
- Job gallery with the same filters, upload status, notes, and a full-screen viewer (arrow keys, flag/unflag, note, stage, download full-resolution original for allowed roles).
- Find photos by job number, site, date range, or distance from a location.

**Server** (`apps/api`)
- Photo flag/unflag, notes, stage changes (PATCH), with audit log entries that do not contain note text.
- Job search and edit. Photo-only dashboard.
- Delete forever from Recently Deleted (owners), and a company setting for how long Recently Deleted keeps photos (7 to 90 days, default 30) with an hourly automatic clean-up.
- Real sign-in (Microsoft Entra External ID) on phone and website, plus adding people by email, withdrawing, suspending and removing them, with the phone wiping company data when access is removed, and an owner setting for how often people must sign in again. Built and tested here; not switched on. See `docs/AUTHENTICATION.md`.
- Team & roles: custom roles, editable Manager/Employee presets, choose each person's roles, with no-escalation and keep-an-owner rules enforced on the server and in the database. Website page "Team & roles" and the same on the phone (Settings > Team & Roles).
- Receipts, vehicles, and member admin routes are switched off (`PHASE2_FEATURES=false` by default).

## Test results (2026-11-21: cloud dev environment, and again on JB's Windows PC with the same counts)

- Server: 233 of 233 pass (includes the end-to-end acceptance test, team & roles, delete-forever / keep-time, 10 add/remove-people tests and 4 tests of the real token checker against a stand-in identity provider, the "sign in again" owner setting, and the real-company setup tool). Counts from this cloud dev environment on 2026-11-21; not yet re-run on JB's PC.
- Offline queue and sync: 21 of 21 pass.
- Web: 8 of 8 pass.
- iPhone app: type check passes and the iOS bundle builds. There are no automated tests of the iPhone screens themselves.

## Simulated or not built yet

- **Sign-in is still simulated in use.** You pick a test person. Real sign-in is built and tested against a stand-in, but it has never talked to Microsoft, because no Entra tenant exists yet (needs JB's go-ahead; free, but Microsoft requires an Azure account). Blocks real data.
- **Cloud storage is not built.** Photos are stored on the server's disk (development only). The server refuses to start in staging/production without Azure Blob Storage, which is not implemented yet.
- **No cloud backups yet.** Nothing is deployed. Backup and recovery are planned with Azure (database point-in-time restore, blob soft-delete/versioning); not set up.
- **Real-iPhone testing is partial.** Done in Expo Go on one iPhone (iOS 26). Still to check on a device: notes after the fix, GPS, encryption speed on many large photos, upload while the app is in the background, and opening the app while still offline (Expo Go itself can't open without the PC connection, so this needs a standalone build). Photos did survive the app being fully closed and reopened. A standalone app build (not Expo Go) needs the paid Apple Developer account.
- **Demo photos have no picture.** The made-up sample photo records have no image file, so they show "File not uploaded yet" / "Waiting for file". Their notes now say so.
- **iPhone upload in the background is limited by iOS.** See `docs/IOS_SYNC.md`.
- **Removal wipe** happens when the phone next connects and loads Home. A phone that never connects again keeps its encrypted data, which needs the phone's passcode to read.
- **HEIC photos** are stored but have no preview (the app takes JPEG, so this only matters for future imports).
- No independent security review has been done.

## Decisions from JB (2026-11-21)

- **Home banner photo:** the crew member pictured has agreed, so the photo stays.
- **Logo:** keep the current logo file. The original high-resolution file may come later.
- **Employees sharing photos:** up to each company's owners. "Share or download photos" is its own permission checkbox in Team & roles (website and phone). It is on for Owner, Manager and Employee by default, and owners can switch it off for any role.
