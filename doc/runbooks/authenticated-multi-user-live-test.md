# Runbook: Live multi-user test on `authenticated` mode (private network)

Status: draft (steps marked **[VERIFY LIVE]** were derived from code, not yet run end-to-end).
Goal: exercise the pipeline with several real human users on a private network, **without disturbing the running `local_trusted` pipeline instance**.

## Safety principle (read first)

Run a **separate throwaway instance** with its own `PAPERCLIP_HOME`, `PAPERCLIP_INSTANCE_ID`, port, and embedded database. **Never switch the running `local_trusted` pipeline instance to `authenticated`** — the pipeline depends on it. The throwaway instance provisions its own embedded Postgres on its own data dir, isolated from the real instance (same isolation the test suite relies on).

## What already works (no build required)

The multi-user capability is implemented and covered by ~68 passing server tests (auth/board/invite/authz):
- modes `local_trusted | authenticated`, exposures `private | public` (`packages/shared/src/constants.ts`);
- Better Auth email/password + sessions (`server/src/auth/better-auth.ts`);
- company memberships + roles, invites, join requests, RBAC permission grants (`server/src/services/authorization.ts`, `server/src/routes/access.ts`);
- board principal seeded as a real user in `local_trusted` (`server/src/index.ts:249`);
- **company creation grants the creator an active `owner` membership** (`server/src/routes/companies.ts:304`), so `assigneeUserId` works in freshly created companies;
- cross-company isolation (`server/src/__tests__/companies-route-cross-company-authz.test.ts`, `authz-company-access.test.ts`).

The remaining work is operational: configure authenticated mode, invite humans, and run the flow.

## Step 1 — Config for a throwaway authenticated instance

Fastest path is environment overrides (no persistent config edits). For a private-network test:

- `PAPERCLIP_HOME=<tmp>/mu-test` — isolates DB + data from the real instance.
- `PAPERCLIP_INSTANCE_ID=mu-test`
- `PAPERCLIP_DEPLOYMENT_MODE=authenticated` (`server/src/config.ts:160`)
- `PAPERCLIP_BIND=lan` (or `tailnet`) — reachable by testers; authenticated mode allows non-loopback (`server/src/index.ts:491`).
- `BETTER_AUTH_SECRET=<secret>` — required in authenticated mode (`server/src/auth/better-auth.ts:128`); dev value `paperclip-dev-secret` is acceptable for a private test.
- a port **different** from the running instance (e.g. `3200`; the running pipeline is on `3100`).

Exposure/base URL: for `private` exposure, `auth.baseUrlMode=auto` needs **no** explicit public URL (`server/src/index.ts:502-514`). Only `authenticated + public` requires `authBaseUrlMode=explicit` + `authPublicBaseUrl` (`packages/shared/src/config-schema.ts:172-180`).

Equivalent `config.json` (`$PAPERCLIP_HOME/.paperclip/config.json`) if you prefer a file:

```json
{
  "server": { "deploymentMode": "authenticated", "exposure": "private", "bindMode": "lan", "port": 3200 },
  "auth": { "baseUrlMode": "auto" }
}
```

## Step 2 — Start the throwaway instance  **[VERIFY LIVE]**

```sh
cd <repo>/paperclip
PAPERCLIP_HOME="$TMP/mu-test" PAPERCLIP_INSTANCE_ID=mu-test \
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_BIND=lan \
BETTER_AUTH_SECRET=paperclip-dev-secret \
pnpm dev:server
```

Checks:
- `GET http://<lan-ip>:3200/api/health` → `200`.
- the running pipeline instance on `:3100` is unaffected (its DB/home are separate).

## Step 3 — Bootstrap the first admin (board claim)  **[VERIFY LIVE]**

Authenticated mode boots with an unclaimed synthetic board. The first human:
1. signs up (Better Auth email/password) via the UI;
2. claims the board challenge → is promoted to `instance_admin`.

Source of truth: `server/src/board-claim.ts` + `server/src/__tests__/board-claim.test.ts` ("lets a signed-in user claim a local-board-only authenticated instance"). Confirm the exact UI action / claim endpoint against your running instance.

## Step 4 — Invite the other testers  **[VERIFY LIVE]**

1. Instance admin / company owner creates a company invite, choosing a role (`owner | admin | operator | viewer`).
2. Share the invite link; each tester opens it, signs up, and accepts at `/api/invites/{token}/accept` (`server/src/routes/access.ts:1558`) — or the UI equivalent — joining the company with the granted role. Invite TTL is enforced (`invite-expiry.test.ts`).

## Step 5 — Exercise the pipeline + verify isolation  **[VERIFY LIVE]**

- Assign an issue to a human via `assigneeUserId` (the assignee must have an active membership — granted on company create/invite; validated at `server/src/services/authorization.ts:815`).
- Verify RBAC: a `viewer` can read but not write; a non-member or other-company user cannot see the issue (cross-company isolation, covered by the authz tests above).
- Verify the owner/board can be assigned tasks in a company created after startup.

## Step 6 — Automated smoke (optional, against the throwaway instance)

```sh
pnpm test:e2e:multiuser-authenticated
```

Runs the built-in Playwright multi-user suite (`tests/e2e/multi-user-authenticated.spec.ts` via `playwright-multiuser-authenticated.config.ts`).

## Troubleshooting

- `BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set` → set the env var (`better-auth.ts:128`).
- `authenticated public exposure requires auth.baseUrlMode=explicit` → for a private test use `exposure=private` + `baseUrlMode=auto`.
- Testers can't reach the instance → bind must be `lan`/`tailnet`, not loopback; authenticated mode permits non-loopback (`index.ts:491`).
- Session/cookie failures across devices → check derived trusted origins for the private host (`deriveAuthTrustedOrigins` in `better-auth.ts`).

## Cleanup

Stop the throwaway instance and delete its `PAPERCLIP_HOME` temp dir. The running `local_trusted` pipeline instance is untouched throughout.
