# Photo collaboration: who took it, comments, markup, issues

JB's spec of 2026-11-23 adds visual collaboration and issue tracking to the Phase 1 photo module. The full review and decisions are in the plan doc: https://claude.ai/artifact/L6pJgX5Ppr32UenqVG3tay

It is built in six steps, each its own pull request, tested on a real iPhone before the next:

| Step | What | Status |
| --- | --- | --- |
| 1a | Who took it: photographer kept separate from uploader, initials on thumbnails, People filter (several people, Photos I took), sort, small gallery thumbnails | Built and tested automatically, **not yet tested on an iPhone** |
| 1b | Profile pictures, importing photos from the phone's library | Built and tested automatically, **not yet tested on an iPhone** |
| 2 | Comments and replies, @mentions, edit history, offline | Built and tested automatically, **not yet tested on an iPhone** |
| 3 | Markup (circle, arrow, pen, box, text, pin), show/hide, zoom | Built and tested automatically, **not yet tested on an iPhone** |
| 4 | Issues: assign, In Progress, follow-up photo, send for review, approve, send back, reopen, job Issues tab, To Fix list, employee Report issue | Built and tested automatically, **not yet tested on an iPhone** |
| 5 | In-app alerts, per-person alert settings, offline polish, sharing an annotated copy | 5a alerts and settings: built and tested automatically, **not yet tested on an iPhone**. 5b offline drawings and issue changes: built and tested automatically, **not yet tested on an iPhone**. 5c sharing a marked-up copy: built and tested automatically, **not yet tested on an iPhone** |
| 6 | Company-wall tests for everything new, full acceptance run on iPhone and web | Wall and permission tests done for everything new (see SECURITY.md). **The iPhone and website acceptance run is JB's test guide (Parts 0–10).** |

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

## Step 2: comments and replies

**How it works**

- Tables `photo_comments`, `photo_comment_revisions` and `photo_comment_mentions` (migration `0019_photo_comments.sql`), behind the same company walls as photos.
- Anyone who can see a photo (through its job) can read its comments. Writing needs **photo_comments.create** ("Comment on photos and reply to comments"), on for Owner, Manager and Employee by default.
- Replies are one level deep and always on the same photo. The database refuses anything else.
- **@mentions:** only people who can see the job (everyone with "see every job", plus people assigned to it). Suspended and removed people can't be mentioned. Mentions are recorded now. Alerts for them come in step 5.
- **Editing:** only the person who wrote a comment. Every earlier wording is kept in `photo_comment_revisions`, written by the database itself, and the comment shows "edited". A mention added while editing is recorded. A mention removed while editing stays recorded, because mentions are add-only.
- **Deleting:** people delete their own. **photo_comments.moderate** (Owner by default) lets someone delete anyone's comment. A deleted comment shows "Comment deleted by ..." and its wording is hidden, but the wording stays in the database for the record.
- Who wrote a comment, which photo it is on and what it replies to can't be changed: the app's database login may only change the wording and the edited/deleted markers.
- The activity log records each comment added, edited and deleted (who, which photo, by a moderator or not), but never the wording.
- "Delete forever" of a photo also removes its comments, earlier wordings and mentions.
- Photos now carry `commentCount` and `lastCommentAt`.
- **Website:** 💬 count on thumbnails, a **💬 Comments** filter chip, and a Comments section in the photo viewer (reply, edit, delete, "@ Mention…" picker).
- **Phone:** 💬 count on thumbnails, a **💬 Comments** filter chip, and a Comments section on the photo screen (reply, edit, delete, "@ Mention" chips).
- **Offline on the phone:** new comments and replies are saved encrypted on the phone and sent by the sync queue, with a phone-made id so a resend never makes a second copy. A comment on a photo that hasn't uploaded yet waits for the photo. A reply to a waiting comment waits for it. If the server refuses one (for example, the photo was deleted), it stays on the phone marked "not sent" with **Try again** and **Discard**. It is never dropped silently. The last comments seen are kept (encrypted) so they can be read without signal. Editing and deleting need a connection.
- Waiting comments are protected like waiting photos: another person can't sign in on that phone until they're sent, and a suspended person's waiting comments are kept locked on the phone.

