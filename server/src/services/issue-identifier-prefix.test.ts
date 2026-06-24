import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveIssuePrefix } from "./issue-identifier-prefix.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectsSchemaPath = join(here, "../../../packages/db/src/schema/projects.ts");
const migrationPath = join(here, "../../../packages/db/src/migrations/0111_project_issue_prefix.sql");
const issuesServicePath = join(here, "issues.ts");

const readSource = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

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

describe("projects schema issue_prefix column", () => {
  const source = readSource(projectsSchemaPath);
  const columnLine =
    source.split("\n").find((line) => line.includes("issue_prefix") && line.includes("text(")) ?? "";

  it("declares an issue_prefix text column on the projects table", () => {
    expect(columnLine).toMatch(/text\(\s*["']issue_prefix["']\s*\)/);
  });

  it("declares the issue_prefix column as nullable with no non-null default", () => {
    expect(columnLine).not.toBe("");
    expect(columnLine).not.toMatch(/\.notNull\s*\(/);
    expect(columnLine).not.toMatch(/\.default\(\s*(?!null\b)/i);
  });
});

describe("0111 project issue_prefix migration", () => {
  const sql = readSource(migrationPath);
  const statement =
    sql
      .split(";")
      .map((part) => part.trim())
      .find((part) => /issue_prefix/i.test(part)) ?? "";

  it("adds the issue_prefix column to the projects table as text", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(statement.toLowerCase()).toContain("projects");
    expect(statement.toLowerCase()).toContain("add column");
    expect(statement).toMatch(/issue_prefix["'\s]+text/i);
  });

  it("adds the issue_prefix column as nullable with no non-null default", () => {
    expect(statement).not.toBe("");
    expect(statement).not.toMatch(/not\s+null/i);
    expect(statement).not.toMatch(/default\s+(?!null\b)/i);
  });

  it("does not introduce a per-project issue counter", () => {
    const lower = sql.toLowerCase();
    expect(lower).not.toContain("counter");
    expect(lower).not.toContain("create sequence");
  });
});

describe("issue creation derives the identifier prefix via resolveIssuePrefix", () => {
  const source = readSource(issuesServicePath);

  it("imports resolveIssuePrefix from the issue-identifier-prefix helper", () => {
    expect(source).toMatch(/import[^;]*resolveIssuePrefix[^;]*issue-identifier-prefix/s);
  });

  it("calls resolveIssuePrefix when constructing the issue identifier", () => {
    expect(source).toMatch(/resolveIssuePrefix\s*\(/);
  });
});
