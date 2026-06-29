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

// [BLIND] PB-39 resident-window session rotation -- rotation decision, observed
// through the heartbeat service test seam (same embedded-Postgres harness the
// existing heartbeat rotation/capture tests use).
//
// Source of truth: specs/001-paperbridge-pipeline-v2/pb39-resident-window-rotation.spec.md.
// The resident-window signal the engine reads is the prior run's
// usageJson.residentWindowTokens (spec section 1). The rotation outcome is
// observable as: the adapter run's resumed session id (null => rotated into a
// fresh session; previous id => continued current session), the rotation
// context fields (paperclipSessionRotationReason / paperclipSessionHandoffMarkdown),
// the fail-closed safe markers (paperclipResidentWindowRotationDeferred /
// paperclipResidentWindowCaptureFailureCount / paperclipResidentWindowCaptureExhausted,
// spec section 4 "Observable markers"), and the persisted run usageJson
// (sessionRotated / sessionRotationReason).
//
// Per spec section 5/7 the production default (112000) and K (3) are tuning
// values: these tests set an explicit TEST threshold and assert BEHAVIOUR
// relative to it, never the production tuning number.

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
const previousSessionId = "previous-claude-session";
const freshSessionId = "fresh-claude-session";

// Explicit TEST threshold. NOT the production tuning value. Behaviour is asserted
// relative to this number only.
const TEST_RESIDENT_THRESHOLD = 1_000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres resident-window rotation heartbeat tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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
};

type TestFixture = {
  agentId: string;
  companyId: string;
  issueId: string;
  issueIdentifier: string;
  repoRoot: string;
};

type SeedOverrides = {
  runtimeConfig?: Record<string, unknown>;
  priorResidentWindowTokens?: number | string | null;
  priorRawInputTokens?: number;
  priorRunCount?: number;
};

