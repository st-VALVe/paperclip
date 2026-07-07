# Runbook: Live multi-user test on `authenticated` mode (private network)

Status: **verified live** — the flow below was driven end-to-end against a throwaway instance (signup -> board claim -> create company -> assign to human -> cross-user isolation -> invite -> join).
Goal: exercise the pipeline with several real human users on a private network, **without disturbing the running `local_trusted` pipeline instance**.

## Safety principle (read first)

Run a **separate throwaway instance** with its own `PAPERCLIP_HOME`, started **fresh** each time (Step 1 deletes and recreates it). Its embedded Postgres lands in a separate data dir on an auto-selected free port, so the running `local_trusted` instance and its database are untouched. **Never switch the running pipeline instance to `authenticated`.**

Real pitfalls this was validated against:
1. A wrong-shell command left the env unset and started a **second server on the real DB**. Always confirm the startup banner shows the throwaway `Database` path before proceeding.
2. `PAPERCLIP_HOME` alone does not force `authenticated` — a hand-written `config.json` `server` section is rejected by schema validation and silently falls back to `local_trusted`. Use the **env overrides** in Step 1 (they win with precedence, `config.ts:165`).
3. `PAPERCLIP_HOME` does **not** guarantee DB isolation on its own. Startup can still reach a real DB via: an inherited `DATABASE_URL`/`DATABASE_MIGRATION_URL`/`PAPERCLIP_CONFIG` (`runtime-config.ts:189`); a `process.cwd()/.env` or the resolved config's env file loaded at startup (`config.ts:33-44`, `override:false`, and it accepts `export KEY=...`); or an ancestor `.paperclip/config.json` used when `PAPERCLIP_CONFIG` is unset (`paths.ts:28`). Migrations run against the resolved DB **before** the banner prints (`index.ts:316`), so a banner check alone will not save you. This is covered by **Step 0's preflight** (cwd `.env` + ancestor config) plus **Step 1's verified fresh-home delete** (the throwaway's own env file; the server start is gated on that delete having actually succeeded). Both are mandatory.

## What already works (no build required)

Covered by ~68 passing server tests (auth/board/invite/authz): modes, memberships + roles, invites, RBAC, board principal, cross-company isolation, and **company creation grants the creator an active `owner` membership** (`server/src/routes/companies.ts:304`) so `assigneeUserId` works in fresh companies.

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
- `Server listening on 127.0.0.1:<PORT>` — note the PORT (auto-picked; e.g. 3101 if 3100 is taken).
- A one-time **BOARD CLAIM** URL is printed: `.../board-claim/<token>?code=<code>` — copy the `<token>` and `<code>`.

For a real LAN/Tailscale test add `set PAPERCLIP_BIND=lan` (or `tailnet`); authenticated mode permits non-loopback (`index.ts:491`).

## Step 2 — Bootstrap the first admin (board claim)

All calls target `http://127.0.0.1:<PORT>`. **Every board (session) mutation requires an `Origin` header matching the instance** — browsers send it automatically; API clients must set it, or you get `403 "Board mutation requires trusted browser origin"`.

1. Sign up the first human, keeping the session cookie: `POST /api/auth/sign-up/email` body `{"email","password" (>= ~12 chars),"name"}` -> returns the user + sets `paperclip-<instance>.session_token`.
2. Claim the board (promotes to `instance_admin`): `POST /api/board-claim/<token>/claim` with the session cookie, header `Origin: http://127.0.0.1:<PORT>`, body `{"code":"<code>"}` -> `{"claimed":true,...}`.

## Step 3 — Create a company (as the admin)

`POST /api/companies` with the admin session + `Origin` header, body `{"name":"..."}`. The creator is granted an active `owner` membership automatically, so they can be assigned tasks in this company.

## Step 4 — Invite the other testers

1. Admin creates an invite: `POST /api/companies/<companyId>/invites` (session + `Origin`), body `{"allowedJoinTypes":"human","humanRole":"operator"}` (`allowedJoinTypes` is a **scalar** `"human"|"agent"|"both"`, not an array; the role field is **`humanRole`** per `packages/shared/src/validators/access.ts:14` — `membershipRole` is silently ignored here). Returns `token` (`pcp_invite_...`).
2. Tester signs up (`/api/auth/sign-up/email`), then accepts: `POST /api/invites/<token>/accept` (their session + `Origin`), body `{"requestType":"human"}` -> `status:"approved"`, joined.

## Step 5 — Verify multi-user behaviour

- **Assignment:** `POST /api/companies/<companyId>/issues` body `{"title":"...","assigneeUserId":"<userId>"}` -> the issue carries `assigneeUserId`.
- **Isolation:** before joining, a non-member `GET /api/companies/<companyId>` returns **403** and their `GET /api/companies` returns `[]`; after accepting the invite it returns **200** and the company appears in their list.
- **RBAC:** unauthenticated `GET /api/companies` returns **403**.

## Step 6 — Automated smoke (optional, requires extra setup)

A built-in Playwright multi-user suite exists (`tests/e2e/multi-user-authenticated.spec.ts`), but `pnpm test:e2e:multiuser-authenticated` is **not** a one-liner: its config (`tests/e2e/playwright-multiuser-authenticated.config.ts`) has **no `webServer`** and targets `PAPERCLIP_E2E_PORT` (default **3105**), and the spec expects `PAPERCLIP_HOME` / `PAPERCLIP_E2E_DATA_DIR` plus a valid config. Start a throwaway authenticated instance bound to that port with the E2E env first, then run the command. The manual API smoke in Steps 2-5 is the simpler, already-verified path.

## Troubleshooting (all hit during live validation)

- `ABORT - stale throwaway home still exists` -> a previous throwaway is still running (stop it with Ctrl+C) or something else holds a handle inside `%USERPROFILE%\.paperclip-mu-test` (close terminals/Explorer windows in it), then re-run the whole Step 1 block.
- `Board mutation requires trusted browser origin` (403) -> add `Origin: http://127.0.0.1:<PORT>` to the request.
- Instance came up `local_trusted` despite a config file -> use the env overrides in Step 1; a hand-written `server` config section does not apply.
- `BETTER_AUTH_SECRET ... must be set` -> set the env var (dev value is fine for a private test; Better Auth warns it is low-entropy — acceptable for a throwaway).
- Testers can't reach it -> `PAPERCLIP_BIND=lan`/`tailnet`, not loopback.
- `Agent JWT: missing` in the banner is expected for a fresh throwaway; it only affects agent (not human) auth, which this test does not need.

## Cleanup

Stop the throwaway instance (Ctrl+C). Step 1 deletes and recreates its home on the next run, but you can also remove `%USERPROFILE%\.paperclip-mu-test` when done. The running `local_trusted` pipeline instance is untouched throughout.
