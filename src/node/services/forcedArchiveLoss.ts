import type { ArchiveCascadePreflight } from "@/node/services/taskWorkspaceSeam";

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

/** A sub-agent's path, prefixed with its workspace ID: each path is relative to its checkout. */
export function subagentPathLines(subagents: ArchiveCascadePreflight["subagents"]): string[] {
  return subagents.flatMap((subagent) =>
    subagent.paths.map((path) => `${subagent.workspaceId}: ${path}`)
  );
}

/**
 * The acknowledgements the sink compares with the files it finds. An empty list acknowledges
 * nothing, the same as no list, so a file that appears after the listing still refuses.
 */
export function forcedArchiveAcknowledgements(loss: ForcedArchiveLoss): {
  targetPaths: string[] | undefined;
  subagentPaths: Record<string, string[]> | undefined;
} {
  return {
    targetPaths: loss.targetPaths.length > 0 ? loss.targetPaths : undefined,
    subagentPaths:
      loss.subagents.length > 0
        ? Object.fromEntries(
            loss.subagents.map((subagent) => [subagent.workspaceId, subagent.paths])
          )
        : undefined,
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
      "Force deleted the untracked files listed in paths, because the snapshot archive cannot keep them. A path that starts with a workspace ID belongs to that sub-agent."
    );
  }
  if (loss.deletedCheckoutPath != null) {
    parts.push(
      `Force let the "Delete checkout" archive policy delete the checkout at ${loss.deletedCheckoutPath}: uncommitted changes there are gone, and its commits stay on the branch.`
    );
  }
  if (loss.deletedSubagentCheckouts.length > 0) {
    const subagents = loss.deletedSubagentCheckouts
      .map((subagent) => `${subagent.title} (${subagent.workspaceId})`)
      .join(", ");
    parts.push(
      `The same policy deleted the checkouts of the sub-agents archived with it: ${subagents}.`
    );
  }
  if (loss.deletedCoderWorkspaceName != null) {
    parts.push(
      `Force let the Coder "delete" archive policy delete the dedicated Coder workspace ${loss.deletedCoderWorkspaceName}; unarchive cannot recreate it.`
    );
  }
  return {
    ...(paths.length > 0 ? { paths } : {}),
    ...(parts.length > 0 ? { note: parts.join(" ") } : {}),
  };
}
