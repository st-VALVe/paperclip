import { describe, expect, it } from "vitest";
import {
  buildCompactWorkingStatePacket,
  isStaleCompactWorkingStatePacket,
  validateCompactWorkingStatePacket,
} from "../services/compact-working-state.js";

function validSameRoleCompactPacket(overrides: Record<string, unknown> = {}) {
  return {
    sourceRunId: "92a19da5-0000-0000-0000-000000000000",
    sourceSessionId: "4bb94f0e",
    acceptance: [
      {
        id: "AC1",
        text: "Resident-window telemetry is persisted on heartbeat runs.",
        status: "pending",
        assertedBy: "agent",
        verified: false,
        evidence: [],
      },
    ],
    changes: { files: [], commits: [] },
    tests: { written: [], runs: [] },
    requiredHandoff: { required: false, to: null, status: "in_progress", reason: null },
    artifacts: [{ kind: "run_log", ref: "paperclip:run:92a19da5:log" }],
    rawTranscriptRefs: [{ ref: "paperclip:run:92a19da5:transcript", replayByDefault: false }],
    ...overrides,
  };
}

function validContractPacket(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    packetKind: "compact_working_state",
    issue: "PB-81",
    issueId: "8b5a9a0b-0000-0000-0000-000000000000",
    stage: "implementation",
    from: "engineer",
    to: "engineer",
    status: "in_progress",
    objective: "Implement the scoped fix for PB-81.",
    workingNotes: "Current approach: keep the change scoped to telemetry parsing.",
    blocker: null,
    next: "Continue implementation from the listed working notes and acceptance state.",
    ...validSameRoleCompactPacket({
      changes: {
        files: [
          {
            path: "server/src/services/heartbeat.ts",
            status: "modified",
            verified: true,
            evidence: [{ kind: "git_diff", ref: "git:file:server/src/services/heartbeat.ts", verified: true }],
          },
        ],
        commits: [],
      },
      tests: {
        written: [
          {
            path: "server/src/__tests__/heartbeat-usage-telemetry.test.ts",
            kind: "unit",
            status: "added",
            verified: true,
            evidence: [
              {
                kind: "git_diff",
                ref: "git:file:server/src/__tests__/heartbeat-usage-telemetry.test.ts",
                verified: true,
              },
            ],
          },
        ],
        runs: [
          {
            command: "pnpm vitest server/src/__tests__/heartbeat-usage-telemetry.test.ts",
            result: "not_run",
            assertedBy: "agent",
            verified: false,
            evidence: [],
          },
        ],
      },
    }),
    ...overrides,
  };
}

function blockedContractPacket() {
  const packet = validContractPacket({
    status: "blocked",
    blocker: {
      summary: "Waiting for owner confirmation on scope.",
      owner: "owner",
      evidence: [{ kind: "comment", ref: "paperclip:comment:12345", verified: true }],
    },
  }) as Record<string, unknown>;
  (packet.requiredHandoff as Record<string, unknown>).status = "blocked";
  return packet;
}

function requiredHandoffContractPacket() {
  const packet = validContractPacket() as Record<string, unknown>;
  packet.requiredHandoff = {
    required: true,
    to: "code-reviewer",
    status: "in_progress",
    reason: "Implementation is ready for code review.",
  };
  return packet;
}

function assertedOnlyContractPacket() {
  const packet = validContractPacket() as Record<string, any>;
  packet.acceptance[0].status = "asserted_passed";
  packet.acceptance[0].verified = false;
  packet.acceptance[0].evidence = [];
  packet.tests.runs[0].result = "asserted_passed";
  packet.tests.runs[0].verified = false;
  packet.tests.runs[0].evidence = [];
  return packet;
}

function verifiedContractPacket() {
  const packet = validContractPacket() as Record<string, any>;
  const evidence = { kind: "test_command", ref: "paperclip:run:92a19da5:event:7", verified: true };
  packet.acceptance[0].status = "verified_passed";
  packet.acceptance[0].verified = true;
  packet.acceptance[0].evidence = [evidence];
  packet.tests.runs[0].result = "verified_passed";
  packet.tests.runs[0].verified = true;
  packet.tests.runs[0].evidence = [evidence];
  return packet;
}

const compactWorkingStateFixtureCorpus = [
  { name: "valid same-role compact packet", valid: true, build: validContractPacket },
  { name: "valid blocked compact packet", valid: true, build: blockedContractPacket },
  { name: "compact packet with future requiredHandoff", valid: true, build: requiredHandoffContractPacket },
  {
    name: "packet missing packetKind",
    valid: false,
    build: () => {
      const packet = validContractPacket() as Record<string, unknown>;
      delete packet.packetKind;
      return packet;
    },
  },
  { name: "packet with status blocked and blocker null", valid: false, build: () => validContractPacket({ status: "blocked" }) },
  { name: "packet with asserted passing tests and no verified evidence", valid: true, build: assertedOnlyContractPacket },
  { name: "packet with verified passing tests and valid evidence refs", valid: true, build: verifiedContractPacket },
  {
    name: "packet with renamed file and no previousPath",
    valid: true,
    build: () => {
      const packet = validContractPacket() as Record<string, any>;
      packet.changes.files[0] = {
        path: "server/src/services/compact-working-state.ts",
        status: "renamed",
        verified: false,
        evidence: [],
      };
      return packet;
    },
  },
  {
    name: "packet with raw transcript body",
    valid: false,
    build: () => {
      const packet = validContractPacket() as Record<string, any>;
      packet.rawTranscriptRefs[0].body = "raw transcript text";
      return packet;
    },
  },
  { name: "packet with oversized workingNotes", valid: false, build: () => validContractPacket({ workingNotes: "x".repeat(1501) }) },
  { name: "stale-source packet", valid: true, build: () => validContractPacket({ sourceRunId: "stale-run", sourceSessionId: "stale-session" }) },
];

