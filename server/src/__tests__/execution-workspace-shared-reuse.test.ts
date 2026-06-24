// BLIND tests (Constitution III: test author != spec author != implementer).
// Authored from `pipeline-v2/paperclip-shared-workspace-reuse.SPEC.md` ALONE,
// against Paperclip baseline 320efd0f. The fix is NOT implemented yet:
// `executionWorkspaceService(db).findReusableSharedWorkspace(...)` does not exist,
// so the lookup describe block is RED until the dedicated shared_workspace candidate
// lookup lands. Every assertion traces to a spec clause; none was derived from
// runtime output.
//
// Covers the [BLIND] acceptance clauses:
//   - shared_workspace + a non-archived reusable candidate for the identity -> "reuse";
//     none -> "create".
//   - An environment conflict -> "create fresh" even when a candidate exists
//     (resolveSharedWorkspaceReuseDecision; see the env-supersession note below).
//   - branchName == null (or sourceIssueId == null) -> normal path, no dedup.
//   - Non-shared modes -> unchanged.
//   - Atomicity seam (unit slice): the lookup keys on the logical identity
//     (companyId + projectId + sourceIssueId + branchName + mode=shared_workspace),
//     NOT on a found-row set, so the candidate-absent path is covered. Full
//     concurrency (two simultaneous wakes) is [LIVE] and intentionally NOT tested here.
//
// Reusable-candidate contract from the spec "Dedup identity" + "Fix" sections:
//   findReusableSharedWorkspace({ companyId, projectId, sourceIssueId, branchName })
//   returns the matching execution workspace ONLY when
//     mode = "shared_workspace" AND status IN (active, idle, in_review)
//     AND closedAt IS NULL AND all four identity columns match;
//   returns null when sourceIssueId or branchName is null (no stable identity).
//   Environment matching is deliberately NOT applied by the lookup. The spec originally
//   routed the candidate's persisted env through resolveExecutionWorkspaceEnvironmentId
//   ("Do NOT invent a new env-match heuristic"). The AIM-68 upstream rebase superseded
//   that: origin/master redefined resolveExecutionWorkspaceEnvironmentId as a pure per-run
//   precedence resolver (agent > instance > local) with no conflict arm and dropped the
//   env-conflict gate from the existing-workspace reuse path, so the reused row no longer
//   pins an environment. The dedicated env-conflict assertions were removed; the reuse
//   decision itself stays pinned below via resolveSharedWorkspaceReuseDecision.
//
// Reuse decision contract (spec "Fix" lines: requestedShouldReuseExisting = true for a
// shared target WITH a reusable candidate; existing formula at heartbeat
// shouldReuseExisting = requestedShouldReuseExisting && !environmentResolution.conflict):
//   resolveSharedWorkspaceReuseDecision({ candidate, environmentConflict }) returns true
//   (reuse) ONLY when candidate != null AND there is no environment conflict; otherwise
//   false (create fresh). This is the seam the brief means by "mock the candidate lookup":
//   the (mockable) lookup result + the resolver's conflict combine into the decision. The
//   final inline wiring of this decision into heartbeat provisioning is integration ([LIVE]).
//
// INTENDED SEAMS (test-author-defined): the spec describes a "dedicated shared_workspace-only
// lookup" and the reuse decision but does not name them. To make the [BLIND] acceptance
// unit-testable these tests fix two PUBLIC seams the implementer must expose (not bury as
// private/inline helpers): the service method
// `executionWorkspaceService(db).findReusableSharedWorkspace(...)` and the exported policy
// function `resolveSharedWorkspaceReuseDecision(...)`. Renaming/relocating is fine if the
// implementer updates these tests in lockstep; collapsing them into untestable internals is not.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";
import {
  resolveSharedWorkspaceReuseDecision,
} from "../services/execution-workspace-policy.ts";

// The planned identity branch (the same value planExecutionWorkspaceBranch yields
// for PAP-447 "Add Worktree Support"); branchName is part of the dedup identity.
const BRANCH = "PAP-447-add-worktree-support";

