import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentTaskSessions,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const adapterExecute = vi.hoisted(() => vi.fn());
const telemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const trackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => telemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "claude_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
    getRuntimeCommandSpec: () => null,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.ts";

const execFile = promisify(execFileCallback);
const captureFlag = "paperclipRequestCompactWorkingStateSelfReport";
const previousSessionId = "previous-claude-session";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres compact self-report heartbeat tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type AdapterInput = {
  runId: string;
  runtime: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
    sessionDisplayId: string | null;
  };
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
};

type TestFixture = {
  agentId: string;
  issueId: string;
  issueIdentifier: string;
  repoRoot: string;
};

function validCapturePacket(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    packetKind: "compact_working_state",
    issue: "SELF-REPORTED",
    issueId: "self-reported-issue-id",
    sourceRunId: "self-reported-run-id",
    sourceSessionId: "self-reported-session-id",
    stage: "implementation",
    from: "planner",
    to: "code-reviewer",
    status: "in_progress",
    objective: "Self-reported objective must not override machine issue data.",
    workingNotes: "Continue from the heartbeat-level compact self-report capture.",
    acceptance: [
      {
        id: "AC1",
        text: "The fresh session receives compact working-state context.",
        status: "pending",
        assertedBy: "agent",
        verified: false,
        evidence: [],
      },
    ],
    changes: { files: [], commits: [] },
    tests: {
      written: [
        {
          path: "server/src/__tests__/heartbeat-compact-working-state-self-report.test.ts",
          kind: "integration",
          status: "added",
          verified: false,
          evidence: [],
        },
      ],
      runs: [],
    },
    blocker: null,
    requiredHandoff: { required: false, to: null, status: "in_progress", reason: null },
    artifacts: [{ kind: "run_log", ref: "paperclip:run:self-reported-run-id:log" }],
    rawTranscriptRefs: [{ ref: "paperclip:run:self-reported-run-id:transcript", replayByDefault: false }],
    next: "Continue from the parsed semantic state.",
    ...overrides,
  };
}

function fence(packet: Record<string, unknown>) {
  return `\`\`\`handoff-v1\n${JSON.stringify(packet, null, 2)}\n\`\`\``;
}

