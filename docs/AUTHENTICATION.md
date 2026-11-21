# Sign-in plan

## Decision

**Microsoft Entra External ID (external tenant)**, chosen by JB on 2026-11-21. Not built yet; the app currently uses a development stand-in.

## Why it fits

| Need | How Entra External ID handles it |
| --- | --- |
| Employees **without** a Microsoft account | Sign up / sign in with email + password, or a one-time code sent by email. No Microsoft account needed. |
| Employees who **do** have a work Microsoft account | Can be allowed to sign in with it (federation), through Microsoft's hosted sign-in page. |
| Owners, managers, employees across **several companies** | One sign-in identity per person. Company membership and role live in our database, not in Entra, so one person can belong to two companies with different roles (already supported and tested). |
| Public App Store app | iPhone uses the system browser sign-in with PKCE (the standard for mobile apps). |
| Cost (< $100/month budget) | Free up to 50,000 monthly active users. SMS codes cost extra, so we use email codes, authenticator apps or passkeys for extra verification. |

Checked on 2026-11-21: Entra's own invitation feature is in preview, so **our server sends and tracks invitations** and links the person when they first sign in.

Fallback if Entra doesn't work out: Auth0. The server already accepts any standard OpenID Connect provider, so switching is mostly configuration.

## What exists today

- The server verifies standard OpenID Connect tokens (issuer, audience, signature, expiry) and maps each person to an active account in our database. Disabled accounts and suspended memberships are refused (tested).
- The development stand-in issues 15-minute test tokens. It only works when `APP_ENV` is development/test **and** `DEV_AUTH_ENABLED=true`; the server refuses to start otherwise.

## Still to build

Entra tenant and app registrations (needs JB's approval to create), iPhone sign-in screen with PKCE, web sign-in, token refresh, invitation flow, and server-side revocation.
