# Runbook: Live multi-user test on `authenticated` mode (private network)

Status: **verified live end-to-end** — the full flow was driven against a throwaway instance over a **LAN IP** with three independent sessions: signup -> first-admin claim -> create company -> pre-join isolation (empty list + `403`) -> invite -> accept -> assign to human -> RBAC denials (viewer-create, operator-invite, anon-list all `403`) -> concurrent two-user edits (17/17 checks). The browser login page was confirmed rendered over the LAN IP, and the running `local_trusted` instance and its DB stayed untouched throughout.
Goal: exercise the pipeline with several real human users on a private network, **without disturbing the running `local_trusted` pipeline instance**.

## Safety principle (read first)

Run a **separate throwaway instance** with its own `PAPERCLIP_HOME`, started **fresh** each time (Step 1 deletes and recreates it). Its embedded Postgres lands in a separate data dir on an auto-selected free port, so the running `local_trusted` instance and its database are untouched. **Never switch the running pipeline instance to `authenticated`.**

Real pitfalls this was validated against:
1. A wrong-shell command left the env unset and started a **second server on the real DB**. Always confirm the startup banner shows the throwaway `Database` path before proceeding.
2. `PAPERCLIP_HOME` alone does not force `authenticated` — a hand-written `config.json` `server` section is rejected by schema validation and silently falls back to `local_trusted`. Use the **env overrides** in Step 1 (they win with precedence, `config.ts:165`).
3. `PAPERCLIP_HOME` does **not** guarantee DB isolation on its own. Startup can still reach a real DB via: an inherited `DATABASE_URL`/`DATABASE_MIGRATION_URL`/`PAPERCLIP_CONFIG` (`runtime-config.ts:189`); a `process.cwd()/.env` or the resolved config's env file loaded at startup (`config.ts:33-44`, `override:false`, and it accepts `export KEY=...`); or an ancestor `.paperclip/config.json` used when `PAPERCLIP_CONFIG` is unset (`paths.ts:28`). Migrations run against the resolved DB **before** the banner prints (`index.ts:316`), so a banner check alone will not save you. This is covered by **Step 0's preflight** (cwd `.env` + ancestor config) plus **Step 1's verified fresh-home delete** (the throwaway's own env file; the server start is gated on that delete having actually succeeded). Both are mandatory.

## What already works

Covered by ~68 passing server tests (auth/board/invite/authz): modes, memberships + roles, invites, RBAC, board principal, cross-company isolation, and **company creation grants the creator an active `owner` membership** (`server/src/routes/companies.ts:304`) so `assigneeUserId` works in fresh companies.

**The browser UI needs a build.** `pnpm dev:server` serves the **API only** unless `ui/dist` exists — with no UI build it logs `UI dist not found; running in API-only mode`. (The banner `Mode` still shows `static-ui` whenever `serveUi` is on — it reflects the config, not whether the build is present — so use that **log line**, or a `GET /` returning HTML, to tell whether the UI is actually served.) Human testers click in a browser, so build the UI once (Step 1). The operator can bootstrap and verify entirely over the API without it, but the testers cannot.

## Step 0 — Preflight (mandatory): no external DB source

From the exact directory you will start the server in, run the preflight. It parses a cwd `.env` with the **server's own dotenv** (so `=`, `: ` colon-style, `export`, and quotes all count exactly as startup does) and aborts if it sets `DATABASE_URL` / `DATABASE_MIGRATION_URL` / `PAPERCLIP_CONFIG` to a non-empty value, or if any ancestor `.paperclip/config.json` exists — sources the server loads at startup and migrates against **before** the banner. Must print `preflight OK`:

```sh
node scripts/mu-test-db-preflight.mjs
```

If it aborts, follow the printed remediation (blank/move the DB vars in the repo `.env`, or remove/relocate the ancestor config), then re-run. Do not proceed until it prints `preflight OK`. (The throwaway home's own env file is handled by Step 1's fresh-home delete.)

## Step 1 — Start a fresh throwaway authenticated instance

One terminal, from the repo root. Env syntax is shell-specific; each block **deletes any previous throwaway home** (so no stale `.env`/config lingers inside it), **clears** inherited DB vars, and **refuses to start the server if the delete failed** — e.g. when a previous throwaway is still running and holds file locks.

**cmd.exe** (`set VAR=value`, no quotes):
```bat
if exist "%USERPROFILE%\.paperclip-mu-test" rmdir /s /q "%USERPROFILE%\.paperclip-mu-test"
set DATABASE_URL=
set DATABASE_MIGRATION_URL=
set PAPERCLIP_CONFIG=
set PAPERCLIP_HOME=%USERPROFILE%\.paperclip-mu-test
set PAPERCLIP_DEPLOYMENT_MODE=authenticated
set PAPERCLIP_SECRETS_STRICT_MODE=false
set BETTER_AUTH_SECRET=paperclip-dev-secret
if exist "%USERPROFILE%\.paperclip-mu-test" (echo ABORT - stale throwaway home still exists, stop the previous throwaway with Ctrl+C and re-run this block) else (pnpm dev:server)
```

