# Runbook: Live multi-user test on `authenticated` mode (private network)

Status: **verified live** — the full flow below was driven end-to-end against a throwaway instance (signup -> board claim -> create company -> assign to human -> cross-user isolation -> invite -> join).
Goal: exercise the pipeline with several real human users on a private network, **without disturbing the running `local_trusted` pipeline instance**.

## Safety principle (read first)

Run a **separate throwaway instance** with its own `PAPERCLIP_HOME`. Its embedded Postgres lands in a separate data dir on an auto-selected free port, so the running `local_trusted` instance (and its DB) are untouched. **Never switch the running pipeline instance to `authenticated`.**

Two real near-misses this was validated against:
1. A wrong-shell command left the env unset and started a **second server on the real DB**. Always confirm the startup banner shows the throwaway `Database` path before proceeding.
2. `PAPERCLIP_HOME` alone does not force `authenticated` — a hand-written `config.json` `server` section is rejected by schema validation and silently falls back to `local_trusted`. Use the **env overrides** below (they win with precedence, `config.ts:165`).

## What already works (no build required)

Covered by ~68 passing server tests (auth/board/invite/authz): modes, memberships + roles, invites, RBAC, board principal, cross-company isolation, and **company creation grants the creator an active `owner` membership** (`server/src/routes/companies.ts:304`) so `assigneeUserId` works in fresh companies.

## Step 1 — Start a throwaway authenticated instance

From the repo root, in **one terminal**. Env syntax is shell-specific:

**cmd.exe** (note: `set VAR=value`, no quotes):
```bat
set PAPERCLIP_HOME=%USERPROFILE%\.paperclip-mu-test
set PAPERCLIP_DEPLOYMENT_MODE=authenticated
set PAPERCLIP_SECRETS_STRICT_MODE=false
set BETTER_AUTH_SECRET=paperclip-dev-secret
pnpm dev:server
```

**PowerShell**:
```powershell
$env:PAPERCLIP_HOME="$env:USERPROFILE\.paperclip-mu-test"; $env:PAPERCLIP_DEPLOYMENT_MODE="authenticated"; $env:PAPERCLIP_SECRETS_STRICT_MODE="false"; $env:BETTER_AUTH_SECRET="paperclip-dev-secret"; pnpm dev:server
```

Why these: `PAPERCLIP_DEPLOYMENT_MODE` forces authenticated (`config.ts:160-165`); with exposure defaulting to `private` and no public URL, `authBaseUrlMode` is `auto` and needs **no** explicit URL (`index.ts:502-514`). `BETTER_AUTH_SECRET` is required in authenticated mode (`auth/better-auth.ts:128`). `PAPERCLIP_SECRETS_STRICT_MODE=false` avoids strict-mode friction on a fresh throwaway.

**Verify the banner before touching anything:**
- `Deploy: authenticated (private)`
- `Auth: ready`
- `Database  ...\.paperclip-mu-test\...\db (pg:<some port != your real 54329>)`
- `Server listening on 127.0.0.1:<PORT>` — note the PORT (it auto-picks a free one, e.g. 3101, if 3100 is taken).
- A one-time **BOARD CLAIM** URL is printed: `.../board-claim/<token>?code=<code>` — copy the `<token>` and `<code>`.

For a real LAN/Tailscale test, add `set PAPERCLIP_BIND=lan` (or `tailnet`); authenticated mode permits non-loopback (`index.ts:491`).

## Step 2 — Bootstrap the first admin (board claim)

Everything below is HTTP against `http://127.0.0.1:<PORT>`. **All board (session) mutations require an `Origin` header matching the instance** — browsers send it automatically; API clients must set it, or you get `403 "Board mutation requires trusted browser origin"`.

1. Sign up the first human (Better Auth), keeping the session cookie:
   `POST /api/auth/sign-up/email` body `{"email","password" (>= ~12 chars),"name"}` -> returns the user + sets `paperclip-<instance>.session_token`.
2. Claim the board with that session (promotes to `instance_admin`):
   `POST /api/board-claim/<token>/claim` with the session cookie, header `Origin: http://127.0.0.1:<PORT>`, body `{"code":"<code>"}` -> `{"claimed":true,...}`.

## Step 3 — Create a company (as the admin)

`POST /api/companies` with the admin session + `Origin` header, body `{"name":"..."}`. The creator is granted an active `owner` membership automatically, so they can be assigned tasks in this company.

## Step 4 — Invite the other testers

1. Admin creates an invite: `POST /api/companies/<companyId>/invites` (session + `Origin`), body `{"allowedJoinTypes":"human","membershipRole":"operator"}` (note: `allowedJoinTypes` is a **scalar** `"human"|"agent"|"both"`, not an array). Returns `token` (`pcp_invite_...`).
2. Tester signs up (`/api/auth/sign-up/email`), then accepts: `POST /api/invites/<token>/accept` (their session + `Origin`), body `{"requestType":"human"}` -> `status:"approved"`, joined.

## Step 5 — Verify multi-user behaviour

- **Assignment:** `POST /api/companies/<companyId>/issues` body `{"title":"...","assigneeUserId":"<userId>"}` -> the issue carries `assigneeUserId` (works because the assignee has an active membership).
- **Isolation:** before joining, a non-member `GET /api/companies/<companyId>` returns **403** and their `GET /api/companies` returns `[]`; after accepting the invite it returns **200** and the company appears in their list.
- **RBAC:** unauthenticated `GET /api/companies` returns **403** (authenticated mode enforcing).

## Step 6 — Automated smoke (optional)

`pnpm test:e2e:multiuser-authenticated` runs the built-in Playwright multi-user suite (`tests/e2e/multi-user-authenticated.spec.ts`).

## Troubleshooting (all hit during live validation)

- `Board mutation requires trusted browser origin` (403) -> add `Origin: http://127.0.0.1:<PORT>` to the request.
- Instance came up `local_trusted` despite a config file -> use the env overrides in Step 1; the hand-written `server` config section does not apply.
- `BETTER_AUTH_SECRET ... must be set` -> set the env var (dev value is fine for a private test; Better Auth warns it is low-entropy — acceptable for a throwaway).
- Testers can't reach it -> `PAPERCLIP_BIND=lan`/`tailnet`, not loopback.
- `Agent JWT: missing` in the banner is expected for a fresh throwaway; it only affects agent (not human) auth, which this test does not need.

## Cleanup

Stop the throwaway instance (Ctrl+C) and delete its home dir `%USERPROFILE%\.paperclip-mu-test`. The running `local_trusted` pipeline instance is untouched throughout.
