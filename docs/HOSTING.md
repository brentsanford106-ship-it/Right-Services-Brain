# Hosting on Azure

Status (2026-11-22): **ready, not created.** Everything below is written and checked on our side. Nothing exists in Azure and nothing costs money until someone runs `infra/go-live.sh` and types `yes`.

## What gets created (all in East US 2, United States)

| Part | Azure service | About per month |
| --- | --- | --- |
| API server | App Service, Linux, B1 (always on) | $13 |
| Database | PostgreSQL Flexible Server, B1ms, 32 GB | $16 |
| Photos | Blob Storage, zone-redundant (3 copies in 3 buildings) | $1-3 at our size |
| Passwords | Key Vault | under $1 |
| Website | Static Web Apps, Free | $0 |
| Sign-in | Entra External ID (separate setup, docs/AUTHENTICATION.md) | $0 up to 50,000 people |
| **Total** | | **about $30-40** |

Prices are Microsoft's list prices as we understood them in November 2026. The Azure pricing calculator is the final word.

**Spending alert:** a $50 monthly budget emails the addresses you give at 50%, 80% and 100%, and when Azure forecasts going over. It warns; it does not switch anything off.

## Backups

- **Database:** automatic daily backups plus point-in-time restore to any minute in the last 14 days (Azure built-in).
- **Photos:** a deleted or overwritten photo can be recovered for 30 days (blob soft delete and versioning). This means "Delete forever" in the app removes a photo from the app at once, but Azure keeps a recoverable copy for 30 more days. Customers should be told this.
- **Not yet done:** a practice restore. It is on the go-live checklist below; backups don't count until a restore has worked once.

## Security set-up

- The API reaches photo storage with its own Azure identity. There are no storage keys anywhere, and key access is switched off on the account.
- The photo container is private. There are no public links and no share links: every photo goes through the API, which checks the person's company and permissions each time.
- Passwords are random, made by the script, stored only in Key Vault, and never shown to a person.
- GitHub deploys with a short-lived sign-in (OpenID Connect). No Azure password is stored in GitHub. That identity can only touch this one resource group.
- HTTPS only, TLS 1.2+, FTP off. The website sends strict security headers.
- The API refuses to start in production without real sign-in, Blob storage and an encrypted database connection, and it refuses the test sign-in.

**Known limits:**
- The database accepts connections from any Azure address (it still needs the password and TLS). A private network would close this, but it adds about $10-20 a month. This is worth considering before selling to other companies.
- Microsoft's built-in protections only: no separate firewall or intrusion detection.
- No independent security review yet. Required before real company data.

## Checked so far, and what isn't

| Item | Status |
| --- | --- |
| Photo storage code | Tested against Microsoft's official storage emulator (Azurite), including a full phone-upload-to-office-download run. Not yet against real Azure, where it signs in with managed identity. |
| API production build | Built and started from the single-file bundle with a real database. |
| Website production build | Builds. |
| `infra/main.bicep` | Written. Compiled by GitHub on each push (the "Checks" workflow). Never deployed. |
| `infra/go-live.sh` | Bash syntax checked. Never run. |
| Deploy workflow | Written. Never run. |

## Go-live checklist (one step at a time, with Claude)

Before you start: the Microsoft sign-in setup (docs/AUTHENTICATION.md) is done, and you've decided whose Azure account this is (see below).

1. **Azure account** exists, and you can sign in at portal.azure.com.
2. **Open Cloud Shell:** the `>_` button at the top of the Azure portal. Choose **Bash**.
3. **Get the code:** `git clone https://github.com/brentsanford106-ship-it/Right-Services-Brain.git && cd Right-Services-Brain`. It's a private repository, so GitHub will ask you to sign in; Claude will walk you through it.
4. **Create everything:** `bash infra/go-live.sh you@example.com`. Type `yes` when asked. It takes 5-15 minutes. Charges start here.
5. **Copy the values** it prints into GitHub: repository **Settings > Environments > New environment "production"**. Tick "Required reviewers", add yourself, then add each value under **Environment variables**.
6. **Add the sign-in IDs** (from the Microsoft setup) as variables too: `ENTRA_AUTHORITY`, `ENTRA_WEB_CLIENT_ID`, `ENTRA_API_SCOPE`. Then run the go-live script again with `OIDC_ISSUER=... OIDC_AUDIENCE=... OIDC_JWKS_URI=...` in front, so the API gets them.
7. **Deploy:** GitHub **Actions > Deploy > Run workflow**, then approve it.
8. **Create the company:** Claude walks you through `pnpm db:setup-company` against the new database, with your and Nate's email addresses.
9. **Sign in** on the website, then on the phone (the phone app needs `EXPO_PUBLIC_API_BASE_URL` set to the API address).
10. **Practice restore:** restore the database to a new server from 10 minutes ago, check it, then delete the copy.
11. **Security review** before real company photos go in.

## Whose account: Nate's company or yours

Choose before step 1. Both work technically. What changes is how easy it is to sell to other companies later.

**If it's under Nate's company:**
- Other companies' photos would sit in an account Nate's company pays for and controls. Most customers won't accept that, so you'd need to move everything to your own account first.
- Moving later is possible but not free. The Azure subscription can be transferred to another owner. Most resources can be moved between subscriptions, but the database move and the Key Vault have extra steps to verify.
- **Hardest to move: the sign-in tenant.** People's sign-in accounts live in the Entra tenant. A new tenant means everyone signs in fresh, and our database matches people by tenant and ID, so it would need a one-time re-link by email (a small script, not built).
- The GitHub repository is yours either way.

**If it's under your own account (or your own business):** Nate's company is simply your first customer. The company walls in the app already keep each company's data separate. You'd bill Nate, or not. This is the easier path if selling is likely.

Either way, keep at least two owners on the Azure account and the Entra tenant, so nobody gets locked out.
