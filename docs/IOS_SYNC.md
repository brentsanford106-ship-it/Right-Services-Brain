# How photo upload actually works on iPhone

Short version: **photos upload while the app is open.** The app does not promise to upload while it is closed, because iOS does not allow that reliably.

## What the app does

1. When you take a photo, it is encrypted and saved on the phone **before** anything else happens. From that moment it cannot be lost by a bad connection.
2. The app then tries to upload. It also tries:
   - right after each photo,
   - when the phone's connection comes back,
   - when you return to the app,
   - every 60 seconds while the app is on screen,
   - when you tap **Upload now**.
3. Each photo goes through three steps (details, image file, later flag/note changes). Every step can be repeated safely, so a dropped connection in the middle only means that step is tried again. The server recognizes a repeat and does not create a duplicate.
4. If the server is busy or the connection is bad, the app waits and tries again (15 s, 30 s, 1 min, ... up to 30 min between tries).
5. If the server refuses a photo for a reason retrying won't fix (for example, you were removed from the job), the photo is marked **Needs attention** and kept. You choose **Try again** or **Delete**.
6. After the server confirms it has the full-size photo, the phone deletes its own full-size copy and keeps a small thumbnail for 7 days.

## What iOS allows

| Situation | What happens |
| --- | --- |
| App open on screen | Uploads run normally. |
| You switch to another app or lock the phone | An image upload that has **already started** is handed to iOS and usually finishes. New uploads do **not** start until you open the app again. |
| You swipe the app away (force-quit) | iOS stops everything. Photos stay safe on the phone and upload the next time you open the app with a connection. |
| Phone restarts | Same as above. |
| No signal for hours or days | Photos wait on the phone, encrypted. Storage space is the only limit. |

The app does not use iOS "background fetch". Apple decides when (and whether) it runs, often only overnight on a charger, and it can't be relied on. If testing on real phones shows crews need it, it can be added later as a bonus, not as the main path.

## What crews should do

- Open the app at the end of the day with Wi-Fi or signal and wait until it says **All photos uploaded**.
- Don't sign out while photos are waiting. The app warns you, because signing out deletes them.

## Not verified yet

All of the above is the design and has passed automated tests in Node. It still has to be checked on a real iPhone: background hand-off of an in-progress upload, timing on large photos, and behavior on weak signal.
