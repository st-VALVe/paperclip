# Runbook: Onboard an agent into an `authenticated` instance (humans + agents)

Status: **DERIVED FROM CODE — not yet driven end-to-end.** Unlike `authenticated-multi-user-live-test.md` (which was self-run 17/17 over a LAN IP), this procedure is assembled from source and unit-tested behavior only. Steps are tagged **[CODE]** (grounded in the referenced source; verifiable by reading/tests without a live run) or **[LIVE]** (needs a real run and owner-provided adapter config/credentials). Expect a first live run to surface gaps of the same kind the multi-user runbook's live run did (its bootstrap/LAN/UI steps were all wrong until run). Do not treat this as battle-tested until it is.

Goal: enrol one AI agent in a throwaway `authenticated` company and drive a `human → agent → human` issue, **without disturbing the running `local_trusted` pipeline instance**.

## Prerequisites

- A throwaway `authenticated` + `private` instance per [`authenticated-multi-user-live-test.md`](authenticated-multi-user-live-test.md), with a signed-in first admin and a company (Steps 0–3 there). This runbook adds the agent side.
- **[CODE]** An agent JWT secret. `createLocalAgentJwt` reads `PAPERCLIP_AGENT_JWT_SECRET`, falling back to `BETTER_AUTH_SECRET` (`server/src/agent-auth-jwt.ts:35`). The multi-user runbook already sets `BETTER_AUTH_SECRET`, so JWT signing works; set `PAPERCLIP_AGENT_JWT_SECRET` explicitly if you want a dedicated key.
- **[LIVE]** A working adapter on the host for whatever `adapterType` you use (`process` / `claude_local` / `codex`). The agent's actual execution needs real adapter tooling + credentials — this is owner-deploy/live, not something the repo alone provides. Reuse the same adapter setup the existing pipeline uses (e.g. `bin/claude-shim.cmd` for `claude_local`, or `codex`).

## What the code guarantees (so you know what to expect)

- **[CODE]** One issue is assignable to a human (`assigneeUserId`) **or** an agent (`assigneeAgentId`) — same schema (`packages/shared/src/validators/issue.ts`).
- **[CODE]** Agents and humans share one membership + permission model: `getActiveMembership` and `decidePrincipalGrant` treat `principalType` `"agent"` and `"user"` identically (`server/src/services/authorization.ts:419,1308`).
- **[CODE]** Agent auth is tenant-isolated: the JWT is signed with a per-company key (`deriveCompanySigningKey`, used in both sign and verify) and verification rejects a `companyId` mismatch (`server/src/agent-auth-jwt.ts`); API keys carry `companyId` and middleware blocks cross-company use ("Agent key cannot access another company", `server/src/middleware/auth.ts`).
- **[CODE]** Assigning to an agent **wakes** it; assigning to a human does **not** — human pickup is manual via the Inbox (`server/src/services/issue-assignment-wakeup.ts`, no wake path for `assigneeUserId`).

## Step A — Onboard the agent (pick one path)

Both paths target `http://<HOST>:<PORT>` with an `Origin` header matching the instance (board mutations require it — see the multi-user runbook).

### Path 1 — Admin creates the agent directly (simplest for a test)

**[CODE]** As the admin, `POST /api/companies/<companyId>/agents` (`server/src/routes/agents.ts`), body at minimum:
```json
{ "name": "Test Agent", "adapterType": "process" }
```
`createAgentSchema` requires `name` and `adapterType`; `role` defaults to `"general"`, `adapterConfig` to `{}` (`packages/shared/src/validators/agent.ts:70`). The route is gated by `assertCanCreateAgentsForCompany` → the `agents:create` permission (instance admin qualifies; a plain member needs an explicit grant) (`server/src/routes/agents.ts`).

**[CODE]** Then mint an API key for the agent: `POST /api/agents/<agentId>/keys` (board-only, `assertBoard`) → returns the token **once** (`server/src/routes/agents.ts`). The agent authenticates with `Authorization: Bearer <token>`.

### Path 2 — Symmetric invite (the same funnel humans use)

**[CODE]**
1. Admin creates an agent-capable invite: `POST /api/companies/<companyId>/invites`, body `{"allowedJoinTypes":"agent","humanRole":"operator"}` (`allowedJoinTypes` is a scalar `"human"|"agent"|"both"`).
2. Accept as an agent: `POST /api/invites/<token>/accept`, body `{"requestType":"agent","agentName":"Test Agent"}` — `agentName` is required for agent joins (`server/src/routes/access.ts:3486`). This creates a `pending_approval` join request with a one-time `claimSecret`.
3. Admin approves: `POST /api/companies/<companyId>/join-requests/<requestId>/approve` (needs `joins:approve`). On approval the server calls `agents.create(companyId, …)` and `access.ensureMembership(companyId,"agent",…)` (`server/src/routes/access.ts:3924,3994,4015`).
4. Claim the API key: `POST /api/join-requests/<requestId>/claim-api-key` with the `claimSecret` → returns `{ keyId, token, agentId }` (`server/src/routes/access.ts:4121,4174`).

## Step B — Configure the adapter **[LIVE]**

The agent record exists, but it will not do real work until its adapter is configured with host tooling + credentials (`adapterConfig` / `runtimeConfig`). This is the owner-deploy step; it cannot be proven from the repo alone. Reuse the working pipeline adapter setup. For `claude_local`, agents launch via `bin/claude-shim.cmd`; for `codex`, the `codex` CLI. Confirm the agent's `adapterType` matches available tooling.

## Step C — Assign an issue to the agent (human → agent)

**[CODE]** As a human, `POST /api/companies/<companyId>/issues`, body `{"title":"…","assigneeAgentId":"<agentId>"}`. Assigning an agent (when status is not `backlog`) enqueues a wakeup → `heartbeat.wakeup(assigneeAgentId,…)` → a queued `heartbeatRuns` row (`server/src/services/issue-assignment-wakeup.ts`, `server/src/routes/issues.ts`). **[LIVE]** Whether the run then executes depends on Step B.

## Step D — Verify

- **[CODE] Membership**: the agent appears as an active `"agent"` member of the company (query the company members; the approval path sets this).
- **[CODE] Tenant scope**: the agent's key/JWT is bound to that `companyId`; a call to another company returns 403.
- **[CODE] Wake**: assigning the issue creates a queued run for the agent (observable via the run/heartbeat API or server log `heartbeat.run.queued`).
- **[LIVE] Round-trip**: the agent executes, produces a work product, and hands the issue back to a human via `assigneeUserId` — which lands in that human's **Inbox** with no wake (they check it manually).

## Safety

- Use the throwaway home from the multi-user runbook. **Never** switch the running `local_trusted` pipeline instance to `authenticated`.
- Point the agent runtime/adapter at the throwaway instance only. The existing pipeline runs against `local_trusted`; do not cross the two.

## Known gaps to close on the first live run

- Agent onboarding via invite under `authenticated` has unit coverage but no end-to-end live proof.
- Agent JWT issuance in a real run requires an adapter with `supportsLocalAgentJwt` (`server/src/services/heartbeat.ts`); confirm your adapter sets it.
- The agent runtime pointed at an `authenticated` instance (vs `local_trusted`) is untested; expect first-run configuration friction.
