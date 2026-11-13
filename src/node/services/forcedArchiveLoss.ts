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
  /** The target's checkout and the branch that keeps its commits, when the "delete" policy deletes it. */
  deletedCheckout?: { path: string; branch: string } | undefined;
  /** The dedicated Coder workspace the Coder "delete" policy deletes. */
  deletedCoderWorkspaceName?: string | undefined;
}

// The checkout and Coder deletions run after the archive is saved and are best effort.
const BEST_EFFORT_DELETION = "A deletion that failed leaves the path or workspace in place.";

/**
 * A forced archive deletes only what it listed. A file that appeared or changed since means
 * someone or something still works in that checkout (the "keep working" refusals of the archive),
 * so the answer is to find out who, not to force again.
 */
export const FORCED_ARCHIVE_LOSS_CHANGED_REFUSAL =
  "What force would delete changed after it listed it, so something still writes in these checkouts and the archive deleted nothing for this workspace. " +
  "Find out what writes there before you archive again, and use force again only when the user asked for cleanup or the work is provably saved. " +
  "The files that would be deleted now are listed in paths.";

/**
 * The same refusal for a cascaded sub-agent, which the sink reports after the deeper sub-agents
 * were archived. The failure note lists what they lost.
 */
export const FORCED_ARCHIVE_SUBAGENT_CHANGED_REFUSAL =
  "the untracked files that force listed for its checkout changed, so something still writes there and its archive deleted nothing. " +
  "Find out what writes there before you archive again, and use force again only when the user asked for cleanup or the work is provably saved.";

/** Whether two listings name the same files and checkouts: what force may delete is unchanged. */
export function sameForcedArchiveLoss(a: ForcedArchiveLoss, b: ForcedArchiveLoss): boolean {
  const shape = (loss: ForcedArchiveLoss) =>
    JSON.stringify([
      // The target's own checkout: a rename since the first listing moves it to another path and branch.
      loss.deletedCheckout?.path,
      loss.deletedCheckout?.branch,
      loss.targetPaths,
      loss.subagents.map((subagent) => [subagent.workspaceId, subagent.paths]),
      // The branch too: a sub-agent renamed between two listings names another branch for its commits.
      loss.deletedSubagentCheckouts.map((subagent) => [subagent.workspaceId, subagent.branch]),
    ]);
  return shape(a) === shape(b);
}

/** The target's and the sub-agents' files that a forced archive deletes, one list for the result. */
export function forcedArchivePaths(loss: ForcedArchiveLoss): string[] {
  return [...loss.targetPaths, ...subagentPathLines(loss.subagents)];
}

function subagentCheckoutList(
  checkouts: NonNullable<ArchiveCascadePreflight["deletedCheckouts"]>
): string {
  return checkouts
    .map((subagent) => `${subagent.title} (${subagent.workspaceId}, branch ${subagent.branch})`)
    .join(", ");
}

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
  const paths = forcedArchivePaths(loss);
  const parts: string[] = [];
  if (paths.length > 0) {
    parts.push(
      "Force let the archive delete the untracked files listed in paths, because the snapshot archive cannot keep them. A path that starts with a workspace ID belongs to that sub-agent."
    );
  }
  if (loss.deletedCheckout != null) {
    parts.push(
      `Force let the "Delete checkout" archive policy delete the checkout at ${loss.deletedCheckout.path}. Uncommitted changes in it are lost once it is deleted, and its commits stay on branch ${loss.deletedCheckout.branch}.`
    );
  }
  if (loss.deletedSubagentCheckouts.length > 0) {
    parts.push(
      `Force also let that policy delete the checkouts of the sub-agents archived with it: ${subagentCheckoutList(loss.deletedSubagentCheckouts)}. Their commits stay on those branches.`
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
 * What a forced archive had already deleted, or may have deleted, when it failed: it archives the
 * sub-agents first, so those it archived before the failure lost their listed files and
 * checkouts. The target's own files and checkout go only with a successful archive. Its dedicated
 * Coder workspace goes before the archive is saved, so a failure can come after that deletion.
 * Undefined when nothing went.
 */
export function describeForcedLossBeforeFailure(
  loss: ForcedArchiveLoss,
  isArchived: (workspaceId: string) => boolean
): string | undefined {
  const notes = [
    describeArchivedSubagentLoss(loss, isArchived),
    describeCoderLossBeforeFailure(loss),
  ];
  const present = notes.filter((note) => note != null);
  return present.length > 0 ? present.join(" ") : undefined;
}

function describeArchivedSubagentLoss(
  loss: ForcedArchiveLoss,
  isArchived: (workspaceId: string) => boolean
): string | undefined {
  const files = subagentPathLines(loss.subagents.filter((s) => isArchived(s.workspaceId)));
  const checkouts = loss.deletedSubagentCheckouts
    .filter((s) => isArchived(s.workspaceId))
    .map((s) => `${s.title} (${s.workspaceId}, branch ${s.branch})`);
  const parts = [
    ...(files.length > 0 ? [`their untracked files (${files.join(", ")})`] : []),
    ...(checkouts.length > 0 ? [`the checkouts of ${checkouts.join(", ")}`] : []),
  ];
  if (parts.length === 0) return undefined;
  return `The archive failed after it archived some sub-agents. Force had already let it delete ${parts.join(" and ")}.`;
}

function describeCoderLossBeforeFailure(loss: ForcedArchiveLoss): string | undefined {
  if (loss.deletedCoderWorkspaceName == null) return undefined;
  return `The archive failed. Force let it delete the dedicated Coder workspace ${loss.deletedCoderWorkspaceName} before it saves the archive, so check whether that workspace still exists: unarchive cannot recreate it.`;
}
