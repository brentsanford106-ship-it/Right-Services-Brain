# Phase 1 status: photo management

Last updated: 2026-11-21. Phase 1 is **not complete**. The acceptance flow passes as an automated test, but it has not yet been run on a real iPhone, and real sign-in is not built.

## Acceptance flow

| Step | Automated test (real server + database, over HTTP) | On a real iPhone |
| --- | --- | --- |
| Create job | Passes | Not yet tested |
| Open camera | Not testable automatically (needs camera hardware) | Not yet tested |
| Take multiple photos without confirming | Passes (queue + encryption) | Not yet tested |
| Flag latest photo | Passes | Not yet tested |
| Review thumbnail | Passes (thumbnail decrypts for display) | Not yet tested |
| Add note | Passes | Not yet tested |
| Resume camera | UI only | Not yet tested |
| Capture offline | Passes (network switched off, app restarted while offline) | Not yet tested |
| Reconnect and synchronize | Passes (nothing lost, no duplicates, originals byte-identical) | Not yet tested |
| View photos on web | Passes (API) and web screen tests pass | Not yet tested in a real browser by you |
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
- Receipts, vehicles, and member admin routes are switched off (`PHASE2_FEATURES=false` by default).

## Test results (run 2026-11-21 in the cloud dev environment)

- Server: 182 of 182 pass (includes the end-to-end acceptance test).
- Offline queue and sync: 21 of 21 pass.
- Web: 5 of 5 pass.
- iPhone app: type check passes and the iOS bundle builds. There are no automated tests of the iPhone screens themselves.

## Simulated or not built yet

- **Sign-in is simulated.** You pick a test person; there are no passwords. Real sign-in (Microsoft Entra External ID) is not built. Blocks real data.
- **Cloud storage is not built.** Photos are stored on the server's disk (development only). The server refuses to start in staging/production without Azure Blob Storage, which is not implemented yet.
- **No cloud backups yet.** Nothing is deployed. Backup and recovery are planned with Azure (database point-in-time restore, blob soft-delete/versioning); not set up.
- **Not tested on a real iPhone.** Camera speed, encryption speed on large photos, GPS, and background upload behavior must be checked on a device.
- **iPhone upload in the background is limited by iOS.** See `docs/IOS_SYNC.md`.
- **Account revocation wipe** is triggered only when the server refuses to issue a token. Real-sign-in revocation is part of the real sign-in work.
- **HEIC photos** are stored but have no preview (the app takes JPEG, so this only matters for future imports).
- No independent security review has been done.
