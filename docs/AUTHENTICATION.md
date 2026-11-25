# Sign-in

## Decision

**Microsoft Entra External ID (external tenant)**, chosen by JB on 2026-11-21. The code for real sign-in is built and tested here (2026-11-21). It is **not switched on** yet, because no Entra tenant exists. Until one does, the app shows only the development sign-in.

## How it works for people

1. An owner opens **Team & roles** (website, or phone Settings > Team & Roles) and taps **Add person**: name, email, job title, roles.
2. We don't send an email. The owner tells the person to open the app and tap **Sign in**.
3. Microsoft's own sign-in page opens. The person types their email. Microsoft emails them a one-time code. They type the code. **No password and no Microsoft account needed.**
4. Our server checks the token from Microsoft. If the email matches someone an owner added, the person is linked to that company with those roles, and the invite is used up. If not, they see "You haven't been added to a company yet. Ask an owner to add your email address." and get no access.
5. Someone already signed in who is added to a second company gets it the next time the app loads their account (opening the Home screen, or signing in).

**Removing and suspending.** Owners can **Suspend** (temporary), **Restore**, or **Remove** a person. Access stops on the server at once. The next time that person's phone connects, it deletes the company's photos and lists from the phone and destroys its encryption key, including photos it hasn't uploaded yet. To bring a removed person back, add them again; they get only the new roles.

**Rules the server enforces** (tested): only people with "Add people by email, and suspend or remove people" (owners by default) can do this. You can't add someone with a role stronger than your own, and you can't suspend or remove someone with permissions you don't have. A company always keeps an active owner. Everything is audited, without copying email addresses into the audit log.

## Setting up the real company (first owners)

Nobody is in a new company yet, so nobody can add the first owners from the app. The setup tool does it, once per database:

```
pnpm db:setup-company --name "Right Services" --owner "nate@example.com:Nate" --owner "jb@example.com:JB"
```

It creates the company with the Owner, Manager and Employee roles and adds each email as an Owner (shown as "added by Company setup"). Each owner gets in by signing in with Microsoft using that email. If a company with a matching name already exists, it stops and changes nothing, so a new customer's owners can never end up inside another company. To add more owners to an existing company on purpose, add `--add-to-existing` (running that again doesn't duplicate anything). It needs the database admin connection, so only someone with the admin password can run it. Tested in `apps/api/test/setup-company.test.ts`.

## Technical summary

