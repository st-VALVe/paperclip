import { describe, expect, it } from "vitest";

import { resolveIssuePrefix } from "./issue-identifier-prefix.js";

describe("resolveIssuePrefix", () => {
  it("returns the project prefix when it is a non-empty, non-whitespace string", () => {
    expect(resolveIssuePrefix("PB", "AIM")).toBe("PB");
  });

  it("returns the project prefix value verbatim rather than the company prefix", () => {
    expect(resolveIssuePrefix("PBR", "AIM")).toBe("PBR");
  });

  it("falls back to the company prefix when the project prefix is null", () => {
    expect(resolveIssuePrefix(null, "AIM")).toBe("AIM");
  });

  it("falls back to the company prefix when the project prefix is undefined", () => {
    expect(resolveIssuePrefix(undefined, "AIM")).toBe("AIM");
  });

  it("falls back to the company prefix when the project prefix is an empty string", () => {
    expect(resolveIssuePrefix("", "AIM")).toBe("AIM");
  });

  it("falls back to the company prefix when the project prefix is whitespace-only spaces", () => {
    expect(resolveIssuePrefix("   ", "AIM")).toBe("AIM");
  });

  it("falls back to the company prefix when the project prefix is whitespace-only tabs and newlines", () => {
    expect(resolveIssuePrefix("\t\n ", "AIM")).toBe("AIM");
  });

  it("uses the project prefix when it contains non-whitespace characters even if surrounded by whitespace", () => {
    expect(resolveIssuePrefix(" PB ", "AIM")).not.toBe("AIM");
  });
});
