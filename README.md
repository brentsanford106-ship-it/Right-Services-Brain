# Right Services Brain

A job-site photo app for field crews (iPhone/iPad) and the office (web), built on a secure multi-company base.

> **Development build.** Synthetic (made-up) data only. Sign-in is a development stand-in and is **not secure yet**.
> Do not put real company information into it. See [docs/PHASE1_STATUS.md](docs/PHASE1_STATUS.md) for what is finished, what is only tested automatically, and what is still simulated.

## What's in here

| Folder | What it is |
| --- | --- |
| `apps/mobile` | iPhone/iPad app (Expo + React Native): jobs, continuous camera, photo review, flags, notes, offline upload queue |
| `apps/web` | Office web app (React): job search, photo galleries, full-screen viewer, flags, notes, photo search |
| `apps/api` | Server (Node + Fastify): sign-in checks, company separation, photo storage |
| `packages/photo-sync` | The phone's encrypted offline queue and upload logic (shared, tested on its own) |
| `packages/db` | Database setup scripts (PostgreSQL) and made-up test data |
| `packages/contracts` | Shared definitions of what the app and server send each other |
| `docs/` | Status, security, iPhone upload behavior, sign-in plan |

---

## Running it on your Windows PC (step by step)

You already installed Node 24, pnpm, Git and Docker Desktop on this PC. These steps use **PowerShell** (press the Windows key, type `PowerShell`, press Enter).

### One-time setup

1. **Start Docker Desktop.** Open it from the Start menu and wait until the whale icon at the bottom-left says "Engine running". Docker runs the database in a sealed-off box.
2. **Pick a folder and download the code.** In PowerShell:
   ```powershell
   cd $HOME\Documents
   git clone https://github.com/brentsanford106-ship-it/Right-Services-Brain.git
   cd Right-Services-Brain
   git checkout phase1-foundation
   ```
   If a GitHub sign-in window pops up, sign in. That lets Git download your private repository.
3. **Install the project's libraries** (takes a few minutes the first time):
   ```powershell
   pnpm install
   ```
4. **Create your settings file.** This copies the example file to a private `.env` file that is never uploaded to GitHub:
   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```
   In Notepad, replace both `change-me-local-admin-password` (it appears **twice**) with one made-up password, and both `change-me-local-app-password` (also twice) with a different one. Use only letters and numbers. Save and close.
5. **Start the database and fill it with test data:**
   ```powershell
   pnpm db:up
   pnpm db:migrate
   pnpm db:seed
   ```
   `db:up` starts the database, `db:migrate` builds the tables and security rules, `db:seed` adds made-up companies, people and jobs.

### Every time you want to use it

Open **two** PowerShell windows in the `Right-Services-Brain` folder (`cd $HOME\Documents\Right-Services-Brain`).

- Window 1, the server: `pnpm dev:api` (leave it running; it prints "Server listening")
- Window 2, the web app: `pnpm dev:web`, then open **http://localhost:5173** in your browser

Pick a test person (for example "Morgan Manager") to sign in.

### Running the automated tests

With Docker Desktop running:
```powershell
pnpm test
```
You should see every test pass. The tests create their own temporary database and delete it afterwards.

---

## Trying the iPhone app

The iPhone runs the app through **Expo Go**, a free app from the App Store. No Apple Developer account is needed for this.

1. On the iPhone, install **Expo Go** from the App Store.
2. Make sure the iPhone and the PC are on the **same Wi-Fi network** (not a guest network).
3. Find your PC's address on the network. In PowerShell run `ipconfig` and look for **IPv4 Address** under your Wi-Fi adapter, for example `192.168.1.23`.
4. Let the phone reach the server. Open `.env` in Notepad and change `API_HOST=127.0.0.1` to `API_HOST=0.0.0.0`. Save. Restart window 1 (`Ctrl+C`, then `pnpm dev:api`). If Windows asks whether Node.js may use the network, choose **Private networks** and click **Allow**.
   *Change it back to `127.0.0.1` when you finish testing; while it's `0.0.0.0`, anyone on your Wi-Fi could use the test sign-in.*
5. In a third PowerShell window: `pnpm dev:mobile`. A QR code appears.
6. Open the iPhone's **Camera** app, point it at the QR code and tap the banner. Expo Go opens the app.
7. On the sign-in screen, type the server address `http://<your IPv4 address>:4000` (for example `http://192.168.1.23:4000`), tap **Connect**, then pick a test person such as **Eli Employee**.

If the QR code won't connect, your Wi-Fi may block phones from talking to PCs. Tell Claude and we'll switch to "tunnel" mode.

---

## Key rules

- Synthetic data only until real sign-in, an independent security review, and the items in [docs/SECURITY.md](docs/SECURITY.md) are done.
- Secrets never go in the code or in GitHub. `.env` is ignored by Git.
- Out of scope for Phase 1: AI, financial reporting, fleet, employees, documents, receipts, advanced project management. (Some of their database tables exist but their screens and server routes are switched off.)
