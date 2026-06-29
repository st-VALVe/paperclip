import { describe, expect, it } from "vitest";
import {
  hasSessionCompactionThresholds,
  readSessionCompactionOverride,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "./session-compaction.js";

// [BLIND] PB-39 resident-window session rotation -- pure policy (adapter-utils).
// Source of truth: specs/001-paperbridge-pipeline-v2/pb39-resident-window-rotation.spec.md.
// Assertions derive from the spec's delta contract (section 3) and behavioural
// contract (section 4); the production default (112000) and K (3) are tuning
// values per section 5/7 and are NOT asserted as the thing under test.

function override(maxResidentWindowTokens: unknown) {
  return { heartbeat: { sessionCompaction: { maxResidentWindowTokens } } };
}

describe("[BLIND] PB-39 readSessionCompactionOverride parses maxResidentWindowTokens (B1)", () => {
  it("[BLIND] parses a numeric maxResidentWindowTokens from heartbeat.sessionCompaction", () => {
    const parsed = readSessionCompactionOverride(override(50_000));
    expect(parsed.maxResidentWindowTokens).toBe(50_000);
  });

  it("[BLIND] parses a numeric-string maxResidentWindowTokens", () => {
    const parsed = readSessionCompactionOverride(override("50000"));
    expect(parsed.maxResidentWindowTokens).toBe(50_000);
  });

  it("[BLIND] clamps a negative maxResidentWindowTokens to >= 0", () => {
    const parsed = readSessionCompactionOverride(override(-5));
    expect(parsed.maxResidentWindowTokens).toBeGreaterThanOrEqual(0);
    expect(parsed.maxResidentWindowTokens).toBe(0);
  });

  it("[BLIND] clamps a negative numeric-string maxResidentWindowTokens to >= 0", () => {
    const parsed = readSessionCompactionOverride(override("-5"));
    expect(parsed.maxResidentWindowTokens).toBe(0);
  });

  it("[BLIND] omits maxResidentWindowTokens when no override is supplied", () => {
    expect(readSessionCompactionOverride({}).maxResidentWindowTokens).toBeUndefined();
    expect(
      readSessionCompactionOverride({ heartbeat: { sessionCompaction: {} } }).maxResidentWindowTokens,
    ).toBeUndefined();
  });

  it("[BLIND] omits maxResidentWindowTokens for a non-numeric override value", () => {
    expect(readSessionCompactionOverride(override("not-a-number")).maxResidentWindowTokens).toBeUndefined();
  });
});

describe("[BLIND] PB-39 hasSessionCompactionThresholds counts maxResidentWindowTokens (B2)", () => {
  function policy(overrides: Partial<SessionCompactionPolicy>): SessionCompactionPolicy {
    return {
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
      maxResidentWindowTokens: 0,
      ...overrides,
    };
  }

  it("[BLIND] is true when only maxResidentWindowTokens > 0", () => {
    expect(hasSessionCompactionThresholds(policy({ maxResidentWindowTokens: 1 }))).toBe(true);
  });

  it("[BLIND] is false when all four thresholds are 0", () => {
    expect(hasSessionCompactionThresholds(policy({}))).toBe(false);
  });
});

describe("[BLIND] PB-39 resolveSessionCompactionPolicy claude_local default (B3)", () => {
  it("[BLIND] gives claude_local a non-zero maxResidentWindowTokens by default", () => {
    const { policy } = resolveSessionCompactionPolicy("claude_local", {});
    // Spec B3 / section 7: assert non-zero default, not the specific tuning number.
    expect(policy.maxResidentWindowTokens).toBeGreaterThan(0);
  });

  it("[BLIND] keeps runs/tokens/age at 0 for claude_local by default", () => {
    const { policy } = resolveSessionCompactionPolicy("claude_local", {});
    expect(policy.maxSessionRuns).toBe(0);
    expect(policy.maxRawInputTokens).toBe(0);
    expect(policy.maxSessionAgeHours).toBe(0);
  });

  it("[BLIND] lets an explicit override replace the claude_local default", () => {
    const { policy } = resolveSessionCompactionPolicy("claude_local", override(7));
    expect(policy.maxResidentWindowTokens).toBe(7);
  });

  it("[BLIND] honours an explicit override that disables the resident-window dimension (0)", () => {
    const { policy } = resolveSessionCompactionPolicy("claude_local", override(0));
    expect(policy.maxResidentWindowTokens).toBe(0);
  });
});

describe("[BLIND] PB-39 resident-window default does not leak to sibling native-managed adapters (B3a)", () => {
  it.each(["acpx_local", "codex_local", "hermes_local"])(
    "[BLIND] resolves maxResidentWindowTokens = 0 for %s",
    (adapterType) => {
      const { policy } = resolveSessionCompactionPolicy(adapterType, {});
      expect(policy.maxResidentWindowTokens).toBe(0);
    },
  );
});