describe("resolveSharedWorkspaceReuseDecision", () => {
  // Spec acceptance: a reusable candidate -> "reuse"; none -> "create"; an env
  // conflict -> "create fresh" EVEN WHEN a candidate exists. This pins the decision
  // itself (candidate + conflict combined), which the resolver tests above cannot:
  // a lookup could exist and still be reused on a conflicting env. The candidate is
  // a stand-in for the (mocked) findReusableSharedWorkspace result; only its presence
  // matters to the decision. environmentConflict is the resolver's conflict signal.
  const candidate = { id: "execution-workspace-1" };
  const environmentConflict = { reason: "reused_workspace_environment_mismatch" };

  it("reuses when a candidate exists and there is no environment conflict", () => {
    expect(resolveSharedWorkspaceReuseDecision({ candidate, environmentConflict: null })).toBe(true);
  });

  it("creates fresh when a candidate exists but the environment conflicts", () => {
    expect(resolveSharedWorkspaceReuseDecision({ candidate, environmentConflict })).toBe(false);
  });

  it("creates when no candidate exists and there is no conflict", () => {
    expect(resolveSharedWorkspaceReuseDecision({ candidate: null, environmentConflict: null })).toBe(false);
  });

  it("creates when no candidate exists even if the environment conflicts", () => {
    expect(resolveSharedWorkspaceReuseDecision({ candidate: null, environmentConflict })).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres shared-workspace reuse tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("executionWorkspaceService.findReusableSharedWorkspace", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof executionWorkspaceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-shared-workspace-reuse-");
    db = createDb(tempDb.connectionString);
    svc = executionWorkspaceService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Paperclip",
      // Unique per company: the tenant-isolation test seeds two companies, and
      // companies_issue_prefix_idx is a UNIQUE index on issue_prefix.
      issuePrefix: `PAP-${id.slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedProject(companyId: string) {
    const id = randomUUID();
    await db.insert(projects).values({
      id,
      companyId,
      name: "Shared workspace reuse",
      status: "in_progress",
      executionWorkspacePolicy: { enabled: true },
    });
    return id;
  }

  async function seedCompanyProject() {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    return { companyId, projectId };
  }

  async function seedIssue(companyId: string, projectId: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      projectId,
      title: "Shared workspace issue",
      status: "todo",
      priority: "medium",
    });
    return id;
  }

  async function insertWorkspace(values: {
    companyId: string;
    projectId: string;
    sourceIssueId: string | null;
    branchName: string | null;
    mode?: string;
    status?: string;
    closedAt?: Date | null;
  }) {
    const id = randomUUID();
    await db.insert(executionWorkspaces).values({
      id,
      companyId: values.companyId,
      projectId: values.projectId,
      sourceIssueId: values.sourceIssueId,
      mode: values.mode ?? "shared_workspace",
      strategyType: "git_worktree",
      name: "Execution workspace",
      status: values.status ?? "active",
      providerType: "git_worktree",
      cwd: "/tmp/shared-workspace",
      branchName: values.branchName,
      closedAt: values.closedAt ?? null,
    });
    return id;
  }

  it("returns the active shared_workspace candidate matching the full identity (decision: reuse)", async () => {
    const { companyId, projectId } = await seedCompanyProject();
    const sourceIssueId = await seedIssue(companyId, projectId);
    const wsId = await insertWorkspace({ companyId, projectId, sourceIssueId, branchName: BRANCH, status: "active" });

    const found = await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId, branchName: BRANCH });

    expect(found?.id).toBe(wsId);
    expect(found?.mode).toBe("shared_workspace");
    expect(found?.status).toBe("active");
  });

  it("returns null when no shared_workspace candidate exists for the identity (decision: create)", async () => {
    // Candidate-absent path: the lookup keys on the logical identity itself, not on a
    // found-row set, so an empty result yields "create" rather than a silent reuse.
    const { companyId, projectId } = await seedCompanyProject();
    const sourceIssueId = await seedIssue(companyId, projectId);

    const found = await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId, branchName: BRANCH });

    expect(found).toBeNull();
  });

  it("treats active, idle, and in_review shared candidates as reusable", async () => {
    const { companyId, projectId } = await seedCompanyProject();
    for (const status of ["active", "idle", "in_review"]) {
      const sourceIssueId = await seedIssue(companyId, projectId);
      const wsId = await insertWorkspace({ companyId, projectId, sourceIssueId, branchName: BRANCH, status });

      const found = await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId, branchName: BRANCH });

      expect(found?.id).toBe(wsId);
      expect(found?.status).toBe(status);
    }
  });

  it("excludes archived and closed shared candidates", async () => {
    const { companyId, projectId } = await seedCompanyProject();

    const archivedIssue = await seedIssue(companyId, projectId);
    await insertWorkspace({ companyId, projectId, sourceIssueId: archivedIssue, branchName: BRANCH, status: "archived" });

    const closedIssue = await seedIssue(companyId, projectId);
    await insertWorkspace({
      companyId,
      projectId,
      sourceIssueId: closedIssue,
      branchName: BRANCH,
      status: "active",
      closedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(
      await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId: archivedIssue, branchName: BRANCH }),
    ).toBeNull();
    expect(
      await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId: closedIssue, branchName: BRANCH }),
    ).toBeNull();
  });

  it("excludes non-shared workspace modes from shared reuse (other modes unchanged)", async () => {
    // The full known non-shared mode vocabulary (mirrors the reuseEligible mode list in
    // execution-workspaces.ts): a shared-only lookup must exclude every one of them.
    const { companyId, projectId } = await seedCompanyProject();
    for (const mode of ["isolated_workspace", "operator_branch", "adapter_managed", "cloud_sandbox"]) {
      const sourceIssueId = await seedIssue(companyId, projectId);
      await insertWorkspace({ companyId, projectId, sourceIssueId, branchName: BRANCH, mode, status: "active" });

      const found = await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId, branchName: BRANCH });

      expect(found).toBeNull();
    }
  });

  it("does not match a candidate whose branchName differs (identity includes branchName)", async () => {
    const { companyId, projectId } = await seedCompanyProject();
    const sourceIssueId = await seedIssue(companyId, projectId);
    await insertWorkspace({ companyId, projectId, sourceIssueId, branchName: "PAP-447-some-other-branch", status: "active" });

    expect(
      await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId, branchName: BRANCH }),
    ).toBeNull();
  });

  it("keys on sourceIssueId (not branch name alone) and returns the full-identity candidate", async () => {
    const { companyId, projectId } = await seedCompanyProject();
    const targetIssue = await seedIssue(companyId, projectId);
    const otherIssue = await seedIssue(companyId, projectId);

    // Same company + project + branch, but a DIFFERENT source issue: must NOT match.
    await insertWorkspace({ companyId, projectId, sourceIssueId: otherIssue, branchName: BRANCH, status: "active" });
    expect(
      await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId: targetIssue, branchName: BRANCH }),
    ).toBeNull();

    // The candidate matching the full identity IS returned (not just any shared row).
    const targetWs = await insertWorkspace({ companyId, projectId, sourceIssueId: targetIssue, branchName: BRANCH, status: "active" });
    expect(
      (await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId: targetIssue, branchName: BRANCH }))?.id,
    ).toBe(targetWs);
  });

  it("does not match a candidate recorded under a different projectId (identity includes projectId)", async () => {
    const { companyId, projectId } = await seedCompanyProject();
    const sourceIssueId = await seedIssue(companyId, projectId);
    const otherProjectId = await seedProject(companyId);

    // Same company + source issue + branch, but the row is recorded under a different
    // project. A lookup keyed on sourceIssueId alone (which already implies a project)
    // would wrongly match; the spec identity lists projectId explicitly.
    await insertWorkspace({ companyId, projectId: otherProjectId, sourceIssueId, branchName: BRANCH, status: "active" });

    expect(
      await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId, branchName: BRANCH }),
    ).toBeNull();
  });

  it("does not match a candidate recorded under a different companyId (tenant isolation)", async () => {
    const { companyId, projectId } = await seedCompanyProject();
    const sourceIssueId = await seedIssue(companyId, projectId);
    const otherCompanyId = await seedCompany();

    // Same project + source issue + branch, but the row is recorded under a different
    // company. The lookup MUST scope by companyId so reuse never crosses tenants.
    await insertWorkspace({ companyId: otherCompanyId, projectId, sourceIssueId, branchName: BRANCH, status: "active" });

    expect(
      await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId, branchName: BRANCH }),
    ).toBeNull();
  });

  it("skips dedup when sourceIssueId is null (no stable identity)", async () => {
    const { companyId, projectId } = await seedCompanyProject();
    await insertWorkspace({ companyId, projectId, sourceIssueId: null, branchName: BRANCH, status: "active" });

    const found = await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId: null, branchName: BRANCH });

    expect(found).toBeNull();
  });

  it("skips dedup when branchName is null (no stable identity)", async () => {
    const { companyId, projectId } = await seedCompanyProject();
    const sourceIssueId = await seedIssue(companyId, projectId);
    await insertWorkspace({ companyId, projectId, sourceIssueId, branchName: null, status: "active" });

    const found = await svc.findReusableSharedWorkspace({ companyId, projectId, sourceIssueId, branchName: null });

    expect(found).toBeNull();
  });
});
