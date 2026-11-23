# Photo collaboration: who took it, comments, markup, issues

JB's spec of 2026-11-23 adds visual collaboration and issue tracking to the Phase 1 photo module. The full review and decisions are in the plan doc: https://claude.ai/artifact/L6pJgX5Ppr32UenqVG3tay

It is built in six steps, each its own pull request, tested on a real iPhone before the next:

| Step | What | Status |
| --- | --- | --- |
| 1a | Who took it: photographer kept separate from uploader, initials on thumbnails, People filter (several people, Photos I took), sort, small gallery thumbnails | Built and tested automatically, **not yet tested on an iPhone** |
| 1b | Profile pictures, importing photos from the phone's library | Built and tested automatically, **not yet tested on an iPhone** |
| 2 | Comments and replies, @mentions, edit history, offline | Not started |
| 3 | Markup (circle, arrow, pen, box, text, pin), show/hide, zoom | Not started |
| 4 | Issues: assign, In Progress, follow-up photo, send for review, approve, send back, reopen, job Issues tab, To Fix list, employee Report issue | Not started |
| 5 | In-app alerts, per-person alert settings, offline polish, sharing an annotated copy | Not started |
| 6 | Company-wall tests for everything new, full acceptance run on iPhone and web | Not started |

JB's decisions (2026-11-23): in-app alerts first (lock-screen alerts after the paid Apple account and a real build); employees comment, reply and send fixes for approval but don't draw; employees can report issues (they go to the job's Issues list unassigned); every fix needs a manager's approval; keep In Progress, profile pictures, sort by photographer, alert settings and photo-library import.

## Step 1a: who took it

**How it works**

- `photos.photographer_membership_id`: who took the photo. Empty means unknown (used for imported photos later). `photos.capture_source`: `in_app_camera` (every photo today), `imported`, `web_upload`. Migration `0017_photo_attribution.sql`.
- The database fills in the photographer for in-app photos from the uploader, and refuses an in-app photo credited to anyone else. Who took it, who uploaded it and how it got here can never be changed afterwards (a trigger refuses it, even for the database owner).
- People are never deleted, only suspended or removed, so names stay on old photos.
- The API returns `photographerId`, `photographer`, `takenByMe`, `uploadedByMe` and `captureSource` with every photo. The phone can't choose who took a photo.
- New uploads get a small thumbnail (longest side 480 px, metadata removed) next to the preview, served with `?variant=thumb` behind the same checks as the photo. Photos uploaded before this fall back to the preview. Deleting a photo forever removes its thumbnail too.
- **Website:** initials circle on each thumbnail, a "Taken by" picker (Everyone, Photos I took, each person with a count, several at once), sort (newest, oldest, by who took it), and "Taken by", "Uploaded by" (when different) and "How" in the photo viewer. Filters combine with Before/During/After/Flagged.
- **Phone:** initials circle on each thumbnail, a row of people chips under the stage chips (shown when more than one person took photos on the job), a sort menu, "Taken by" on the photo screen. Photos still on the phone count as yours. Grids load the small thumbnail.

**Real vs simulated**

| Part | State |
| --- | --- |
| Database columns, rules and triggers | Real, tested against PostgreSQL |
| API fields, thumbnail creation, walls on thumbnails, purge removes thumbnails | Real, tested over HTTP (`apps/api/test/photo-attribution.test.ts`, 9 tests) |
| Website picker, sort, initials, viewer details | Real, tested in a simulated browser (`apps/web/src/App.test.tsx`) |
| Phone filter and sort logic | Real, tested (`packages/photo-sync/test/people.test.ts`) |
| Phone screens | Type-checked only. **Not yet tried on an iPhone.** |
| Paging the gallery for jobs with thousands of photos | Not built yet. A job still loads all its photos at once (fine to a few hundred). |
| Sign-in, hosting, backups | Still simulated or not built, as in PHASE1_STATUS.md. Nothing here is secure or production-ready yet. |

## Step 1b: profile pictures and photos from the library

**Profile pictures**

- One small picture per person per company, stored on their membership (migration `0018_avatars_and_imports.sql`) at `org/<company>/avatars/<membership>`.
- The uploaded file is never kept: the server shrinks it to 256 x 256 and re-encodes it, which also removes any location or other details inside it.
- Anyone in the company can see the pictures (they already see names on photos). Only the person can change their own. People who can manage the team can remove someone's picture. Every change and removal is audited.
- Shown instead of initials on thumbnails, in the People lists, in the photo viewer, and in Settings. Phone: Settings, then "Add a profile picture" (take a selfie or choose from the library). Website: Settings, then "Your profile picture".
- Pictures are kept in memory only, never saved to disk on the phone or computer, and are forgotten on sign-out on the website.

**Photos from the phone's library**

- Phone: the **Library** button next to **Take Photos** on a job. Choose the stage, then pick up to 30 photos.
- They're saved encrypted and uploaded like camera photos, but marked `imported`. Who took them is stored as unknown, because the app can't know. The person who added them is recorded as the uploader.
- The date comes from the photo's own "date taken" when it has one. When it doesn't, the photo shows "Taken: unknown (added ...)" (`captured_at_known = false`).
- No location is attached. The phone's current location says nothing about where an older photo was taken.
- iPhone photos are usually HEIC. The app asks iOS for a JPEG copy, so the stored "original" of an imported photo is that JPEG copy, not the HEIC file in the library.
- New permission **photos.import**, "Add photos from the phone's photo library". It's on for Owner, Manager and Employee by default, and an owner can switch it off per role in Team & Roles.
- The photo picker's temporary copies are deleted right after each photo is saved, and again at every app start and sign-out.

**Real vs simulated**

| Part | State |
| --- | --- |
| Profile picture storage, shrinking, walls, who may change or remove, audit | Real, tested over HTTP (`apps/api/test/avatars-and-imports.test.ts`) |
| Imported photos: unknown photographer, unknown date, permission switch | Real, tested over HTTP |
| Phone queue sends imported photos correctly and keeps the marker after a restart | Real, tested (`packages/photo-sync/test/sync.test.ts`) |
| Reading "date taken" from photo details | Real, tested (`packages/photo-sync/test/exif.test.ts`) |
| Website profile picture in Settings and on thumbnails | Real, tested in a simulated browser |
| Phone screens (Library button, profile picture, pictures on thumbnails) | Type-checked and the iPhone app bundle builds. **Not yet tried on an iPhone.** |
