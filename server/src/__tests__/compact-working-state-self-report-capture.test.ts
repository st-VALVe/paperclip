import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCompactWorkingStateHandoffForFreshSession } from "../services/heartbeat.js";
import {
  buildCompactWorkingStatePacket,
  validateCompactWorkingStatePacket,
} from "../services/compact-working-state.js";
import {
  buildCompactWorkingStateSelfReportCapturePrompt,
  captureCompactWorkingStateSelfReportForFreshSession,
  parseCompactWorkingStateSelfReportCapture,
  shouldRequestCompactWorkingStateSelfReport,
} from "../services/compact-working-state-self-report.js";

const captureFlag = "paperclipRequestCompactWorkingStateSelfReport";

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
    workingNotes: "Continue by implementing controlled claude_local self-report capture.",
    acceptance: [
      {
        id: "AC1",
        text: "Explicitly flagged claude_local fresh-session continuation captures compact state.",
        status: "pending",
        assertedBy: "agent",
        verified: false,
        evidence: [],
      },
    ],
    changes: {
      files: [
        {
          path: "self-reported-production-file.ts",
          status: "modified",
          verified: true,
          evidence: [{ kind: "git_diff", ref: "git:file:self-reported-production-file.ts", verified: true }],
        },
      ],
      commits: [],
    },
    tests: {
      written: [
        {
          path: "server/src/__tests__/compact-working-state-self-report-capture.test.ts",
          kind: "unit",
          status: "added",
          verified: false,
          evidence: [],
        },
      ],
      runs: [
        {
          command: "pnpm vitest server/src/__tests__/compact-working-state-self-report-capture.test.ts",
          result: "not_run",
          assertedBy: "agent",
          verified: false,
          evidence: [],
        },
      ],
    },
    blocker: null,
    requiredHandoff: { required: false, to: null, status: "in_progress", reason: null },
    artifacts: [{ kind: "run_log", ref: "paperclip:run:self-reported-run-id:log" }],
    rawTranscriptRefs: [{ ref: "paperclip:run:self-reported-run-id:transcript", replayByDefault: false }],
    next: "Continue in the fresh session from the parsed semantic state.",
    ...overrides,
  };
}

function fence(packet: Record<string, unknown>) {
  return `\`\`\`handoff-v1\n${JSON.stringify(packet, null, 2)}\n\`\`\``;
}

function unsafeRawTranscriptPacket(key: "body" | "content" | "messages" | "transcript") {
  return fence({
    ...validCapturePacket(),
    rawTranscriptRefs: [
      {
        ref: "paperclip:run:self-reported-run-id:transcript",
        replayByDefault: false,
        [key]: key === "messages"
          ? [{ role: "assistant", content: "raw transcript text must fail closed" }]
          : "raw transcript text must fail closed",
      },
    ],
  });
}

function expectedSemanticSelfReport(packet = validCapturePacket()) {
  return {
    stage: packet.stage,
    status: packet.status,
    workingNotes: packet.workingNotes,
    acceptance: packet.acceptance,
    tests: packet.tests,
    blocker: packet.blocker,
    requiredHandoff: packet.requiredHandoff,
    next: packet.next,
  };
}

function expectStrictPacketFromSemanticSelfReport(selfReport: Record<string, unknown>) {
  const packet = buildCompactWorkingStatePacket({
    issue: {
      identifier: "PB-39",
      id: "issue-machine-id",
      objective: "Implement controlled claude_local compact state capture.",
    },
    currentRun: { id: "run-machine-id" },
    persistedSession: { id: "session-machine-id" },
    currentAgent: { role: "engineer", name: "paperclip-engineer" },
    stage: "implementation",
    selfReport,
    observedChanges: { files: [], commits: [] },
    artifacts: [],
    rawTranscriptRefs: [],
  });

  expect(() => validateCompactWorkingStatePacket(packet)).not.toThrow();
  return packet;
}

