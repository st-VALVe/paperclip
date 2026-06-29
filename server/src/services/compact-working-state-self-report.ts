import { validateCompactWorkingStatePacket } from "./compact-working-state.js";

const REQUEST_FLAG = "paperclipRequestCompactWorkingStateSelfReport";
const HANDOFF_BLOCK_RE = /```handoff-v1\s*\n([\s\S]*?)\n```/g;

type SemanticSelfReport = {
  stage: unknown;
  status: unknown;
  workingNotes: unknown;
  acceptance: unknown;
  tests: unknown;
  blocker: unknown;
  requiredHandoff: unknown;
  next: unknown;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function canonicalizeAcceptance(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry, index) => {
    const text = readNonEmptyString(entry);
    if (!text) return entry;
    return {
      id: `AC${index + 1}`,
      text,
      status: "pending",
      assertedBy: "agent",
      verified: false,
      evidence: [],
    };
  });
}

function canonicalizeBlocker(value: unknown): unknown {
  const blockerText = readNonEmptyString(value);
  if (blockerText) {
    return { summary: blockerText, evidence: [] };
  }

  const blocker = readRecord(value);
  if (!blocker) return value;
  const summary =
    readNonEmptyString(blocker.summary) ??
    readNonEmptyString(blocker.description) ??
    readNonEmptyString(blocker.reason) ??
    readNonEmptyString(blocker.unblockAction) ??
    readNonEmptyString(blocker.action) ??
    readNonEmptyString(blocker.kind);
  if (!summary) return value;
  const owner = readNonEmptyString(blocker.owner) ?? readNonEmptyString(blocker.unblockOwner);
  const canonical: Record<string, unknown> = {
    summary,
    evidence: Array.isArray(blocker.evidence) ? blocker.evidence : [],
  };
  if (owner) canonical.owner = owner;
  else if (blocker.owner !== undefined && blocker.owner !== null) canonical.owner = blocker.owner;
  return canonical;
}

function canonicalizeRequiredHandoff(value: unknown): unknown {
  const handoff = readRecord(value);
  if (!handoff || handoff.required !== false) return value;
  return { required: false, to: null, status: handoff.status, reason: null };
}

function canonicalizeCapturePacket(packet: Record<string, unknown>): Record<string, unknown> {
  return {
    ...packet,
    acceptance: canonicalizeAcceptance(packet.acceptance),
    blocker: canonicalizeBlocker(packet.blocker),
    requiredHandoff: canonicalizeRequiredHandoff(packet.requiredHandoff),
  };
}

export function buildCompactWorkingStateSelfReportCapturePrompt(): string {
  return [
    "Emit exactly one compact working-state self-report.",
    "",
    "Return exactly one fenced ```handoff-v1 JSON block and one closing ``` fence.",
    "Include top-level fields `v`, `packetKind`, `issue`, `issueId`, `sourceRunId`, `sourceSessionId`, `stage`, `from`, `to`, `status`, `objective`, `workingNotes`, `acceptance`, `changes`, `tests`, `blocker`, `requiredHandoff`, `artifacts`, `rawTranscriptRefs`, and `next`.",
    "Set `v` to `1`.",
    "Set `packetKind` to `compact_working_state`.",
    "Set `status` to one of `approved`, `rejected`, `blocked`, `done`, or `in_progress`.",
    "Use arrays for `acceptance`, `artifacts`, and `rawTranscriptRefs`.",
    "Set `changes` to an object with `files` and `commits` arrays.",
    "Set `tests` to an object with `written` and `runs` arrays.",
    "Set `requiredHandoff` to an object with `required`, `to`, `status`, and `reason`.",
    "Set `blocker` to `null` unless `status` is `blocked`.",
    "Use this JSON field layout inside the fence:",
    "{",
    '  "v": 1,',
    '  "packetKind": "compact_working_state",',
    '  "issue": "<non-empty issue label>",',
    '  "issueId": "<non-empty issue id>",',
    '  "sourceRunId": "<non-empty source run id>",',
    '  "sourceSessionId": "<non-empty source session id>",',
    '  "stage": "<non-empty stage>",',
    '  "from": "<non-empty source role>",',
    '  "to": "<non-empty target role>",',
    '  "status": "in_progress",',
    '  "objective": "<non-empty objective>",',
    '  "workingNotes": "<compact state, no raw transcript>",',
    '  "acceptance": [],',
    '  "changes": { "files": [], "commits": [] },',
    '  "tests": { "written": [], "runs": [] },',
    '  "blocker": null,',
    '  "requiredHandoff": { "required": false, "to": null, "status": "in_progress", "reason": null },',
    '  "artifacts": [],',
    '  "rawTranscriptRefs": [],',
    '  "next": "<non-empty next action>"',
    "}",
    "Do not include raw transcript text.",
    "Use transcript references only when needed.",
  ].join("\n");
}

export function shouldRequestCompactWorkingStateSelfReport(input: {
  adapterType: unknown;
  resetTaskSession: boolean;
  context: Record<string, unknown>;
}): boolean {
  return (
    input.adapterType === "claude_local" &&
    input.resetTaskSession &&
    input.context[REQUEST_FLAG] === true
  );
}

export function parseCompactWorkingStateSelfReportCapture(output: string): SemanticSelfReport | null {
  const matches = [...output.matchAll(HANDOFF_BLOCK_RE)];
  if (matches.length !== 1) return null;

  try {
    const rawPacket = readRecord(JSON.parse(matches[0]?.[1] ?? "{}"));
    if (!rawPacket) return null;
    const packet = validateCompactWorkingStatePacket(canonicalizeCapturePacket(rawPacket));
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
  } catch {
    return null;
  }
}

export async function captureCompactWorkingStateSelfReportForFreshSession(input: {
  adapterType: unknown;
  resetTaskSession: boolean;
  context: Record<string, unknown>;
  requestSelfReport: (prompt: string) => Promise<string>;
}): Promise<{ captured: boolean }> {
  if (!shouldRequestCompactWorkingStateSelfReport(input)) {
    return { captured: false };
  }

  delete input.context.paperclipCompactWorkingStateSelfReport;
  delete input.context.paperclipSessionHandoffMarkdown;

  let output: string | null;
  try {
    output = await input.requestSelfReport(buildCompactWorkingStateSelfReportCapturePrompt());
  } catch {
    return { captured: false };
  }
  const selfReport = typeof output === "string"
    ? parseCompactWorkingStateSelfReportCapture(output)
    : null;

  if (!readRecord(selfReport)) {
    return { captured: false };
  }

  input.context.paperclipCompactWorkingStateSelfReport = selfReport;
  return { captured: true };
}