**Real vs simulated**

| Part | State |
| --- | --- |
| Tables, walls, one-level replies, edit history, locked authorship, purge | Real, tested against PostgreSQL |
| API: add, reply, mentions, edit, delete, moderation, permission switch, walls | Real, tested over HTTP (`apps/api/test/photo-comments.test.ts`, 9 tests) |
| Website comments panel, filter and badge | Real, tested in a simulated browser (`apps/web/src/App.test.tsx`) |
| Phone offline comment queue (encrypted, restart-safe, resend-safe, waits for photo or parent) | Real, tested (`packages/photo-sync/test/comments.test.ts`, 7 tests) |
| Phone screens (comments section, filter, badge) | Type-checked and the iPhone app bundle builds. **Not yet tried on an iPhone.** |
| Alerts when someone mentions you or replies | Not built yet (step 5). |
| Comments on a markup shape | Comes with markup (step 3). |

## Step 3: drawing on photos

**How it works**

- Table `photo_markups` (migration `0020_photo_markups.sql`). Each mark is one row of shape data:
  - its kind: circle, arrow, pen line, box, text or numbered pin
  - its color: red (the default), yellow, green, blue, white or black
  - its size: thin, medium or thick
  - its points, as fractions (0 to 1) of the upright photo
  - its words, for text and pins

  **The photo file is never touched.** A test checks the stored original is byte-for-byte the same after drawing.
- **Who draws:** **photo_markups.create** ("Draw on photos"), on for Owner and Manager. Employees see drawings and comment on them but don't draw (JB's decision). An owner can switch drawing on for any role in Team & Roles.
- **Removing marks:** people remove their own. **photo_markups.manage** (Owner by default) removes anyone's.
- **Saved marks never change.** A mark can only be removed. Removed marks stay in the database (hidden) with who removed them and when. Editing is done by removing a mark and drawing a new one. The app's database login can only set the "removed" markers.
- **Saving:** each mark is saved the moment it's drawn (JB, 2026-11-23: drawings were lost when the viewer was closed without pressing Save). There is no Save button; **Done** closes the tools, and **Undo** removes the last mark you made (on the server too). Each new mark carries its own id, so a resend never saves it twice, and the server's answer says which saved mark it became (`added`). A photo can have up to 500 marks.
- **Note after drawing:** right after a mark is saved, a note box opens beside it ("What should be done here?"), with **Add note**, **No note** and **Remove drawing**. The note is posted as a normal comment about that mark, so it shows in Comments as "📍 About the red circle" and whoever took the photo gets an alert. Drawing the next mark closes the box without a note.
- **Comments on a mark:** tap or click a drawing to select it, and the next comment is "about the red circle". Comments about a mark show "📍 About the red circle", and tapping that highlights the mark. The mark must be on the same photo, which the database checks.
- **Website:** in the photo viewer:
  - **✎ Draw** (for people who can draw) and **Hide drawings / Show drawings**.
  - Zoom **−**, **100%** and **+**. You move around a zoomed photo with the scroll bars.
  - The drawing tools: circle, arrow, pen, box, text, pin and remove. Six colors, three sizes, **Undo** and **Done**. The note box pops up next to each new drawing; Enter adds the note.
  - Arrow keys don't change photo while you are drawing.
- **Phone:** on the photo screen:
  - Drawings show over the photo, with **Hide drawings / Show drawings**. Tapping a drawing selects it to comment on.
  - **✎ Draw** opens a drawing screen with the same tools, colors, sizes and Undo. **Zoom** goes 1×, 2× or 3×, and **✋** moves around a zoomed photo.
  - After each drawing, the note box replaces the tools until you add a note, tap No note, or start drawing again. **Done** (top left or bottom) goes back.
- **Offline:** marks already seen are kept (encrypted) and show without signal. On the phone, a mark drawn with no signal waits in the encrypted offline outbox and is sent automatically later; its note waits in the comment outbox and says which mark it's about in words ("About the red circle: …"), because the mark has no id yet.
- "Delete forever" of a photo also removes its marks.
- The same drawing code is used on the website and the phone (`packages/photo-sync/src/markup.ts`). It can also produce an SVG of all marks, which step 5 uses for "share an annotated copy".

