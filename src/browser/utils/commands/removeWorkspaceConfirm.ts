import type { ConfirmDialogOptions } from "@/browser/contexts/ConfirmDialogContext";
import { isWorktreeRuntime, type RuntimeConfig } from "@/common/types/runtime";

/**
 * What a user-initiated (non-forced) workspace removal deletes, by runtime (#5204). Each runtime's
 * `deleteWorkspace` removes something different, so the confirmation must name it.
 */
export type WorkspaceRemovalKind =
  | "worktree"
  | "localProject"
  | "ssh"
  | "coder"
  | "docker"
  | "devcontainer"
  | "multiProject"
  | "scratch"
  | "unknown";

export interface RemovableWorkspace {
  /** Workspace name, which is also its branch name for checkout-based runtimes. */
  name: string;
  runtimeConfig?: RuntimeConfig;
  projects?: readonly unknown[];
  /** Scratch chats live in a managed directory that removal deletes. */
  kind?: "scratch";
}

/**
 * A workspace written by a newer Xum can carry a runtime type this build does not know (Config
 * flags it as incompatibleRuntime), and its removal must stay confirmable. So the `never`
 * parameter checks exhaustiveness at compile time only, instead of asserting at runtime.
 */
function unknownRuntimeKind(_config: never): WorkspaceRemovalKind {
  return "unknown";
}

export function getWorkspaceRemovalKind(workspace: RemovableWorkspace): WorkspaceRemovalKind {
  if (workspace.kind === "scratch") return "scratch";
  if ((workspace.projects?.length ?? 0) > 1) return "multiProject";
  const config = workspace.runtimeConfig;
  // No runtime config means the default worktree runtime (see WorkspaceService.create).
  if (config == null) return "worktree";
  switch (config.type) {
    case "worktree":
      return "worktree";
    case "local":
      // Legacy "local" with srcBaseDir is a worktree.
      return isWorktreeRuntime(config) ? "worktree" : "localProject";
    case "ssh":
      // CoderSSHRuntime deletes the Coder workspace only when Xum created it and knows its name
      // (an empty name counts as unknown); otherwise it falls back to the SSH removal.
      return (config.coder?.workspaceName ?? "") !== "" && config.coder?.existingWorkspace !== true
        ? "coder"
        : "ssh";
    case "docker":
      return "docker";
    case "devcontainer":
      return "devcontainer";
    default:
      return unknownRuntimeKind(config);
  }
}

/** Where an SSH checkout lives: the Coder workspace's name reads better than its SSH host alias. */
function describeSshLocation(workspace: RemovableWorkspace): string {
  const config = workspace.runtimeConfig;
  if (config?.type !== "ssh") return "the remote host";
  const coderName = config.coder?.workspaceName ?? "";
  return coderName !== "" ? `the Coder workspace "${coderName}"` : config.host;
}

/**
 * Names only what the removal certainly deletes, and what it keeps. A worktree's branch goes only
 * through `git branch -d`, so only a fully merged branch is deleted.
 */
const REMOVAL_DESCRIPTIONS: Record<
  WorkspaceRemovalKind,
  (workspace: RemovableWorkspace) => string
> = {
  worktree: (w) =>
    `This will delete the worktree "${w.name}", and its local branch if the branch is fully merged.`,
  localProject: (w) =>
    `This removes "${w.name}" and its chat history from Xum. The project directory and its files are kept.`,
  ssh: (w) =>
    `This will delete the checkout of "${w.name}" on ${describeSshLocation(w)}, and its branch in Xum's repository copy there.${
      w.runtimeConfig?.type === "ssh" && w.runtimeConfig.coder != null
        ? " The Coder workspace itself is kept."
        : ""
    }`,
  coder: (w) =>
    `This will delete the Coder workspace "${
      w.runtimeConfig?.type === "ssh" ? (w.runtimeConfig.coder?.workspaceName ?? w.name) : w.name
    }" and everything stored in it.`,
  docker: (w) =>
    `This will delete the Docker container of "${w.name}" and the repository copy inside it.`,
  devcontainer: (w) =>
    `This will remove the dev container of "${w.name}", then delete its worktree, and its local branch if the branch is fully merged.`,
  multiProject: (w) =>
    `This will remove "${w.name}" from its ${w.projects?.length ?? 0} projects. Each project's own checkout is deleted, with its local branch if the branch is fully merged; a project directory used in place is kept.`,
  scratch: (w) =>
    `This will delete the scratch chat "${w.name}" and its working directory, with any files in it, unless another chat still uses that directory.`,
  unknown: (w) =>
    `This will remove "${w.name}", but this version of Xum does not know its runtime, so it cannot say what the removal deletes.`,
};

/**
 * The confirmation a user-initiated workspace removal shows. Shared by the command palette and
 * the interrupted-delegated-setup banner (#4983), so both ask the same question before the same
 * non-forced removal.
 */
export function removeWorkspaceConfirmOptions(
  title: string,
  workspace: RemovableWorkspace
): ConfirmDialogOptions {
  return {
    title,
    description: REMOVAL_DESCRIPTIONS[getWorkspaceRemovalKind(workspace)](workspace),
    warning: "This cannot be undone.",
    confirmLabel: "Remove",
    confirmVariant: "destructive",
  };
}
