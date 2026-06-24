/**
 * Resolve the identifier prefix used when minting a new issue identifier.
 *
 * Prefers a project-specific prefix so PaperBridge work can carry its own
 * identifier (e.g. `PB-*`) while other projects in the same company keep the
 * company-wide prefix. A project prefix that is absent or whitespace-only is
 * treated as unset and falls back to the company prefix.
 */
export function resolveIssuePrefix(
  projectPrefix: string | null | undefined,
  companyPrefix: string,
): string {
  if (typeof projectPrefix === "string" && projectPrefix.trim().length > 0) {
    return projectPrefix;
  }
  return companyPrefix;
}