function parseSingleHandoffPacket(markdown: unknown) {
  expect(typeof markdown).toBe("string");
  const value = markdown as string;
  expect(value.match(/```handoff-v1/g)).toHaveLength(1);
  return JSON.parse(value.slice("```handoff-v1\n".length, -"\n```".length)) as Record<string, unknown>;
}

function isCaptureCall(input: AdapterInput) {
  return input.config.maxTurnsPerRun === 1 && input.config.timeoutSec === 120;
}

function adapterResult(overrides: Record<string, unknown> = {}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    provider: "test",
    model: "test-model",
    ...overrides,
  };
}

async function createGitRepo(tempRoots: Set<string>) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-compact-self-report-"));
  tempRoots.add(repoRoot);
  await execFile("git", ["init"], { cwd: repoRoot });
  await execFile("git", ["config", "user.email", "paperclip-test@example.com"], { cwd: repoRoot });
  await execFile("git", ["config", "user.name", "Paperclip Test"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "compact self-report heartbeat test\n");
  await execFile("git", ["add", "README.md"], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "initial"], { cwd: repoRoot });
  return repoRoot;
}

async function waitForTerminalRun(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  await vi.waitFor(async () => {
    const latest = await heartbeat.getRun(runId);
    expect(latest?.status).toMatch(/^(succeeded|failed|cancelled|timed_out)$/);
  }, { timeout: 10_000 });
  return heartbeat.getRun(runId);
}

function hasPostgresCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === code) return true;
    current = record.cause;
  }
  return false;
}

describeEmbeddedPostgres("heartbeat compact working-state self-report capture", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-compact-self-report-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.useRealTimers();
    await waitForHeartbeatIdle();
    adapterExecute.mockReset();
    telemetryClient.track.mockClear();
    trackAgentFirstHeartbeat.mockClear();
    await truncateCompanies();
    await Promise.all(Array.from(tempRoots, (root) => rm(root, { recursive: true, force: true })));
    tempRoots.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(): Promise<TestFixture> {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issueIdentifier = `PB-${issueId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const repoRoot = await createGitRepo(tempRoots);

    await db.insert(companies).values({
      id: companyId,
      name: "Compact Self-Report Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Compact Self-Report",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: repoRoot,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared compact self-report workspace",
      status: "active",
      cwd: repoRoot,
      providerType: "local_fs",
      providerRef: repoRoot,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      title: "Implement controlled compact self-report capture",
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agentId,
      identifier: issueIdentifier,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "claude_local",
      taskKey: issueId,
      sessionParamsJson: {
        sessionId: previousSessionId,
        cwd: repoRoot,
        workspaceId: projectWorkspaceId,
      },
      sessionDisplayId: previousSessionId,
    });

    return { agentId, issueId, issueIdentifier, repoRoot };
  }

  async function waitForHeartbeatIdle() {
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      const runningAgents = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.status, "running"));
      if (activeRuns.length === 0 && runningAgents.length === 0) {
        idlePolls += 1;
        if (idlePolls >= 5) return;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function truncateCompanies() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
        return;
      } catch (error) {
        if (!hasPostgresCode(error, "40P01") || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }

  async function runHeartbeat(
    fixture: TestFixture,
    context: Record<string, unknown>,
  ) {
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(fixture.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: String(context.wakeReason ?? "issue_assigned"),
      contextSnapshot: {
        issueId: fixture.issueId,
        taskId: fixture.issueId,
        skipIssueComment: true,
        ...context,
      },
    });

    expect(run).not.toBeNull();
    const latest = await waitForTerminalRun(heartbeat, run!.id);
    expect(latest?.status).toBe("succeeded");
    await vi.waitFor(async () => {
      const [agent] = await db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, fixture.agentId));
      expect(agent?.status).not.toBe("running");
    }, { timeout: 10_000 });
    return { heartbeat, run: latest! };
  }

  it("[BLIND] captures only under the explicit flag during a fresh-session reset and injects the compact handoff", async () => {
    const fixture = await seedFixture();
    const calls: AdapterInput[] = [];
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      calls.push(input);
      if (isCaptureCall(input)) {
        return adapterResult({
          sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
          sessionDisplayId: previousSessionId,
          resultJson: { result: fence(validCapturePacket()) },
          summary: "Captured compact state.",
        });
      }
      return adapterResult({
        sessionParams: { sessionId: "fresh-claude-session", cwd: fixture.repoRoot },
        sessionDisplayId: "fresh-claude-session",
        summary: "Main fresh-session run.",
      });
    });

    const { run } = await runHeartbeat(fixture, {
      wakeReason: "issue_assigned",
      forceFreshSession: true,
      [captureFlag]: true,
    });

    expect(adapterExecute).toHaveBeenCalledTimes(2);
    expect(isCaptureCall(calls[0])).toBe(true);
    expect(isCaptureCall(calls[1])).toBe(false);
    expect(calls[0].runtime.sessionId).toBe(previousSessionId);
    expect(calls[1].runtime.sessionId).toBeNull();
    expect(calls[1].runtime.sessionParams).toBeNull();

    expect(calls[1].context.paperclipCompactWorkingStateSelfReport).toEqual({
      stage: "implementation",
      status: "in_progress",
      workingNotes: "Continue from the heartbeat-level compact self-report capture.",
      acceptance: validCapturePacket().acceptance,
      tests: validCapturePacket().tests,
      blocker: null,
      requiredHandoff: { required: false, to: null, status: "in_progress", reason: null },
      next: "Continue from the parsed semantic state.",
    });
    const handoff = parseSingleHandoffPacket(calls[1].context.paperclipSessionHandoffMarkdown);
    expect(handoff).toMatchObject({
      packetKind: "compact_working_state",
      issue: fixture.issueIdentifier,
      issueId: fixture.issueId,
      sourceRunId: run.id,
      sourceSessionId: previousSessionId,
      from: "engineer",
      to: "engineer",
      workingNotes: "Continue from the heartbeat-level compact self-report capture.",
    });
    expect(handoff.from).toBe(handoff.to);
    expect(handoff.issue).not.toBe("SELF-REPORTED");
    expect(handoff.issueId).not.toBe("self-reported-issue-id");
  }, 20_000);

  it("[BLIND] does not capture from fresh reset, claude_local, telemetry, thresholds, resident window data, or comments without the flag", async () => {
    const fixture = await seedFixture();
    const calls: AdapterInput[] = [];
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      calls.push(input);
      return adapterResult({
        sessionParams: { sessionId: "fresh-claude-session", cwd: fixture.repoRoot },
        sessionDisplayId: "fresh-claude-session",
        summary: "Main fresh-session run.",
      });
    });

    await runHeartbeat(fixture, {
      wakeReason: "issue_assigned",
      forceFreshSession: true,
      commentId: "11111111-1111-4111-8111-111111111111",
      residentWindowTokens: 1_000_000,
      residentWindowThreshold: 1,
      paperclipResidentWindowTelemetry: { residentWindowTokens: 1_000_000, thresholdTokens: 1 },
      paperclipSessionRotationReason: "resident-window-threshold",
    });

    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect(isCaptureCall(calls[0])).toBe(false);
    expect(calls[0].context).not.toHaveProperty("paperclipCompactWorkingStateSelfReport");
    expect(calls[0].context).not.toHaveProperty("paperclipSessionHandoffMarkdown");
  }, 20_000);

  it("[BLIND] does not synthesize compact handoff from stale self-report context without the flag", async () => {
    const fixture = await seedFixture();
    const calls: AdapterInput[] = [];
    const staleSelfReport = {
      stage: "implementation",
      status: "in_progress",
      workingNotes: "STALE compact self-report must not become handoff markdown.",
      acceptance: [],
      tests: { written: [], runs: [] },
      blocker: null,
      requiredHandoff: { required: false, to: null, status: "in_progress", reason: null },
      next: "STALE next step.",
    };
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      calls.push(input);
      return adapterResult({
        sessionParams: { sessionId: "fresh-claude-session", cwd: fixture.repoRoot },
        sessionDisplayId: "fresh-claude-session",
        summary: "Main fresh-session run.",
      });
    });

    await runHeartbeat(fixture, {
      wakeReason: "issue_assigned",
      forceFreshSession: true,
      paperclipCompactWorkingStateSelfReport: staleSelfReport,
      paperclipSessionHandoffMarkdown: "STALE handoff markdown must not survive.",
    });

    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect(isCaptureCall(calls[0])).toBe(false);
    expect(calls[0].runtime.sessionId).toBeNull();
    expect(calls[0].runtime.sessionParams).toBeNull();
    expect(calls[0].context).not.toHaveProperty("paperclipCompactWorkingStateSelfReport");
    expect(calls[0].context).not.toHaveProperty("paperclipSessionHandoffMarkdown");
  }, 20_000);

  it("[BLIND] does not capture when the explicit flag is present but no fresh-session reset is happening", async () => {
    const fixture = await seedFixture();
    const calls: AdapterInput[] = [];
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      calls.push(input);
      return adapterResult({
        sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: previousSessionId,
        summary: "Main same-session run.",
      });
    });

    await runHeartbeat(fixture, {
      wakeReason: "issue_commented",
      [captureFlag]: true,
    });

    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect(isCaptureCall(calls[0])).toBe(false);
    expect(calls[0].runtime.sessionId).toBe(previousSessionId);
    expect(calls[0].context).not.toHaveProperty("paperclipCompactWorkingStateSelfReport");
    expect(calls[0].context).not.toHaveProperty("paperclipSessionHandoffMarkdown");
  }, 20_000);

  it.each([
    ["missing", ""],
    ["malformed", "not a compact packet"],
    ["duplicate", `${fence(validCapturePacket())}\n\n${fence(validCapturePacket())}`],
  ])("[BLIND] preserves fresh-session execution but leaves compact handoff unset after %s capture", async (_name, output) => {
    const fixture = await seedFixture();
    const calls: AdapterInput[] = [];
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      calls.push(input);
      if (isCaptureCall(input)) {
        return adapterResult({
          sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
          sessionDisplayId: previousSessionId,
          resultJson: { result: output },
          summary: output,
        });
      }
      return adapterResult({
        sessionParams: { sessionId: "fresh-claude-session", cwd: fixture.repoRoot },
        sessionDisplayId: "fresh-claude-session",
        summary: "Main fresh-session run after failed capture.",
      });
    });

    await runHeartbeat(fixture, {
      wakeReason: "issue_assigned",
      forceFreshSession: true,
      [captureFlag]: true,
    });

    expect(adapterExecute).toHaveBeenCalledTimes(2);
    expect(isCaptureCall(calls[0])).toBe(true);
    expect(isCaptureCall(calls[1])).toBe(false);
    expect(calls[1].runtime.sessionId).toBeNull();
    expect(calls[1].runtime.sessionParams).toBeNull();
    expect(calls[1].context).not.toHaveProperty("paperclipCompactWorkingStateSelfReport");
    expect(calls[1].context).not.toHaveProperty("paperclipSessionHandoffMarkdown");
  }, 20_000);

  it("[BLIND] does not persist preliminary capture spawn metadata as the heartbeat run process", async () => {
    const fixture = await seedFixture();
    const processRowsAfterCaptureSpawn: Array<{
      processPid: number | null;
      processGroupId: number | null;
      processStartedAt: Date | null;
    } | null> = [];
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      if (isCaptureCall(input)) {
        await input.onSpawn?.({
          pid: 111,
          processGroupId: 112,
          startedAt: "2026-06-26T00:00:00.000Z",
        });
        const row = await db
          .select({
            processPid: heartbeatRuns.processPid,
            processGroupId: heartbeatRuns.processGroupId,
            processStartedAt: heartbeatRuns.processStartedAt,
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, input.runId))
          .then((rows) => rows[0] ?? null);
        processRowsAfterCaptureSpawn.push(row);
        return adapterResult({
          sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
          sessionDisplayId: previousSessionId,
          resultJson: { result: fence(validCapturePacket()) },
          summary: "Captured compact state.",
        });
      }

      await input.onSpawn?.({
        pid: 222,
        processGroupId: 223,
        startedAt: "2026-06-26T00:00:01.000Z",
      });
      return adapterResult({
        sessionParams: { sessionId: "fresh-claude-session", cwd: fixture.repoRoot },
        sessionDisplayId: "fresh-claude-session",
        summary: "Main fresh-session run.",
      });
    });

    const { run } = await runHeartbeat(fixture, {
      wakeReason: "issue_assigned",
      forceFreshSession: true,
      [captureFlag]: true,
    });

    expect(processRowsAfterCaptureSpawn).toEqual([
      { processPid: null, processGroupId: null, processStartedAt: null },
    ]);
    const finalProcess = await db
      .select({
        processPid: heartbeatRuns.processPid,
        processGroupId: heartbeatRuns.processGroupId,
        processStartedAt: heartbeatRuns.processStartedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id))
      .then((rows) => rows[0] ?? null);
    expect(finalProcess).toEqual({
      processPid: 222,
      processGroupId: 223,
      processStartedAt: new Date("2026-06-26T00:00:01.000Z"),
    });
  }, 20_000);
});
