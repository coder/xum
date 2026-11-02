/** Max number of untracked paths to show inline before truncating with "+N more". */
const MAX_DISPLAYED_UNTRACKED_PATHS = 10;

/**
 * Build the description text for the archive confirmation dialog based on active warnings.
 */
export function buildArchiveConfirmDescription(
  isStreaming: boolean,
  untrackedPaths: string[] | null | undefined,
  includesSubagents = false
): string {
  const parts: string[] = [];
  if (isStreaming) {
    parts.push("This workspace is currently streaming a response.");
  }
  if (untrackedPaths && untrackedPaths.length > 0) {
    parts.push(
      includesSubagents
        ? "Archive snapshots cannot preserve untracked files in this workspace or its sub-agents."
        : "Archive snapshots cannot preserve untracked files in this workspace."
    );
  }
  return parts.join(" ");
}

/**
 * Build the warning text for the archive confirmation dialog.
 * Combines streaming-interruption and untracked-file-deletion warnings into one string.
 */
export function buildArchiveConfirmWarning(
  isStreaming: boolean,
  untrackedPaths: string[] | null | undefined
): string {
  const parts: string[] = [];
  if (isStreaming) {
    parts.push("Archiving will interrupt the active stream.");
  }
  if (untrackedPaths && untrackedPaths.length > 0) {
    const displayed = untrackedPaths.slice(0, MAX_DISPLAYED_UNTRACKED_PATHS);
    const remaining = untrackedPaths.length - displayed.length;
    let pathList = displayed.join(", ");
    if (remaining > 0) {
      pathList += ` (+${remaining} more)`;
    }
    parts.push(
      `The following files/directories will be permanently deleted and cannot be recovered: ${pathList}`
    );
  }
  return parts.join("\n\n");
}