function isCaptureCall(input: AdapterInput) {
  // Capture invocations are the bounded single-turn self-report probe
  // (see the existing compact self-report harness).
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
    workingNotes: "Continue from the resident-window rotation compact packet.",
    acceptance: [
      {
        id: "AC1",
        text: "The rotated session continues from compact working state.",
        status: "pending",
        assertedBy: "agent",
        verified: false,
        evidence: [],
      },
    ],
    changes: { files: [], commits: [] },
    tests: { written: [], runs: [] },
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
  expect(value.match(/```/g)).toHaveLength(2);
  return JSON.parse(value.slice("```handoff-v1\n".length, -"\n```".length)) as Record<string, unknown>;
}

/** Is the reported rotation reason a resident-window reason (spec's own term)? */
function isResidentWindowReason(reason: unknown): boolean {
  return typeof reason === "string" && /resident.?window/i.test(reason);
}

/** Count of capture-probe adapter invocations recorded on the mock so far. */
function countCaptureCalls(): number {
  return adapterExecute.mock.calls.filter((args) => isCaptureCall(args[0] as AdapterInput)).length;
}

/**
 * Context of the most recent main (non-capture) adapter invocation recorded on
 * the mock. The marker context fields persist across wakes, so the latest main
 * call carries the markers observed after the most recent wake.
 */
function lastMainCallContext(): Record<string, unknown> {
  const mainCalls = adapterExecute.mock.calls.filter((args) => !isCaptureCall(args[0] as AdapterInput));
  const last = mainCalls[mainCalls.length - 1]?.[0] as AdapterInput | undefined;
  expect(last).toBeDefined();
  return last!.context;
}

async function createGitRepo(tempRoots: Set<string>) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-resident-window-"));
  tempRoots.add(repoRoot);
  await execFile("git", ["init"], { cwd: repoRoot });
  await execFile("git", ["config", "user.email", "paperclip-test@example.com"], { cwd: repoRoot });
  await execFile("git", ["config", "user.name", "Paperclip Test"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "resident-window rotation heartbeat test\n");
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

describeEmbeddedPostgres("[BLIND] PB-39 heartbeat resident-window session rotation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resident-window-");
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

  async function seedFixture(overrides: SeedOverrides = {}): Promise<TestFixture> {
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
      name: "Resident Window Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Resident Window",
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
      runtimeConfig: overrides.runtimeConfig ?? {},
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
      name: "Shared resident-window workspace",
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
      title: "Continue controlled claude_local resident-window task",
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

    // Seed prior completed run(s) for this session carrying the resident-window
    // signal the engine reads (usageJson.residentWindowTokens). Runs are linked
    // to the resumed session via sessionIdAfter (spec section 1: the engine reads
    // latestRun.usageJson for the session).
    const priorRunCount = overrides.priorRunCount ?? 1;
    const base = Date.now() - priorRunCount * 60_000;
    for (let i = 0; i < priorRunCount; i += 1) {
      const usageJson: Record<string, unknown> = {};
      if (overrides.priorResidentWindowTokens !== undefined) {
        usageJson.residentWindowTokens = overrides.priorResidentWindowTokens;
      }
      if (overrides.priorRawInputTokens !== undefined) {
        usageJson.inputTokens = overrides.priorRawInputTokens;
        usageJson.rawInputTokens = overrides.priorRawInputTokens;
      }
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        invocationSource: "automation",
        status: "succeeded",
        sessionIdBefore: previousSessionId,
        sessionIdAfter: previousSessionId,
        usageJson: Object.keys(usageJson).length > 0 ? usageJson : null,
        startedAt: new Date(base + i * 1_000),
        finishedAt: new Date(base + i * 1_000 + 500),
        createdAt: new Date(base + i * 1_000),
        updatedAt: new Date(base + i * 1_000 + 500),
      });
    }

    return { agentId, companyId, issueId, issueIdentifier, repoRoot };
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

  /**
   * Wake the agent on a session-resuming wake (NOT forceFreshSession) so the
   * automatic resident-window rotation decision is what is exercised.
   */
  async function runHeartbeat(fixture: TestFixture, context: Record<string, unknown> = {}) {
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(fixture.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: String(context.wakeReason ?? "issue_commented"),
      contextSnapshot: {
        issueId: fixture.issueId,
        taskId: fixture.issueId,
        skipIssueComment: true,
        ...context,
      },
    });

    expect(run).not.toBeNull();
    const latest = await waitForTerminalRun(heartbeat, run!.id);
    await vi.waitFor(async () => {
      const [agent] = await db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, fixture.agentId));
      expect(agent?.status).not.toBe("running");
    }, { timeout: 10_000 });
    return { heartbeat, run: latest! };
  }

  function thresholdRuntimeConfig(maxResidentWindowTokens: number) {
    return { heartbeat: { sessionCompaction: { maxResidentWindowTokens } } };
  }

  // ---- B4: below threshold => no rotate -------------------------------------
  it("[BLIND] does not rotate when residentWindowTokens is below the threshold (B4)", async () => {
    const fixture = await seedFixture({
      runtimeConfig: thresholdRuntimeConfig(TEST_RESIDENT_THRESHOLD),
      priorResidentWindowTokens: TEST_RESIDENT_THRESHOLD - 1,
    });
    const calls: AdapterInput[] = [];
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      calls.push(input);
      return adapterResult({
        sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: previousSessionId,
        summary: "Continued current session.",
      });
    });

    const { run } = await runHeartbeat(fixture);

    const mainCall = calls.find((c) => !isCaptureCall(c))!;
    // No rotation => the run continues the current session, not a fresh one.
    expect(mainCall.runtime.sessionId).toBe(previousSessionId);
    expect(mainCall.context).not.toHaveProperty("paperclipSessionRotationReason");
    expect(run.usageJson?.sessionRotated).toBe(false);
    expect(run.usageJson?.sessionRotationReason ?? null).toBeNull();
  }, 20_000);

  // ---- B5: at/over threshold => rotate with resident-window reason ----------
  it("[BLIND] rotates with a resident-window reason when residentWindowTokens >= threshold (B5)", async () => {
    const fixture = await seedFixture({
      runtimeConfig: thresholdRuntimeConfig(TEST_RESIDENT_THRESHOLD),
      // exactly at the threshold exercises the spec's >= semantics (section 4).
      priorResidentWindowTokens: TEST_RESIDENT_THRESHOLD,
    });
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
        sessionParams: { sessionId: freshSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: freshSessionId,
        summary: "Rotated into a fresh session.",
      });
    });

    const { run } = await runHeartbeat(fixture);

    const mainCall = calls.find((c) => !isCaptureCall(c))!;
    // Rotation => the run starts a fresh session (no resumed session id).
    expect(mainCall.runtime.sessionId).toBeNull();
    expect(mainCall.context.paperclipSessionRotationReason).toBeTruthy();
    expect(isResidentWindowReason(mainCall.context.paperclipSessionRotationReason)).toBe(true);
    expect(run.usageJson?.sessionRotated).toBe(true);
    expect(isResidentWindowReason(run.usageJson?.sessionRotationReason)).toBe(true);
  }, 20_000);

  it("[BLIND] reports the raw-input reason over resident-window when both trip (precedence: rawInput before resident) (B5)", async () => {
    // Spec section 4 precedence: maxSessionRuns -> maxRawInputTokens ->
    // maxResidentWindowTokens -> maxSessionAgeHours. Raw-input precedes resident.
    const rawThreshold = 500_000;
    const fixture = await seedFixture({
      runtimeConfig: {
        heartbeat: {
          sessionCompaction: {
            maxResidentWindowTokens: TEST_RESIDENT_THRESHOLD,
            maxRawInputTokens: rawThreshold,
          },
        },
      },
      priorResidentWindowTokens: TEST_RESIDENT_THRESHOLD,
      priorRawInputTokens: rawThreshold,
    });
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
        sessionParams: { sessionId: freshSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: freshSessionId,
        summary: "Rotated into a fresh session.",
      });
    });

    const { run } = await runHeartbeat(fixture);

    const mainCall = calls.find((c) => !isCaptureCall(c))!;
    // Still rotates, but the reported reason is the higher-precedence one (not resident).
    expect(mainCall.runtime.sessionId).toBeNull();
    expect(run.usageJson?.sessionRotated).toBe(true);
    expect(run.usageJson?.sessionRotationReason).toBeTruthy();
    expect(isResidentWindowReason(run.usageJson?.sessionRotationReason)).toBe(false);
  }, 20_000);

  // ---- B6: missing / zero / non-numeric signal => no rotate ----------------
  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["non-numeric", "not-a-number"],
  ])("[BLIND] does not rotate on resident-window when the signal is %s (B6)", async (_name, signal) => {
    const fixture = await seedFixture({
      runtimeConfig: thresholdRuntimeConfig(TEST_RESIDENT_THRESHOLD),
      priorResidentWindowTokens: signal as number | string | undefined,
    });
    const calls: AdapterInput[] = [];
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      calls.push(input);
      return adapterResult({
        sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: previousSessionId,
        summary: "Continued current session.",
      });
    });

    const { run } = await runHeartbeat(fixture);

    const mainCall = calls.find((c) => !isCaptureCall(c))!;
    expect(mainCall.runtime.sessionId).toBe(previousSessionId);
    expect(run.usageJson?.sessionRotated).toBe(false);
    expect(isResidentWindowReason(run.usageJson?.sessionRotationReason)).toBe(false);
  }, 20_000);

  // ---- B7: fail-closed capture when a resident rotation is due => no rotate -
  // Spec section 4 "Observable markers" + B7: a failed capture suppresses the
  // resident rotation (continue current session, no compact handoff markdown),
  // sets context.paperclipResidentWindowRotationDeferred === true, and
  // increments context.paperclipResidentWindowCaptureFailureCount (per-session
  // consecutive-failure count, persisted across wakes).
  it("[BLIND] does not rotate into a fresh session when the compact capture fails closed (B7)", async () => {
    const fixture = await seedFixture({
      runtimeConfig: thresholdRuntimeConfig(TEST_RESIDENT_THRESHOLD),
      priorResidentWindowTokens: TEST_RESIDENT_THRESHOLD,
    });
    const calls: AdapterInput[] = [];
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      calls.push(input);
      if (isCaptureCall(input)) {
        // Fail closed: capture yields nothing parseable.
        return adapterResult({
          sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
          sessionDisplayId: previousSessionId,
          resultJson: { result: "" },
          summary: "",
        });
      }
      return adapterResult({
        sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: previousSessionId,
        summary: "Continued current session after fail-closed capture.",
      });
    });

    const { run } = await runHeartbeat(fixture);

    const mainCall = calls.find((c) => !isCaptureCall(c))!;
    // Fail-closed capture must NOT rotate into an empty/fresh session.
    expect(mainCall.runtime.sessionId).toBe(previousSessionId);
    expect(mainCall.context).not.toHaveProperty("paperclipSessionHandoffMarkdown");
    expect(run.usageJson?.sessionRotated).toBe(false);
    // Safe deferral marker present (spec section 4 "Observable markers").
    expect(mainCall.context.paperclipResidentWindowRotationDeferred).toBe(true);
    // Consecutive-failure count incremented (>= 1 after the first fail-closed wake).
    expect(typeof mainCall.context.paperclipResidentWindowCaptureFailureCount).toBe("number");
    expect(mainCall.context.paperclipResidentWindowCaptureFailureCount as number).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it("[BLIND] increments the per-session failure count across consecutive fail-closed wakes (B7)", async () => {
    // Spec B7 / section 4: the count is a per-session CONSECUTIVE-failure count
    // that persists across wakes. Two consecutive fail-closed wakes => the count
    // observed on the later wake is strictly greater than on the earlier wake.
    const fixture = await seedFixture({
      runtimeConfig: thresholdRuntimeConfig(TEST_RESIDENT_THRESHOLD),
      priorResidentWindowTokens: TEST_RESIDENT_THRESHOLD,
    });
    adapterExecute.mockImplementation(async (input: AdapterInput) =>
      isCaptureCall(input)
        ? adapterResult({
            sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: previousSessionId,
            resultJson: { result: "" },
            summary: "",
          })
        : adapterResult({
            sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: previousSessionId,
            summary: "Continued current session after fail-closed capture.",
          }),
    );

    await runHeartbeat(fixture);
    const countAfterFirst = lastMainCallContext().paperclipResidentWindowCaptureFailureCount as number;
    await runHeartbeat(fixture);
    const countAfterSecond = lastMainCallContext().paperclipResidentWindowCaptureFailureCount as number;

    expect(countAfterFirst).toBeGreaterThanOrEqual(1);
    expect(countAfterSecond).toBeGreaterThan(countAfterFirst);
  }, 40_000);

  // ---- B7a: bounded capture retry across K fail-closed wakes ----------------
  // Spec B7a + section 4: after K consecutive fail-closed captures on an
  // over-threshold session, no further capture attempt that wake-loop,
  // context.paperclipResidentWindowCaptureExhausted === true, still no rotate.
  it("[BLIND] marks capture exhausted and stops attempting capture after K consecutive fail-closed captures (B7a)", async () => {
    const K = 3; // spec: K is a small constant (owner-approved default 3).
    const fixture = await seedFixture({
      runtimeConfig: thresholdRuntimeConfig(TEST_RESIDENT_THRESHOLD),
      priorResidentWindowTokens: TEST_RESIDENT_THRESHOLD,
    });

    // Each wake fails the capture closed; the over-threshold session keeps running.
    adapterExecute.mockImplementation(async (input: AdapterInput) =>
      isCaptureCall(input)
        ? adapterResult({
            sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: previousSessionId,
            resultJson: { result: "" },
            summary: "",
          })
        : adapterResult({
            sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: previousSessionId,
            summary: "Continued current session after fail-closed capture.",
          }),
    );

    // Drive K wakes that each fail capture closed.
    for (let i = 0; i < K; i += 1) {
      await runHeartbeat(fixture);
    }
    const captureCallsThroughK = countCaptureCalls();
    expect(captureCallsThroughK).toBe(K);

    // The (K+1)-th wake on the still-over-threshold session must make no further
    // capture attempt and must still not rotate; exhaustion marker is set.
    const { run } = await runHeartbeat(fixture);

    expect(countCaptureCalls()).toBe(K);
    expect(run.usageJson?.sessionRotated).toBe(false);
    expect(lastMainCallContext().paperclipResidentWindowCaptureExhausted).toBe(true);
  }, 60_000);

  it("[BLIND] resets the failure count and clears exhaustion when a capture succeeds (B7a reset: capture success)", async () => {
    const fixture = await seedFixture({
      runtimeConfig: thresholdRuntimeConfig(TEST_RESIDENT_THRESHOLD),
      priorResidentWindowTokens: TEST_RESIDENT_THRESHOLD,
    });

    // First wake: capture fails closed (count becomes >= 1).
    adapterExecute.mockImplementation(async (input: AdapterInput) =>
      isCaptureCall(input)
        ? adapterResult({
            sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: previousSessionId,
            resultJson: { result: "" },
            summary: "",
          })
        : adapterResult({
            sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: previousSessionId,
            summary: "Continued current session after fail-closed capture.",
          }),
    );
    await runHeartbeat(fixture);
    expect(lastMainCallContext().paperclipResidentWindowCaptureFailureCount as number).toBeGreaterThanOrEqual(1);

    // Next wake: capture SUCCEEDS (rotation proceeds with the compact packet).
    adapterExecute.mockReset();
    adapterExecute.mockImplementation(async (input: AdapterInput) =>
      isCaptureCall(input)
        ? adapterResult({
            sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: previousSessionId,
            resultJson: { result: fence(validCapturePacket()) },
            summary: "Captured compact state.",
          })
        : adapterResult({
            sessionParams: { sessionId: freshSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: freshSessionId,
            summary: "Rotated into a fresh session.",
          }),
    );
    await runHeartbeat(fixture);

    const ctx = lastMainCallContext();
    // Counter reset to 0, exhaustion cleared on capture success (spec B7a).
    expect((ctx.paperclipResidentWindowCaptureFailureCount as number | undefined) ?? 0).toBe(0);
    expect((ctx.paperclipResidentWindowCaptureExhausted as boolean | undefined) ?? false).toBe(false);
  }, 40_000);

  it("[BLIND] resets the failure count and clears exhaustion when the session id changes (B7a reset: session-id change)", async () => {
    const K = 3;
    const fixture = await seedFixture({
      runtimeConfig: thresholdRuntimeConfig(TEST_RESIDENT_THRESHOLD),
      priorResidentWindowTokens: TEST_RESIDENT_THRESHOLD,
    });

    // Accumulate K fail-closed captures on the previous session (=> exhausted).
    adapterExecute.mockImplementation(async (input: AdapterInput) =>
      isCaptureCall(input)
        ? adapterResult({
            sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: previousSessionId,
            resultJson: { result: "" },
            summary: "",
          })
        : adapterResult({
            sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: previousSessionId,
            summary: "Continued current session after fail-closed capture.",
          }),
    );
    for (let i = 0; i < K; i += 1) {
      await runHeartbeat(fixture);
    }
    expect(lastMainCallContext().paperclipResidentWindowCaptureExhausted).toBe(true);

    // The session id changes: point the task session + a fresh below-threshold
    // prior run at a NEW session id. The per-session counter is keyed on the
    // session, so the new session starts clean (spec B7a reset: session-id change).
    const newSessionId = "rotated-claude-session";
    await db
      .update(agentTaskSessions)
      .set({
        sessionDisplayId: newSessionId,
        sessionParamsJson: { sessionId: newSessionId, cwd: fixture.repoRoot },
      })
      .where(eq(agentTaskSessions.agentId, fixture.agentId));
    await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "automation",
      status: "succeeded",
      sessionIdBefore: newSessionId,
      sessionIdAfter: newSessionId,
      usageJson: { residentWindowTokens: TEST_RESIDENT_THRESHOLD - 1 },
      startedAt: new Date(),
      finishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    adapterExecute.mockReset();
    adapterExecute.mockImplementation(async (input: AdapterInput) =>
      adapterResult({
        sessionParams: { sessionId: newSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: newSessionId,
        summary: "Continued the new session.",
      }),
    );
    await runHeartbeat(fixture);

    const ctx = lastMainCallContext();
    expect((ctx.paperclipResidentWindowCaptureFailureCount as number | undefined) ?? 0).toBe(0);
    expect((ctx.paperclipResidentWindowCaptureExhausted as boolean | undefined) ?? false).toBe(false);
  }, 60_000);

  it("[BLIND] resets the failure count and clears exhaustion when the session is no longer over threshold (B7a reset: below-threshold)", async () => {
    const K = 3;
    const fixture = await seedFixture({
      runtimeConfig: thresholdRuntimeConfig(TEST_RESIDENT_THRESHOLD),
      priorResidentWindowTokens: TEST_RESIDENT_THRESHOLD,
    });

    // Accumulate K fail-closed captures on the over-threshold session (=> exhausted).
    adapterExecute.mockImplementation(async (input: AdapterInput) =>
      isCaptureCall(input)
        ? adapterResult({
            sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: previousSessionId,
            resultJson: { result: "" },
            summary: "",
          })
        : adapterResult({
            sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
            sessionDisplayId: previousSessionId,
            summary: "Continued current session after fail-closed capture.",
          }),
    );
    for (let i = 0; i < K; i += 1) {
      await runHeartbeat(fixture);
    }
    expect(lastMainCallContext().paperclipResidentWindowCaptureExhausted).toBe(true);

    // The session is no longer over threshold: a fresh below-threshold prior run
    // becomes the latest for the SAME session id. No rotation is due, so the
    // per-session counter resets (spec B7a reset: no-longer-over-threshold).
    await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "automation",
      status: "succeeded",
      sessionIdBefore: previousSessionId,
      sessionIdAfter: previousSessionId,
      usageJson: { residentWindowTokens: TEST_RESIDENT_THRESHOLD - 1 },
      startedAt: new Date(),
      finishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    adapterExecute.mockReset();
    adapterExecute.mockImplementation(async (input: AdapterInput) =>
      adapterResult({
        sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: previousSessionId,
        summary: "Continued current session below threshold.",
      }),
    );
    const { run } = await runHeartbeat(fixture);

    const ctx = lastMainCallContext();
    expect(run.usageJson?.sessionRotated).toBe(false);
    expect((ctx.paperclipResidentWindowCaptureFailureCount as number | undefined) ?? 0).toBe(0);
    expect((ctx.paperclipResidentWindowCaptureExhausted as boolean | undefined) ?? false).toBe(false);
  }, 60_000);

  // ---- B8: successful rotation => handoff is the fenced compact packet -------
  it("[BLIND] uses the compact working-state packet (fenced handoff-v1) as the rotation handoff (B8)", async () => {
    const fixture = await seedFixture({
      runtimeConfig: thresholdRuntimeConfig(TEST_RESIDENT_THRESHOLD),
      priorResidentWindowTokens: TEST_RESIDENT_THRESHOLD + 5_000,
    });
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
        sessionParams: { sessionId: freshSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: freshSessionId,
        summary: "Rotated into a fresh session.",
      });
    });

    await runHeartbeat(fixture);

    const mainCall = calls.find((c) => !isCaptureCall(c))!;
    expect(mainCall.runtime.sessionId).toBeNull();
    // Handoff must be exactly one fenced handoff-v1 compact working-state packet,
    // not the plain-text continuation summary.
    const handoff = parseSingleHandoffPacket(mainCall.context.paperclipSessionHandoffMarkdown);
    expect(handoff.packetKind).toBe("compact_working_state");
    expect(handoff.issue).toBe(fixture.issueIdentifier);
    expect(handoff.issueId).toBe(fixture.issueId);
  }, 20_000);

  // ---- B9: existing triggers still fire (regression) ------------------------
  it("[BLIND] still rotates on the existing maxSessionRuns trigger (B9)", async () => {
    const fixture = await seedFixture({
      runtimeConfig: { heartbeat: { sessionCompaction: { maxSessionRuns: 2 } } },
      priorRunCount: 3, // strictly exceeds the 2-run threshold
    });
    const calls: AdapterInput[] = [];
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      calls.push(input);
      return adapterResult({
        sessionParams: { sessionId: freshSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: freshSessionId,
        summary: "Rotated into a fresh session on runs threshold.",
      });
    });

    const { run } = await runHeartbeat(fixture);

    const mainCall = calls.find((c) => !isCaptureCall(c))!;
    expect(mainCall.runtime.sessionId).toBeNull();
    expect(run.usageJson?.sessionRotated).toBe(true);
    expect(run.usageJson?.sessionRotationReason).toBeTruthy();
  }, 20_000);

  it("[BLIND] still rotates on the existing maxRawInputTokens trigger (B9)", async () => {
    const rawThreshold = 500_000;
    const fixture = await seedFixture({
      runtimeConfig: { heartbeat: { sessionCompaction: { maxRawInputTokens: rawThreshold } } },
      priorRawInputTokens: rawThreshold,
    });
    const calls: AdapterInput[] = [];
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      calls.push(input);
      return adapterResult({
        sessionParams: { sessionId: freshSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: freshSessionId,
        summary: "Rotated into a fresh session on raw-input threshold.",
      });
    });

    const { run } = await runHeartbeat(fixture);

    const mainCall = calls.find((c) => !isCaptureCall(c))!;
    expect(mainCall.runtime.sessionId).toBeNull();
    expect(run.usageJson?.sessionRotated).toBe(true);
    expect(isResidentWindowReason(run.usageJson?.sessionRotationReason)).toBe(false);
  }, 20_000);

  // ---- B10: rotation preserves task/role identity and disposition -----------
  it("[BLIND] does not mutate assigneeAgentId, role, or disposition on a resident-window rotation (B10)", async () => {
    const fixture = await seedFixture({
      runtimeConfig: thresholdRuntimeConfig(TEST_RESIDENT_THRESHOLD),
      priorResidentWindowTokens: TEST_RESIDENT_THRESHOLD,
    });
    const [issueBefore] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.issueId));
    const [agentBefore] = await db
      .select({ role: agents.role })
      .from(agents)
      .where(eq(agents.id, fixture.agentId));

    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      if (isCaptureCall(input)) {
        return adapterResult({
          sessionParams: { sessionId: previousSessionId, cwd: fixture.repoRoot },
          sessionDisplayId: previousSessionId,
          resultJson: { result: fence(validCapturePacket()) },
          summary: "Captured compact state.",
        });
      }
      return adapterResult({
        sessionParams: { sessionId: freshSessionId, cwd: fixture.repoRoot },
        sessionDisplayId: freshSessionId,
        summary: "Rotated into a fresh session.",
      });
    });

    const { run } = await runHeartbeat(fixture);
    expect(run.usageJson?.sessionRotated).toBe(true);

    const [issueAfter] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.issueId));
    const [agentAfter] = await db
      .select({ role: agents.role })
      .from(agents)
      .where(eq(agents.id, fixture.agentId));

    // Rotation resets the Claude session only -- task/role identity and
    // disposition are preserved (spec section 4 "No gate bypass" + B10).
    expect(issueAfter.assigneeAgentId).toBe(issueBefore.assigneeAgentId);
    expect(issueAfter.assigneeAgentId).toBe(fixture.agentId);
    expect(issueAfter.status).toBe(issueBefore.status);
    expect(agentAfter.role).toBe(agentBefore.role);
  }, 20_000);
});