function parseSingleHandoffPacket(markdown: string) {
  expect(markdown.match(/```handoff-v1/g)).toHaveLength(1);
  expect(markdown.match(/```/g)).toHaveLength(2);
  expect(markdown).toMatch(/^```handoff-v1\n[\s\S]+\n```$/);
  return JSON.parse(markdown.slice("```handoff-v1\n".length, -"\n```".length)) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("compact working-state self-report capture prompt", () => {
  it("[BLIND] requests exactly one compact handoff-v1 packet and forbids raw transcript text", () => {
    const prompt = buildCompactWorkingStateSelfReportCapturePrompt();
    const topLevelFields =
      "v packetKind issue issueId sourceRunId sourceSessionId stage from to status objective workingNotes acceptance changes tests blocker requiredHandoff artifacts rawTranscriptRefs next".split(" ");

    expect(prompt).toMatch(/exactly one/i);
    expect(prompt).toContain("```handoff-v1");
    expect(prompt).toContain("compact_working_state");
    for (const field of topLevelFields) {
      expect(prompt).toContain(`\`${field}\``);
    }
    expect(prompt).toMatch(/raw transcript/i);
    expect(prompt).toMatch(/do not include raw transcript|no raw transcript|forbid raw transcript/i);
    expect(prompt).not.toMatch(/\bexample\b|required shape|Q:/i);
  });
});

describe("compact working-state self-report capture gate", () => {
  it("[BLIND] requires the explicit request flag before a claude_local fresh-session capture", () => {
    const freshClaudeInput = {
      adapterType: "claude_local",
      resetTaskSession: true,
      context: {
        forceFreshSession: true,
        wakeReason: "issue_assigned",
      },
    };

    expect(shouldRequestCompactWorkingStateSelfReport(freshClaudeInput)).toBe(false);
    expect(shouldRequestCompactWorkingStateSelfReport({
      ...freshClaudeInput,
      context: {
        ...freshClaudeInput.context,
        [captureFlag]: true,
      },
    })).toBe(true);
  });

  it("[BLIND] does not infer capture from adapter type, reset, resident-window telemetry, thresholds, or comments", async () => {
    const context: Record<string, unknown> = {
      forceFreshSession: true,
      wakeReason: "issue_assigned",
      commentId: "comment-1",
      residentWindowTokens: 1_000_000,
      residentWindowThreshold: 1,
      paperclipResidentWindowTelemetry: { residentWindowTokens: 1_000_000, thresholdTokens: 1 },
      paperclipSessionRotationReason: "resident-window-threshold",
    };
    const requestSelfReport = vi.fn();

    expect(shouldRequestCompactWorkingStateSelfReport({
      adapterType: "claude_local",
      resetTaskSession: true,
      context,
    })).toBe(false);

    const result = await captureCompactWorkingStateSelfReportForFreshSession({
      adapterType: "claude_local",
      resetTaskSession: true,
      context,
      requestSelfReport,
    });

    expect(result).toMatchObject({ captured: false });
    expect(requestSelfReport).not.toHaveBeenCalled();
    expect(context).not.toHaveProperty("paperclipCompactWorkingStateSelfReport");
    expect(context).not.toHaveProperty("paperclipSessionHandoffMarkdown");
  });

  it("[BLIND] does not capture for other adapters or non-fresh continuations even when the flag is present", () => {
    expect(shouldRequestCompactWorkingStateSelfReport({
      adapterType: "codex_local",
      resetTaskSession: true,
      context: { [captureFlag]: true },
    })).toBe(false);
    expect(shouldRequestCompactWorkingStateSelfReport({
      adapterType: "claude_local",
      resetTaskSession: false,
      context: { [captureFlag]: true },
    })).toBe(false);
  });
});

describe("compact working-state self-report parsing", () => {
  it("[BLIND] parses exactly one fenced packet into semantic self-report only", () => {
    const packet = validCapturePacket();
    const selfReport = parseCompactWorkingStateSelfReportCapture(fence(packet));

    expect(selfReport).toEqual(expectedSemanticSelfReport(packet));
    expectStrictPacketFromSemanticSelfReport(selfReport as Record<string, unknown>);
    expect(selfReport).not.toHaveProperty("issue");
    expect(selfReport).not.toHaveProperty("issueId");
    expect(selfReport).not.toHaveProperty("sourceRunId");
    expect(selfReport).not.toHaveProperty("sourceSessionId");
    expect(selfReport).not.toHaveProperty("from");
    expect(selfReport).not.toHaveProperty("to");
    expect(selfReport).not.toHaveProperty("changes");
    expect(selfReport).not.toHaveProperty("artifacts");
    expect(selfReport).not.toHaveProperty("rawTranscriptRefs");
  });

  it("[BLIND] canonicalizes common Claude compact packet shapes into strict packet-compatible semantics", () => {
    const packet = {
      ...validCapturePacket({
        status: "blocked",
        acceptance: ["Capture attempt reached the resumable session."],
        blocker: { reason: "Capture still needs operator review.", unblockOwner: "operator" },
        requiredHandoff: { required: false, to: "operator", status: "in_progress", reason: "No handoff needed." },
      }),
    };
    const selfReport = parseCompactWorkingStateSelfReportCapture(fence(packet));

    expect(selfReport).toMatchObject({
      status: "blocked",
      acceptance: [
        {
          id: "AC1",
          text: "Capture attempt reached the resumable session.",
          status: "pending",
          assertedBy: "agent",
          verified: false,
          evidence: [],
        },
      ],
    });
    const semanticBlocker = (selfReport as Record<string, unknown>).blocker as Record<string, unknown>;
    const semanticHandoff = (selfReport as Record<string, unknown>).requiredHandoff as Record<string, unknown>;
    expect(semanticBlocker).toEqual({
      summary: "Capture still needs operator review.",
      owner: "operator",
      evidence: [],
    });
    expect(semanticBlocker).not.toHaveProperty("reason");
    expect(semanticBlocker).not.toHaveProperty("unblockOwner");
    expect(semanticHandoff).toEqual({ required: false, to: null, status: "in_progress", reason: null });

    const strictPacket = expectStrictPacketFromSemanticSelfReport(selfReport as Record<string, unknown>);
    expect(strictPacket.blocker).toEqual(semanticBlocker);
    expect(strictPacket.requiredHandoff).toEqual(semanticHandoff);
  });

  it("[BLIND] canonicalizes a blocked packet with string blocker into strict blocker semantics", () => {
    const selfReport = parseCompactWorkingStateSelfReportCapture(fence(validCapturePacket({
      status: "blocked",
      acceptance: ["Capture reached a blocked continuation state."],
      blocker: "Waiting for operator confirmation before continuing.",
      requiredHandoff: { required: false, to: null, status: "blocked", reason: null },
    })));

    expect(selfReport).not.toBeNull();
    const semanticBlocker = (selfReport as Record<string, unknown>).blocker;
    const semanticHandoff = (selfReport as Record<string, unknown>).requiredHandoff;
    expect(semanticBlocker).toEqual({
      summary: "Waiting for operator confirmation before continuing.",
      evidence: [],
    });
    expect(typeof semanticBlocker).toBe("object");
    expect(semanticBlocker).not.toHaveProperty("reason");
    expect(semanticBlocker).not.toHaveProperty("unblockOwner");
    expect(semanticHandoff).toEqual({ required: false, to: null, status: "blocked", reason: null });

    const strictPacket = expectStrictPacketFromSemanticSelfReport(selfReport as Record<string, unknown>);
    expect(strictPacket.blocker).toEqual(semanticBlocker);
    expect(strictPacket.requiredHandoff).toEqual(semanticHandoff);
  });

  it.each([
    ["missing", ""],
    ["malformed", "not a compact packet"],
    ["wrong fence language", fence({ ...validCapturePacket(), packetKind: "compact_working_state" }).replace("handoff-v1", "json")],
    ["duplicate", `${fence(validCapturePacket())}\n\n${fence(validCapturePacket())}`],
    ["raw transcript body", unsafeRawTranscriptPacket("body")],
    ["raw transcript content", unsafeRawTranscriptPacket("content")],
    ["raw transcript messages", unsafeRawTranscriptPacket("messages")],
    ["raw transcript transcript", unsafeRawTranscriptPacket("transcript")],
  ])("[BLIND] rejects %s capture output", (_name, output) => {
    expect(parseCompactWorkingStateSelfReportCapture(output)).toBeNull();
  });
});

describe("compact working-state self-report capture orchestration", () => {
  it("[BLIND] captures once, stores the semantic self-report, and uses the existing handoff injection path", async () => {
    const context: Record<string, unknown> = { [captureFlag]: true };
    const requestSelfReport = vi.fn().mockResolvedValue(fence(validCapturePacket()));

    const result = await captureCompactWorkingStateSelfReportForFreshSession({
      adapterType: "claude_local",
      resetTaskSession: true,
      context,
      requestSelfReport,
    });

    expect(result).toMatchObject({ captured: true });
    expect(requestSelfReport).toHaveBeenCalledTimes(1);
    expect(requestSelfReport).toHaveBeenCalledWith(buildCompactWorkingStateSelfReportCapturePrompt());
    expect(context.paperclipCompactWorkingStateSelfReport).toEqual(expectedSemanticSelfReport());

    const markdown = applyCompactWorkingStateHandoffForFreshSession({
      context,
      resetTaskSession: true,
      issueRef: {
        id: "issue-machine-id",
        identifier: "PB-39",
        title: "Implement controlled claude_local compact state capture.",
      },
      run: { id: "run-machine-id", sessionIdBefore: "session-machine-id" },
      sourceSessionId: "session-machine-id",
      agent: { role: "engineer", name: "paperclip-engineer" },
    });

    expect(markdown).toBe(context.paperclipSessionHandoffMarkdown);
    const handoff = parseSingleHandoffPacket(markdown as string);
    expect(handoff.packetKind).toBe("compact_working_state");
    expect(handoff.issue).toBe("PB-39");
    expect(handoff.issueId).toBe("issue-machine-id");
    expect(handoff.sourceRunId).toBe("run-machine-id");
    expect(handoff.sourceSessionId).toBe("session-machine-id");
    expect(handoff.from).toBe("engineer");
    expect(handoff.to).toBe("engineer");
    expect(handoff.workingNotes).toBe(expectedSemanticSelfReport().workingNotes);
    expect(handoff.changes).toEqual({ files: [], commits: [] });
  });

  it.each([
    ["missing", ""],
    ["malformed", "not a compact packet"],
    ["duplicate", `${fence(validCapturePacket())}\n\n${fence(validCapturePacket())}`],
  ])("[BLIND] fails closed for %s capture without setting compact state or handoff markdown", async (_name, output) => {
    const context: Record<string, unknown> = {
      [captureFlag]: true,
      forceFreshSession: true,
      wakeReason: "issue_assigned",
      issueId: "issue-machine-id",
    };
    const requestSelfReport = vi.fn().mockResolvedValue(output);

    const result = await captureCompactWorkingStateSelfReportForFreshSession({
      adapterType: "claude_local",
      resetTaskSession: true,
      context,
      requestSelfReport,
    });

    expect(result).toMatchObject({ captured: false });
    expect(requestSelfReport).toHaveBeenCalledTimes(1);
    expect(context.forceFreshSession).toBe(true);
    expect(context.wakeReason).toBe("issue_assigned");
    expect(context.issueId).toBe("issue-machine-id");
    expect(context).not.toHaveProperty("paperclipCompactWorkingStateSelfReport");
    expect(context).not.toHaveProperty("paperclipSessionHandoffMarkdown");
  });

  it("[BLIND] does not finish the timeout path while the capture request is still pending", async () => {
    vi.useFakeTimers();
    const context: Record<string, unknown> = { [captureFlag]: true };
    let resolveSelfReport!: (value: string) => void;

    const capture = captureCompactWorkingStateSelfReportForFreshSession({
      adapterType: "claude_local",
      resetTaskSession: true,
      context,
      requestSelfReport: vi.fn(() => new Promise<string>((resolve) => {
        resolveSelfReport = resolve;
      })),
    });
    let settled = false;
    void capture.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(false);
    expect(context).not.toHaveProperty("paperclipCompactWorkingStateSelfReport");
    expect(context).not.toHaveProperty("paperclipSessionHandoffMarkdown");

    resolveSelfReport("");
    await expect(capture).resolves.toMatchObject({ captured: false });
    expect(context).not.toHaveProperty("paperclipCompactWorkingStateSelfReport");
    expect(context).not.toHaveProperty("paperclipSessionHandoffMarkdown");
  });
});
