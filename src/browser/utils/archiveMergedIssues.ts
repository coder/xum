const MAX_ARCHIVE_MERGED_ISSUES_TO_SHOW = 5;

function formatArchiveMergedIssues(heading: string, lines: string[]): string {
  if (lines.length === 0) return "";
  const shown = lines
    .slice(0, MAX_ARCHIVE_MERGED_ISSUES_TO_SHOW)
    .map((line) => `- ${line}`)
    .join("\n");
  const remainingCount = Math.max(0, lines.length - MAX_ARCHIVE_MERGED_ISSUES_TO_SHOW);
  const remainingSuffix = remainingCount > 0 ? `\n… and ${remainingCount} more.` : "";
  return `\n\n${heading}:\n${shown}${remainingSuffix}`;
}

/** The alert after archiving merged workspaces, or null when nothing needs the user's attention. */
export function describeArchiveMergedIssues(data: {
  archivedWorkspaceIds: string[];
  skippedWorkspaceIds: string[];
  errors: Array<{ workspaceId: string; error: string }>;
  warnings: Array<{ workspaceId: string; warning: string }>;
}): string | null {
  const errorCount = data.errors.length;
  const warningCount = data.warnings.length;
  if (errorCount === 0 && warningCount === 0) return null;
  const counts = [
    `Archived: ${data.archivedWorkspaceIds.length}`,
    `Skipped: ${data.skippedWorkspaceIds.length}`,
    ...(errorCount > 0 ? [`Errors: ${errorCount}`] : []),
    ...(warningCount > 0 ? [`Warnings: ${warningCount}`] : []),
  ].join("\n");
  const title = `Archived merged workspaces with some ${errorCount > 0 ? "errors" : "warnings"}.`;
  const errorList = formatArchiveMergedIssues(
    "Errors",
    data.errors.map((e) => `${e.workspaceId}: ${e.error}`)
  );
  const warningList = formatArchiveMergedIssues(
    "Warnings",
    data.warnings.map((w) => `${w.workspaceId}: ${w.warning}`)
  );
  return `${title}\n\n${counts}${errorList}${warningList}`;
}
