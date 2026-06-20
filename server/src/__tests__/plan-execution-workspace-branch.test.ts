// BLIND tests (Constitution III: test author != spec author != implementer).
// Authored from `pipeline-v2/paperclip-shared-workspace-reuse.SPEC.md` ALONE,
// against Paperclip baseline 320efd0f. The fix is NOT implemented yet:
// `planExecutionWorkspaceBranch` does not exist, so these tests are RED until the
// branch-planning seam lands. Every assertion traces to a spec clause; none was
// derived from runtime output.
//
// Covers the spec "Branch-name planning seam" section and the [BLIND] acceptance
// clause:
//   "planExecutionWorkspaceBranch returns the SAME branch realizeExecutionWorkspace
//    produces for the same (issue, agent, project, workspaceStrategy, repoRef); a
//    non-git_worktree strategy -> null -> shared dedup skipped."
//
// The seam MUST reuse the SAME render+sanitize+default-template path as
// realizeExecutionWorkspace (spec: "no second hand-rolled branch rendering ... no
// drift"), so the contract is asserted as agreement between the two for identical
// inputs. The new export is expected in `../services/workspace-runtime.ts`, the
// module that already owns realizeExecutionWorkspace and its render+sanitize
// helpers.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  planExecutionWorkspaceBranch,
  realizeExecutionWorkspace,
} from "../services/workspace-runtime.ts";

const execFileAsync = promisify(execFile);
const tempDirs = new Set<string>();

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createTempRepo(defaultBranch = "main") {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plan-branch-repo-"));
  tempDirs.add(repoRoot);
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", defaultBranch]);
  return repoRoot;
}

// Identical issue/agent/project/repoRef fed to both the planner and the realizer,
// so any disagreement is a rendering/sanitization drift between the two paths.
const ISSUE = { id: "issue-1", identifier: "PAP-447", title: "Add Worktree Support" };
const AGENT = { id: "agent-1", name: "Codex Coder", companyId: "company-1" };
const PROJECT_ID = "project-1";
const REPO_REF = "HEAD";

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("planExecutionWorkspaceBranch", () => {
  it("plans null for a non-git_worktree strategy and agrees with realizeExecutionWorkspace (shared dedup skipped)", async () => {
    // Spec: "returns null for non-git_worktree strategies" / "if it is null
    // (non-git_worktree), shared dedup is skipped". The realizer's non-git_worktree
    // branch returns branchName === null with no git/fs side effects, so no repo is
    // needed here.
    const workspaceStrategy = { type: "project_primary" };

    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: os.tmpdir(),
        source: "project_primary",
        projectId: PROJECT_ID,
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: REPO_REF,
      },
      config: { workspaceStrategy },
      issue: ISSUE,
      agent: AGENT,
    });

    const planned = await planExecutionWorkspaceBranch(
      workspaceStrategy,
      ISSUE,
      AGENT,
      PROJECT_ID,
      REPO_REF,
    );

    expect(realized.branchName).toBeNull();
    expect(planned).toBeNull();
    expect(planned).toBe(realized.branchName);
  });

  it("plans the same branch realizeExecutionWorkspace creates for the default template", async () => {
    // Spec default template `{{issue.identifier}}-{{slug}}`. The planned branch must
    // equal the branch the realizer produces for the same inputs.
    const repoRoot = await createTempRepo();
    const workspaceStrategy = { type: "git_worktree", branchTemplate: "{{issue.identifier}}-{{slug}}" };

    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: PROJECT_ID,
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: REPO_REF,
      },
      config: { workspaceStrategy },
      issue: ISSUE,
      agent: AGENT,
    });

    const planned = await planExecutionWorkspaceBranch(
      workspaceStrategy,
      ISSUE,
      AGENT,
      PROJECT_ID,
      REPO_REF,
    );

    // Agreement with realizeExecutionWorkspace IS the spec criterion; the exact
    // sanitized string is realize's own (already pinned by workspace-runtime tests),
    // so we assert agreement + a non-null branch rather than re-pinning the literal.
    expect(realized.branchName).not.toBeNull();
    expect(planned).toBe(realized.branchName);
  });

  it("plans the same sanitized branch for a custom template, proving a shared render+sanitize path", async () => {
    // A custom branchTemplate with characters that sanitizeBranchName must collapse
    // (a space, a slash). If the planner hand-rolled its own rendering it would drift
    // from the realizer; the spec forbids that ("no second hand-rolled branch
    // rendering ... no drift"), so the two MUST agree.
    const repoRoot = await createTempRepo();
    const workspaceStrategy = { type: "git_worktree", branchTemplate: "{{agent.name}}/{{issue.identifier}}" };

    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: PROJECT_ID,
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: REPO_REF,
      },
      config: { workspaceStrategy },
      issue: ISSUE,
      agent: AGENT,
    });

    const planned = await planExecutionWorkspaceBranch(
      workspaceStrategy,
      ISSUE,
      AGENT,
      PROJECT_ID,
      REPO_REF,
    );

    // Agreement on a CUSTOM template proves the planner reads strategy.branchTemplate
    // and sanitizes identically: had it hard-coded the default template or hand-rolled
    // its own sanitizer, it would diverge from realize and this assertion would fail.
    expect(planned).not.toBeNull();
    expect(planned).toBe(realized.branchName);
  });
});