**Real vs simulated**

| Part | State |
| --- | --- |
| Table, walls, locked marks, removal kept for the record, purge, comment-on-mark link | Real, tested against PostgreSQL |
| API: save, resend-safe, removal rules, permission switch, validation, walls, photo unchanged | Real, tested over HTTP (`apps/api/test/photo-markups.test.ts`, 9 tests) |
| Drawing math, undo/redo, tap-to-select, safe SVG | Real, tested (`packages/photo-sync/test/markup.test.ts`, 7 tests) |
| Website drawing, hide/show, comment on a mark | Real, tested in a simulated browser (`apps/web/src/App.test.tsx`). Not yet tried in a real browser by JB. |
| Phone drawing screen and drawings on the photo screen | Type-checked and the iPhone app bundle builds. **Not yet tried on an iPhone.** Touch drawing while zoomed is the part most likely to need adjusting. |
| Saving drawings with no signal | Built in step 5b (see below). |

## Step 4: issues to fix

**How it works**

- Tables `photo_issues` and `photo_issue_events` (migration `0021_photo_issues.sql`).
  - An issue belongs to one photo and its job. It can point at a mark on that photo ("the red circle"). The database checks the photo is on the job and the mark is on the photo.
  - Each issue has a title, optional details, a status, who it's assigned to, who reported it, who sent the fix and who approved it.
  - `photo_issue_events` is the history. Rows are only ever added: who did what, when, the note, and the status before and after. The app's database login can't change or delete them.
- **Statuses:** Open, In progress, Waiting for review, Fixed. The database itself only allows these moves:
  - Open to In progress (the assignee taps **Start**), or Open / In progress to Waiting for review (the assignee **sends a fix**).
  - Waiting for review to Fixed (**Approve**) or back to Open (**Send back**, which needs a note saying what still needs fixing). The list shows "Sent back".
  - Fixed back to Open (**Reopen**).
  - Giving it to someone else moves "In progress" back to Open, so the new person starts fresh.