**PowerShell** (single line on purpose — see note below):
```powershell
if (Test-Path "$env:USERPROFILE\.paperclip-mu-test") { Remove-Item -Recurse -Force "$env:USERPROFILE\.paperclip-mu-test" -ErrorAction Stop }; if (Test-Path "$env:USERPROFILE\.paperclip-mu-test") { throw "ABORT - stale throwaway home still exists (previous throwaway still running?)" }; $env:DATABASE_URL=$null; $env:DATABASE_MIGRATION_URL=$null; $env:PAPERCLIP_CONFIG=$null; $env:PAPERCLIP_HOME="$env:USERPROFILE\.paperclip-mu-test"; $env:PAPERCLIP_DEPLOYMENT_MODE="authenticated"; $env:PAPERCLIP_SECRETS_STRICT_MODE="false"; $env:BETTER_AUTH_SECRET="paperclip-dev-secret"; pnpm dev:server
```

Pasted lines keep executing even after an earlier line fails (in both shells), so the delete-failed guard must gate the start command itself: in cmd the final line wraps `pnpm dev:server` in an `if exist` check (an `exit /b` would not stop the remaining pasted lines), and the PowerShell block is one statement list so the `throw`/`-ErrorAction Stop` cancels everything after it, including the start.

Why: `PAPERCLIP_DEPLOYMENT_MODE` forces authenticated (`config.ts:160-165`); with exposure defaulting to `private` and no public URL, `authBaseUrlMode` is `auto` and needs **no** explicit URL (`index.ts:502-514`). `BETTER_AUTH_SECRET` is required in authenticated mode (`auth/better-auth.ts:128`). `PAPERCLIP_SECRETS_STRICT_MODE=false` avoids strict-mode friction. The fresh-home delete removes any stale throwaway env file, and the gated start refuses to run if that delete failed (pitfall 3).

**Verify the banner before touching anything:**
- `Deploy: authenticated (private)`
- `Auth: ready`
- `Database  ...\.paperclip-mu-test\...\db (pg:<port != your real 54329>)`
- `Server listening on <BIND>:<PORT>` (`127.0.0.1` for loopback, `0.0.0.0` with `bind=lan`) — note the PORT (auto-picked; e.g. 3101 if 3100 is taken).
- `Mode ... static-ui` (shown whenever `serveUi` is on, even with no UI build — it is **not** proof the UI is served). To confirm the UI is actually served, check the log for `UI dist not found; running in API-only mode` (absent = served) or that `GET /` returns HTML.
- **No board-claim URL prints on a fresh home** — that only appears if this home previously ran `local_trusted` (which seeds a `local-board` admin). A genuinely fresh authenticated instance has zero admins and bootstraps via Step 2's browser first-admin claim (`bootstrapStatus:"bootstrap_pending"` at `/api/health`).

**For a real LAN/Tailscale test, two env vars are needed** (not just one):
- `PAPERCLIP_BIND=lan` (or `tailnet`) so it binds non-loopback (`index.ts:491`).
- `PAPERCLIP_ALLOWED_HOSTNAMES=<your-LAN-IP>` — otherwise the private-hostname guard rejects every request to that IP with `Hostname '<ip>' is not allowed for this Paperclip instance` (`middleware/private-hostname-guard.ts`; `bind=0.0.0.0` is **not** auto-allowed). Comma-separated for several hosts (`config.ts:216`); equivalently `pnpm paperclipai allowed-hostname <ip>`. cmd: `set PAPERCLIP_BIND=lan` + `set PAPERCLIP_ALLOWED_HOSTNAMES=192.168.1.50`; PowerShell: `$env:PAPERCLIP_BIND="lan"; $env:PAPERCLIP_ALLOWED_HOSTNAMES="192.168.1.50"`. Testers then use `http://<your-LAN-IP>:<PORT>`.

**To give testers a browser UI, build it once** (the API server then serves it as `static-ui` on the same port — no extra process):
```sh
pnpm --filter @paperclipai/ui build
```
Alternatively run `pnpm dev:ui` in a second terminal (Vite dev server, proxies to the API). Without either, the instance is API-only and testers see nothing in a browser.

## Step 2 — Bootstrap the first admin

All calls target `http://<HOST>:<PORT>` (loopback `127.0.0.1`, or your LAN IP for a networked test). **Every board (session) mutation requires an `Origin` header matching the instance** — browsers send it automatically; API clients must set it, or you get `403 "Board mutation requires trusted browser origin"`.

A **fresh** authenticated instance has no admin. The **first signed-in user to claim** becomes `instance_admin` — no token, no code:

