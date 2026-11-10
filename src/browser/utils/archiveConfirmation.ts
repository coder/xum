import type { ArchiveLossyUntrackedFilesConfirmation } from "@/common/orpc/schemas/api";

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

export interface ArchiveConfirmTextInput {
  displayTitle: string | undefined;
  /**
   * When set, the confirmation warns about permanent deletion of untracked files, the target's
   * own and those of the sub-agents its archive cascades over.
   */
  lossy?: ArchiveLossyUntrackedFilesConfirmation;
  /** Whether the workspace has an active stream that will be interrupted. */
  isStreaming: boolean;
}

/** Every at-risk path: the target's as they are, each sub-agent's after its prefix. */
export function flattenLossyPaths(
  lossy: ArchiveLossyUntrackedFilesConfirmation,
  subagentPrefix: (subagent: { workspaceId: string; title: string }) => string
): string[] {
  return [
    ...lossy.paths,
    ...(lossy.subagents ?? []).flatMap((subagent) =>
      subagent.paths.map((path) => `${subagentPrefix(subagent)}${path}`)
    ),
  ];
}

function archiveConfirmTitle(confirmation: ArchiveConfirmTextInput): string {
  if (confirmation.lossy) return "Archive workspace with untracked files?";
  return confirmation.displayTitle
    ? `Archive "${confirmation.displayTitle}" while streaming?`
    : "Archive workspace?";
}

/** The archive dialog's text; a closed dialog (null) gets the streaming-free defaults. */
export function buildArchiveConfirmText(confirmation: ArchiveConfirmTextInput | null) {
  if (confirmation == null) {
    return { title: "Archive workspace?", description: "", warning: "", confirmLabel: "Archive" };
  }
  const lossy = confirmation.lossy;
  // The dialog lists each sub-agent's paths under its title.
  const untrackedPaths = lossy
    ? flattenLossyPaths(lossy, (subagent) => `${subagent.title}: `)
    : undefined;
  return {
    title: archiveConfirmTitle(confirmation),
    description: buildArchiveConfirmDescription(
      confirmation.isStreaming,
      untrackedPaths,
      (lossy?.subagents ?? []).length > 0
    ),
    warning: buildArchiveConfirmWarning(confirmation.isStreaming, untrackedPaths),
    confirmLabel: lossy ? "Archive and delete files" : "Archive",
  };
}
