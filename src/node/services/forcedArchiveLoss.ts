import type {
  ArchiveCascadePreflight,
  ArchiveWorkspaceOptions,
} from "@/node/services/taskWorkspaceSeam";

/**
 * What a forced model-facing archive deletes: the saved state its refusals normally protect.
 * The lifecycle manager collects it under the archive locks, acknowledges exactly the untracked
 * files in it at the sink, and reports all of it in the result.
 */
export interface ForcedArchiveLoss {
  /** Untracked files of the target that its snapshot archive cannot keep. */
  targetPaths: string[];
  /** Cascaded sub-agents whose snapshot archive cannot keep untracked files. */
  subagents: ArchiveCascadePreflight["subagents"];
  /** Cascaded sub-agents whose checkout the "delete" policy deletes. */
  deletedSubagentCheckouts: NonNullable<ArchiveCascadePreflight["deletedCheckouts"]>;
  /** The target's checkout path, when the "delete" policy deletes it. */
  deletedCheckoutPath?: string | undefined;
  /** The dedicated Coder workspace the Coder "delete" policy deletes. */
  deletedCoderWorkspaceName?: string | undefined;
}

// The checkout and Coder deletions run after the archive is saved and are best effort.
const BEST_EFFORT_DELETION = "A deletion that failed leaves the path or workspace in place.";

/**
 * A forced archive deletes only the files it listed: a different set at the sink means someone
 * wrote to the checkout since, so nothing was deleted for it.
 */
export const FORCED_ARCHIVE_UNTRACKED_CHANGED_REFUSAL =
  "The untracked files changed after force listed them, so the archive deleted nothing for this workspace. " +
  "The files now listed in paths would be deleted; archive again with force to delete them.";

/** A sub-agent's path, prefixed with its workspace ID: each path is relative to its checkout. */
export function subagentPathLines(subagents: ArchiveCascadePreflight["subagents"]): string[] {
  return subagents.flatMap((subagent) =>
    subagent.paths.map((path) => `${subagent.workspaceId}: ${path}`)
  );
}

/**
 * The acknowledgements the sink checks against what it finds. An empty list acknowledges
 * nothing, the same as no list, so a file that appears after the listing still refuses. The
 * sub-agent checkouts it may delete are always a list, even an empty one: a sub-agent missing from
 * it (another backend created it after the listing) is refused.
 */
export function forcedArchiveAcknowledgements(loss: ForcedArchiveLoss | undefined): {
  targetPaths: string[] | undefined;
  options: Pick<
    ArchiveWorkspaceOptions,
    "acknowledgedSubagentUntrackedPaths" | "acknowledgedSubagentCheckoutDeletions"
  >;
} {
  if (loss == null) return { targetPaths: undefined, options: {} };
  return {
    targetPaths: loss.targetPaths.length > 0 ? loss.targetPaths : undefined,
    options: {
      ...(loss.subagents.length > 0
        ? {
            acknowledgedSubagentUntrackedPaths: Object.fromEntries(
              loss.subagents.map((subagent) => [subagent.workspaceId, subagent.paths])
            ),
          }
        : {}),
      acknowledgedSubagentCheckoutDeletions: loss.deletedSubagentCheckouts.map(
        (subagent) => subagent.workspaceId
      ),
    },
  };
}

/** The `paths` and `note` of an archived result that deleted something; empty when nothing went. */
export function describeForcedArchiveLoss(loss: ForcedArchiveLoss): {
  paths?: string[];
  note?: string;
} {
  const paths = [...loss.targetPaths, ...subagentPathLines(loss.subagents)];
  const parts: string[] = [];
  if (paths.length > 0) {
    parts.push(
      "Force let the archive delete the untracked files listed in paths, because the snapshot archive cannot keep them. A path that starts with a workspace ID belongs to that sub-agent."
    );
  }
  if (loss.deletedCheckoutPath != null) {
    parts.push(
      `Force let the "Delete checkout" archive policy delete the checkout at ${loss.deletedCheckoutPath}. Uncommitted changes in it are lost once it is deleted, and its commits stay on the branch.`
    );
  }
  if (loss.deletedSubagentCheckouts.length > 0) {
    const subagents = loss.deletedSubagentCheckouts
      .map((subagent) => `${subagent.title} (${subagent.workspaceId})`)
      .join(", ");
    parts.push(
      `Force also let that policy delete the checkouts of the sub-agents archived with it: ${subagents}.`
    );
  }
  if (loss.deletedCoderWorkspaceName != null) {
    parts.push(
      `Force let the Coder "delete" archive policy delete the dedicated Coder workspace ${loss.deletedCoderWorkspaceName}; unarchive cannot recreate it.`
    );
  }
  const note = parts.length > 0 ? [...parts, BEST_EFFORT_DELETION].join(" ") : undefined;
  return {
    ...(paths.length > 0 ? { paths } : {}),
    ...(note != null ? { note } : {}),
  };
}

/**
 * What a forced archive had already deleted when it failed part-way: it archives the sub-agents
 * first, so those it archived before the failure lost their listed files and checkouts. The
 * target's own state goes only with a successful archive. Undefined when nothing went.
 */
export function describeForcedLossBeforeFailure(
  loss: ForcedArchiveLoss,
  isArchived: (workspaceId: string) => boolean
): string | undefined {
  const files = subagentPathLines(loss.subagents.filter((s) => isArchived(s.workspaceId)));
  const checkouts = loss.deletedSubagentCheckouts
    .filter((s) => isArchived(s.workspaceId))
    .map((s) => `${s.title} (${s.workspaceId})`);
  const parts = [
    ...(files.length > 0 ? [`their untracked files (${files.join(", ")})`] : []),
    ...(checkouts.length > 0 ? [`the checkouts of ${checkouts.join(", ")}`] : []),
  ];
  if (parts.length === 0) return undefined;
  return `The archive failed after it archived some sub-agents. Force had already let it delete ${parts.join(" and ")}.`;
}