| Part | What it does | Where |
| --- | --- | --- |
| Server token check | Checks signature (Microsoft's published keys), issuer, audience, expiry. Only RS256/PS256/ES256. If Microsoft's key list can't be reached, the answer is a temporary error, never "signed out". | `apps/api/src/auth/oidc.ts` |
| Linking on first sign-in | `app.claim_invites()` in the database: makes the account, membership and roles from open invites for the verified email. A disabled account never comes back through an invite. | `packages/db/migrations/0011_member_invites.sql` |
| Add / withdraw / suspend / remove | `/v1/orgs/:orgId/team/invites`, `/team/members/:id/status` | `apps/api/src/routes/team.ts` |
| Phone | Authorization code + PKCE in the system browser sheet (`expo-auth-session`). Refresh token in the iOS Keychain, this device only. Access token in memory only. | `apps/mobile/src/entra.ts`, `src/state.tsx` |
| Website | Authorization code + PKCE, written by us (about 100 lines, no extra library). Tokens in memory only; reloading the page means signing in again, usually one click because Microsoft remembers the browser. | `apps/web/src/lib/entra.ts` |

**"Sign in again" owner setting** (website and phone Settings; owners only; every 1, 7, 14, 30 (default), 60 or 90 days; tested). The phone checks it only right after Microsoft has answered, which means it has signal. So taking photos without service is never interrupted: an overdue person keeps working offline, and is sent to the sign-in screen the next time they have signal, with unsent photos kept. This rule is enforced by the apps, not the server: someone who copied a token out of a phone could use it until Microsoft's own limits stop it. The server-side protections that matter (removing people takes effect at once) don't depend on it. On the website, closing the page always signs out, and a sign-in is never renewed past one day.

**Sign-in expiry on the phone.** If Microsoft's refresh token runs out or is revoked, the phone goes back to the sign-in screen and **keeps** unsent photos (encrypted). They upload after the same person signs in again. Only removal/suspension (or Sign out) wipes the phone.

**Tests** (all pass, 2026-11-21): `apps/api/test/member-invites.test.ts` (10), `apps/api/test/oidc-verifier.test.ts` (4: the real token checker against a stand-in identity provider on this computer, including forged, wrong-audience, wrong-issuer, expired, unsigned and "alg none" tokens, and the full add-then-sign-in path), `apps/web/src/entra.test.tsx` (3).

**Not tested yet, needs a real Entra tenant:**
- Signing in against Microsoft for real, on the website and on the iPhone.
- Whether Entra accepts Expo Go's `exp://…/--/auth` return address. If not, a small return page on the website will forward to the app.
- That the access token carries the `email` claim. It must be added as an optional claim on the API app registration (step 6 below).

## Settings (none of these are secret)

| Where | Setting | Example |
| --- | --- | --- |
| Server | `OIDC_ISSUER` | `https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0` |
| Server | `OIDC_AUDIENCE` | the API app's Application (client) ID |
| Server | `OIDC_JWKS_URI` | `https://<subdomain>.ciamlogin.com/<tenant-id>/discovery/v2.0/keys` |
| Website | `VITE_ENTRA_AUTHORITY`, `VITE_ENTRA_CLIENT_ID`, `VITE_ENTRA_API_SCOPE` | `https://<subdomain>.ciamlogin.com/<tenant-id>/v2.0`, web app client ID, `api://<api-client-id>/access_as_user` |
| Phone | `EXPO_PUBLIC_ENTRA_AUTHORITY`, `EXPO_PUBLIC_ENTRA_CLIENT_ID`, `EXPO_PUBLIC_ENTRA_API_SCOPE` | same pattern, phone app client ID |

The exact issuer value is confirmed from the tenant's `/.well-known/openid-configuration` during setup, not guessed.

## Setup in Microsoft (free; needs JB's go-ahead first)

An Entra External ID tenant is free up to 50,000 monthly users, but Microsoft requires an Azure account (subscription) to create one. Creating that account asks for a card. Nothing in these steps costs money. Do not turn on SMS.

1. Sign in to https://entra.microsoft.com with the account that will own this (ideally the company's, decided with Nate).
2. Create an **external tenant** (Microsoft Entra External ID). Region: United States.
3. **Sign-in method:** "Email with one-time passcode". **Leave Microsoft's self-service sign-up on** (recommended). Why: with sign-up on, a stranger can make a Microsoft-side login in our tenant, but our server still refuses them (no company, no data; tested). Turning sign-up off is possible, but only through Microsoft Graph (`PATCH /beta/identity/authenticationEventsFlows/{id}` with `isSignUpAllowed: false`, see https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-disable-sign-up-user-flow), and then nobody new can sign in until their Microsoft login is created for them: either by hand in the Entra admin center for each person, or by our server through Microsoft Graph, which would need a server secret with permission to create users (not built).
4. **App registration 1, "RSB API":** Expose an API, scope `access_as_user`. Note its Application (client) ID.
5. **App registration 2, "RSB Website":** platform "Single-page application", redirect `http://localhost:5173/auth` (later also the real website address + `/auth`). API permission: RSB API `access_as_user`.
6. **App registration 3, "RSB Phone":** platform "Mobile and desktop", redirect the address the phone shows (Expo Go: `exp://<pc-address>:8081/--/auth`). API permission: RSB API `access_as_user`. On RSB API, add optional claim `email` to the access token.
7. Copy the IDs into `.env` on the PC (the table above): server and website values in the main `.env`, phone values in `apps/mobile/.env` (Expo reads that folder). No passwords or secrets are involved: these are public IDs.