1. Sign up the first human, keeping the session cookie: `POST /api/auth/sign-up/email` body `{"email","password" (>= ~12 chars),"name"}` -> returns the user (`user.id`) + sets `paperclip-<instance>.session_token`. In a browser, use the **Create one** link on the sign-in page.
2. Claim first admin: `POST /api/bootstrap/claim` with the session cookie + `Origin` header and an empty body `{}` -> `{"claimed":true,"userId":"..."}`. Requires `authenticated`+`private` and a signed-in browser session (`routes/access.ts:2487`); a second caller gets `409 "already claimed"`.

*(Migration case only: if this home previously ran `local_trusted`, its sole admin is `local-board` and startup instead prints a one-time `.../board-claim/<token>?code=<code>` URL — claim via `POST /api/board-claim/<token>/claim` with body `{"code":"<code>"}`. The fresh-home delete in Step 1 does not reach this path.)*

## Step 3 — Create a company (as the admin)

`POST /api/companies` with the admin session + `Origin` header, body `{"name":"..."}`. The creator is granted an active `owner` membership automatically, so they can be assigned tasks in this company.

## Step 4 — Invite the other testers

1. Admin creates an invite: `POST /api/companies/<companyId>/invites` (session + `Origin`), body `{"allowedJoinTypes":"human","humanRole":"operator"}` (`allowedJoinTypes` is a **scalar** `"human"|"agent"|"both"`, not an array; the role field is **`humanRole`** per `packages/shared/src/validators/access.ts:14` — `membershipRole` is silently ignored here). Returns `token` (`pcp_invite_...`).
2. Tester signs up (`/api/auth/sign-up/email`), then accepts: `POST /api/invites/<token>/accept` (their session + `Origin`), body `{"requestType":"human"}` -> `status:"approved"`, joined.

## Step 5 — Verify multi-user behaviour

- **Assignment:** `POST /api/companies/<companyId>/issues` body `{"title":"...","assigneeUserId":"<userId>"}` -> the issue carries `assigneeUserId`. (`status` is optional — the route defaults it via `applyCreateIssueStatusDefault` (`server/src/routes/issues.ts`); pass one only if you want a specific `ISSUE_STATUSES` value.)
- **Isolation:** before joining, a non-member `GET /api/companies/<companyId>` returns **403** and their `GET /api/companies` returns `[]`; after accepting the invite it returns **200** and the company appears in their list.
- **RBAC:** unauthenticated `GET /api/companies` returns **403**; a **viewer** `POST .../issues` returns **403**; an **operator** `POST .../invites` returns **403** (no `users:invite`).
- **Concurrency:** two members `PATCH /api/issues/<id>` on different issues at the same time both succeed and persist independently (no clobber).

## Step 6 — Automated smoke (optional, requires extra setup)

A built-in Playwright multi-user suite exists (`tests/e2e/multi-user-authenticated.spec.ts`), but `pnpm test:e2e:multiuser-authenticated` is **not** a one-liner: its config (`tests/e2e/playwright-multiuser-authenticated.config.ts`) has **no `webServer`** and targets `PAPERCLIP_E2E_PORT` (default **3105**), and the spec expects `PAPERCLIP_HOME` / `PAPERCLIP_E2E_DATA_DIR` plus a valid config. Start a throwaway authenticated instance bound to that port with the E2E env first, then run the command. The manual API smoke in Steps 2-5 is the simpler, already-verified path.

## Troubleshooting (all hit during live validation)

- `ABORT - stale throwaway home still exists` -> a previous throwaway is still running (stop it with Ctrl+C) or something else holds a handle inside `%USERPROFILE%\.paperclip-mu-test` (close terminals/Explorer windows in it), then re-run the whole Step 1 block.
- `Board mutation requires trusted browser origin` (403) -> add `Origin: http://<HOST>:<PORT>` (matching the host you called) to the request.
- `Hostname '<ip>' is not allowed for this Paperclip instance` (403 on every request over the LAN IP) -> set `PAPERCLIP_ALLOWED_HOSTNAMES=<ip>` and restart; `PAPERCLIP_BIND=lan` alone does not allow the IP (see Step 1).
- Instance came up `local_trusted` despite a config file -> use the env overrides in Step 1; a hand-written `server` config section does not apply.
- `BETTER_AUTH_SECRET ... must be set` -> set the env var (dev value is fine for a private test; Better Auth warns it is low-entropy — acceptable for a throwaway).
- Browser shows nothing / `UI dist not found; running in API-only mode` -> build the UI (`pnpm --filter @paperclipai/ui build`) or run `pnpm dev:ui`; `dev:server` alone is API-only (see Step 1).
- Testers can't reach it -> need **both** `PAPERCLIP_BIND=lan`/`tailnet` **and** `PAPERCLIP_ALLOWED_HOSTNAMES=<ip>`, not loopback.
- `Agent JWT: missing` in the banner is expected for a fresh throwaway; it only affects agent (not human) auth, which this test does not need.

## Cleanup

Stop the throwaway instance (Ctrl+C). Step 1 deletes and recreates its home on the next run, but you can also remove `%USERPROFILE%\.paperclip-mu-test` when done. The running `local_trusted` pipeline instance is untouched throughout.