- **Who does what:**
  - **photo_issues.create** ("Report issues"): on for everyone. Employees use **🔧 Report issue** on a photo. Their reports aren't assigned to anyone and wait in the job's Issues list for a manager (JB's decision).
  - **photo_issues.manage** ("Assign and approve issues"): Owner and Manager. They assign, approve, send back, reopen and edit.
  - Only the person it's assigned to can start it or send a fix. Sending a fix also needs "Upload photos".
  - **Nobody approves their own fix.** The one exception is an issue a manager reported, assigned to themselves and fixed (JB's decision).
  - The person who reported an issue can fix its wording until it's assigned.
- **Fix photos:** when sending a fix, you can choose photos from the same job (for example, the "After" photo of the repair). The server checks they're on the same job and that you can see them.
- **Safe when two people act at once:** every change says what status the person saw. If someone else changed the issue first, nothing happens and the app says *"This issue changed while you were away: it is now …"*. The same tap sent twice is only applied once.
- **Photos with issue history are kept.** "Delete forever" and the automatic clean-out skip a photo that has issues, so the record of what was fixed stays. Deleting it normally (Recently Deleted) still works. The issue then shows "The photo was deleted".
- **Website:**
  - Photo viewer: a **To fix** section with **🔧 Report issue** (about the selected mark, if one is selected) and the buttons each person may use. It also has a **History** list.
  - Gallery: **🔧 To fix** filter and a 🔧 count on thumbnails.
  - Job page: **Issues to fix**, grouped as Waiting for review, Not assigned yet, Being fixed, and Fixed (folded away). **Open the photo** jumps to it.
  - Overview: **🔧 Assigned to me** and, for managers, **Fixes waiting for review**.
- **Phone:**
  - Photo screen: the same **To fix** section with Report issue, Start, Send fix for review (choose fix photos), Approve, Send back, Reopen, Assign and History.
  - Gallery: **🔧 To fix** filter, 🔧 count on thumbnails, and a **🔧 Issues** link to the job's Issues list.
  - Home: a **🔧 … to fix · … waiting for your review** bar when you have any. It opens the To fix list.
- **Offline:** the last issues seen are kept (encrypted) and show without signal. **Reporting and changing an issue need a connection for now.** If it fails, what you typed stays on screen. Doing these offline is planned with step 5.
- Every change is in the activity log (`photo_issue.assign`, `.submit`, `.approve` …).

**Real vs simulated**

| Part | State |
| --- | --- |
| Tables, walls, allowed status moves, locked history, kept photos | Real, tested against PostgreSQL |
| API: report, assign, start, submit with fix photos, approve, send back, reopen, edit, no self-approval, conflicts, resend-safe, walls | Real, tested over HTTP (`apps/api/test/photo-issues.test.ts`, 9 tests) |
| Status words and grouping (shared by website and phone) | Real, tested (`packages/photo-sync/test/issues.test.ts`) |
| Website issues in the viewer, job list, Overview, filter and badge | Real, tested in a simulated browser (`apps/web/src/App.test.tsx`). Not yet tried in a real browser by JB. |
| Phone screens (photo screen section, Issues list, To fix on Home, filter, badge) | Type-checked and the iPhone app bundle builds. **Not yet tried on an iPhone.** |
| Alerts when something is assigned to you, sent for review, approved or sent back | Not built yet (step 5). |
| Reporting and changing issues with no signal | Built in step 5b (see below). |

## Step 5a: in-app alerts and alert settings

**How it works**

- Table `notifications` (migration `0022_notifications.sql`): one row per alert per person. The server writes them as part of the action itself:

  | Alert | Who gets it |
  | --- | --- |
  | Someone @mentions you | The people mentioned |
  | Someone replies to your comment | Whoever wrote the comment (unless they were also @mentioned, so they get one alert, not two) |
  | Someone comments on a photo you took | Whoever took the photo |
  | An issue is assigned to you | The new assignee |
  | Someone reports an issue nobody is assigned to | The managers on the job (people with "Assign and approve issues" who can see it) |
  | A fix is waiting for review | The managers on the job |
  | Your fix is approved / sent back | The assignee and whoever sent the fix |
  | An issue is reopened | The assignee |

- **Never about your own action**, and only for people who can see the job (the database also refuses an alert to yourself). Alerts are re-checked every time they're read. Someone taken off a job stops seeing its alerts, and alerts about a deleted photo are hidden. "Delete forever" removes them.
- **Only your own.** Nobody can read or mark someone else's alerts. The app's database login can only add alerts and mark them read.
- **Alert settings** (`notification_preferences`): each person switches kinds on or off for themselves. The two manager-only kinds are shown only to managers. Switched-off alerts are never created.
- **Website:** a 🔔 in the top bar with the number of new alerts, checked every minute. Clicking an alert marks it read and opens the photo. There is also **Mark all read**. **Settings → Alerts** has the switches.
- **Phone:** a **🔔 Alerts** bar on Home (with the number of new ones). It opens the Alerts list, and tapping one opens the photo. **Settings → Alerts** has the switches. The last list seen is kept (encrypted) for reading without signal.
- **Not built:** phone notifications when the app is closed (push). These need the paid Apple account and a real App Store build. Alerts for new @mentions added while editing a comment are not sent either (only the first version's mentions are).

**Real vs simulated**

| Part | State |
| --- | --- |
| Table, walls, add-only, "not to yourself", cascade on delete forever | Real, tested against PostgreSQL |
| Who gets each alert, settings, marking read, hidden for deleted photos, other companies | Real, tested over HTTP (`apps/api/test/notifications.test.ts`, 5 tests) |
| Alert sentences and setting labels (shared by website and phone) | Real, tested (`packages/photo-sync/test/alerts.test.ts`) |
| Website bell and settings | Real, tested in a simulated browser (`apps/web/src/App.test.tsx`) |
| Phone Alerts screen, Home bar, settings switches | Type-checked and the iPhone app bundle builds. **Not yet tried on an iPhone.** |
| Push notifications when the app is closed | Not built (needs the Apple account and an App Store build). |

## Step 5b: drawings and issue changes with no signal (phone)

**How it works**

- When a new drawing, a removed drawing, Report issue, or an issue button (Start, Send fix, Approve, Send back, Reopen, Assign) can't reach the server, the phone keeps the change in an **encrypted offline outbox** (`packages/photo-sync/src/actions.ts`, files `pa-…` in the same encrypted store as photos). It's sent automatically by the same upload run as photos and comments, after them, in the order it was made.
- Each change keeps its phone-made ids (`clientRef`), so if the signal drops mid-send and it's sent again, the server applies it once.
- **Conflict safety:** every issue change carries the status the person saw. If someone changed the issue first (for example, a manager approved it while the phone had no signal), the server changes **nothing** and answers *"This issue changed while you were away: it is now …"*. The phone keeps that change with the reason, shown on the issue with **Try again** and **Discard**. Changes to the same issue (or drawings on the same photo) never overtake each other.
- A drawing waiting to be sent shows on the photo (marked "⏳ waiting for signal"). Removed marks are hidden. Drawing again on that photo waits until it's sent. A waiting mark can't be commented on until it's on the server.
- Drawing with no signal works when the photo's drawings were seen before (the copy saved on the phone). Otherwise the screen asks to open the photo once with signal.
- Like photos and comments: unsent changes stop another person signing in on this phone, and they're kept (locked) if the person's access is turned off. The **Uploads** screen lists how many comments and drawing or issue changes are waiting.
- Nothing waiting is ever thrown away without the person tapping **Discard**.
- The website always works online, so it needs none of this.

**Real vs simulated**

| Part | State |
| --- | --- |
| Offline outbox: encrypted, restart-safe, in order, resend-safe, conflict kept with reason, busy server retried, blocks another sign-in | Real, tested (`packages/photo-sync/test/actions.test.ts`, 4 tests) |
| Waiting drawings shown on the photo | Real logic, tested (`packages/photo-sync/test/markup.test.ts`) |
| Server side (resend-safe adds, removals, issue `expectedStatus` check) | Real, tested over HTTP (step 3 and step 4 tests) |
| Phone screens (Saved on this phone, waiting notes, Try again / Discard, Uploads count) | Type-checked and the iPhone app bundle builds. **Not yet tried on an iPhone** (needs a real build with Airplane Mode). |

## Step 5c: sharing a copy with the drawings on it

**How it works**

- `GET /photos/:id/content?variant=annotated` makes a fresh JPEG: the display copy with the current drawings burned in, using the same drawing code as the screens (`marksToSvg`). It's **made on request and never stored**. The stored photo and original never change (a test checks the original byte for byte). Location and other photo details are not in the copy.
- It needs **"Share or download photos"** (photos.export) and the usual job access. Every copy is recorded in the activity log as `photo.exported` with `channel: "annotated_copy"` and the number of marks.
- **Website:** **Download with drawings** in the photo viewer (when the photo has drawings).
- **Phone:** **Share** on a photo with drawings asks **With drawings** or **Photo only**, then opens the iPhone share sheet. The temporary file is deleted right after, as for normal sharing.
- Words in text marks are drawn with the server's fonts. On the Azure server these may look slightly different from the app until a font is added to the server image (to check when hosting is set up).

**Real vs simulated**

| Part | State |
| --- | --- |
| Marked-up copy: drawings in the right place, same size, no metadata, audited, permission switch, walls, photo unchanged | Real, tested over HTTP (`apps/api/test/photo-markups.test.ts`) |
| Website button | Real, tested in a simulated browser |
| Phone "With drawings" share | Type-checked and the iPhone app bundle builds. **Not yet tried on an iPhone.** |

## Step 6: walls and security for everything new

- Every new table is in the database wall tests (forced row-level security and exact grants), and each feature's HTTP tests include another company, people not on the job, and switching the permission off. The summary is in `docs/SECURITY.md` ("Photo collaboration").
- Found and fixed in this pass: someone whose role can't see any jobs got an error on every page from the alert check. They now simply have no alerts (tested).
- Still to do: JB's run of the test guide on a real iPhone and in a browser (Parts 0–10). Push notifications when the app is closed need the Apple account. Gallery paging for very large jobs is still not built.

