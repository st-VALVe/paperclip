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

export function buildCompactWorkingStateSelfReportCapturePrompt(): string {
  return [
    "Emit exactly one compact working-state self-report.",
    "",
    "Return exactly one fenced ```handoff-v1 JSON block and one closing ``` fence.",
    "Set `packetKind` to `compact_working_state`.",
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
    const packet = validateCompactWorkingStatePacket(JSON.parse(matches[0]?.[1] ?? "{}"));
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