function validBuilderInput(overrides: Record<string, unknown> = {}) {
  const packet = validSameRoleCompactPacket();
  return {
    issue: {
      identifier: "PB-81",
      id: "8b5a9a0b-0000-0000-0000-000000000000",
      objective: "Implement the scoped fix for PB-81.",
    },
    currentRun: { id: "92a19da5-0000-0000-0000-000000000000" },
    persistedSession: { id: "4bb94f0e" },
    currentAgent: { role: "engineer", name: "pipeline-engineer" },
    stage: "implementation",
    selfReport: {
      from: "engineer",
      to: "engineer",
      workingNotes: "Current approach: keep the change scoped to telemetry parsing.",
      acceptance: packet.acceptance,
      tests: packet.tests,
      blocker: null,
      requiredHandoff: packet.requiredHandoff,
      next: "Continue implementation from the listed working notes and acceptance state.",
    },
    observedChanges: packet.changes,
    artifacts: packet.artifacts,
    rawTranscriptRefs: packet.rawTranscriptRefs,
    ...overrides,
  };
}

describe("compact working-state builder provenance", () => {
  it("[BLIND] validates the compact working-state fixture corpus", () => {
    for (const fixture of compactWorkingStateFixtureCorpus) {
      const packet = fixture.build();
      if (fixture.valid) {
        expect(() => validateCompactWorkingStatePacket(packet)).not.toThrow();
      } else {
        expect(() => validateCompactWorkingStatePacket(packet)).toThrow();
      }
    }
  });

  it("[BLIND] derives same-role from/to from the current agent role, not self-report", () => {
    const packet = buildCompactWorkingStatePacket(validBuilderInput({
      currentAgent: { role: "engineer", name: "pipeline-engineer" },
      selfReport: {
        ...(validBuilderInput().selfReport as Record<string, unknown>),
        from: "planner",
        to: "planner",
      },
    }));

    expect(packet.from).toBe("engineer");
    expect(packet.to).toBe("engineer");
  });

  it("[BLIND] does not derive continuation role from agent.name", () => {
    const packet = buildCompactWorkingStatePacket(validBuilderInput({
      currentAgent: { role: "code-reviewer", name: "engineer" },
      selfReport: {
        ...(validBuilderInput().selfReport as Record<string, unknown>),
        from: "engineer",
        to: "engineer",
      },
    }));

    expect(packet.from).toBe("code-reviewer");
    expect(packet.to).toBe("code-reviewer");
  });

  it("[BLIND] builds sourceSessionId from the persisted session identity Paperclip would resume", () => {
    const packet = buildCompactWorkingStatePacket(validBuilderInput({
      persistedSession: { id: "persisted-session-42" },
      artifacts: [{ kind: "run_log", ref: "paperclip:run:artifact-session-99:log" }],
    }));

    expect(packet.sourceSessionId).toBe("persisted-session-42");
  });

  it("[BLIND] stale checks compare first-class run and session ids, not artifact refs", () => {
    const packet = validSameRoleCompactPacket({
      sourceRunId: "run-a",
      sourceSessionId: "session-a",
      artifacts: [{ kind: "run_log", ref: "paperclip:run:different-run:log" }],
    });

    expect(isStaleCompactWorkingStatePacket(packet, {
      sourceRunId: "run-a",
      sourceSessionId: "session-a",
    })).toBe(false);
    expect(isStaleCompactWorkingStatePacket(packet, {
      sourceRunId: "run-a",
      sourceSessionId: "session-b",
    })).toBe(true);
  });

  it("[BLIND] lets the builder reject empty workingNotes for an in-flight state that requires notes", () => {
    expect(() => buildCompactWorkingStatePacket(validBuilderInput({
      requireWorkingNotes: true,
      selfReport: {
        ...(validBuilderInput().selfReport as Record<string, unknown>),
        workingNotes: "",
      },
    }))).toThrow(/workingNotes|self-report/i);
  });

  it("[BLIND] fails build when semantic self-report is missing and no machine source derives it", () => {
    const missingNotes = validBuilderInput();
    delete (missingNotes.selfReport as Record<string, unknown>).workingNotes;
    expect(() => buildCompactWorkingStatePacket(missingNotes)).toThrow(/workingNotes|self-report/i);

    const missingStage = validBuilderInput({ stage: undefined });
    delete (missingStage.selfReport as Record<string, unknown>).stage;
    expect(() => buildCompactWorkingStatePacket(missingStage)).toThrow(/stage|self-report/i);
  });
});
