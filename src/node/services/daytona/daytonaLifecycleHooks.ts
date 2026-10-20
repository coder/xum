import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import { Err, Ok, type Result } from "@/common/types/result";
import { isDedicatedDaytonaSandbox, isSSHRuntime } from "@/common/types/runtime";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import type { BeforeArchiveHook } from "@/node/services/workspaceLifecycleHooks";
import type { DaytonaService } from "./daytonaService";

const DAYTONA_STOP_TIMEOUT_MS = 60_000;

/**
 * Archive reuses the Coder archive behavior setting (keep, stop, delete) for sandboxes Xum
 * created; attached and shared sandboxes are never touched. No unarchive hook: ensureReady
 * starts a stopped sandbox on the next use.
 */
export interface DaytonaArchiveHookOptions {
  daytonaService: Pick<DaytonaService, "getSandboxState" | "stopAndWait" | "deleteSandbox">;
  getArchiveBehavior: () => CoderWorkspaceArchiveBehavior;
  /** As for Coder: model-driven archives must not stop a box under a surviving detached job. */
  hasUnsettledRemoteBackgroundJobs?: (
    workspaceMetadata: WorkspaceMetadata
  ) => Promise<Result<boolean>>;
  /**
   * The dirty and unpushed checks deleteWorkspace runs (starting a stopped sandbox for them).
   * Archive "delete" deletes only when they pass; without this check it stops instead.
   */
  checkSandboxDeletable?: (workspaceMetadata: WorkspaceMetadata) => Promise<Result<void, string>>;
  now?: () => number;
}

export function createDaytonaArchiveHook(options: DaytonaArchiveHookOptions): BeforeArchiveHook {
  return async (args): Promise<Result<void>> => {
    const sandboxId = dedicatedSandboxId(args.workspaceMetadata);
    if (!sandboxId) return Ok(undefined);

    // The archive operation's policy snapshot wins (see the Coder hook).
    const behavior = args.coderWorkspaceArchiveBehavior ?? options.getArchiveBehavior();
    if (behavior === "keep") return Ok(undefined);
    try {
      if (behavior === "delete") {
        return await deleteForArchive(options, args, sandboxId);
      }
      return await stopForArchive(options, args, sandboxId);
    } catch (error) {
      return Err(`Failed to ${behavior} Daytona sandbox "${sandboxId}": ${getErrorMessage(error)}`);
    }
  };
}

/** Only sandboxes Xum created for this workspace; attached and shared ones are never touched. */
function dedicatedSandboxId(workspaceMetadata: WorkspaceMetadata): string | undefined {
  // A shared-checkout sub-agent copies its parent's runtime config, sandbox ID included,
  // without marking it shared: the sandbox belongs to the parent.
  if (workspaceMetadata.taskIsolation === "none") return undefined;
  const runtimeConfig = workspaceMetadata.runtimeConfig;
  if (!isDedicatedDaytonaSandbox(runtimeConfig) || !isSSHRuntime(runtimeConfig)) return undefined;
  return runtimeConfig.daytona?.sandboxId;
}

/**
 * Unlike Coder, never delete unchecked work: a dirty or unpushed worktree (or a check that
 * cannot run) keeps the sandbox, stopped, and the archive goes on with a warning.
 */
async function deleteForArchive(
  options: DaytonaArchiveHookOptions,
  args: Parameters<BeforeArchiveHook>[0],
  sandboxId: string
): Promise<Result<void>> {
  const check = options.checkSandboxDeletable
    ? await options.checkSandboxDeletable(args.workspaceMetadata)
    : Err("its worktree could not be checked for uncommitted work");
  if (check.success) {
    await options.daytonaService.deleteSandbox(sandboxId);
    return Ok(undefined);
  }
  log.warn("Daytona sandbox kept on archive: the delete checks failed", {
    sandboxId,
    error: check.error,
  });
  const { state } = await options.daytonaService.getSandboxState(sandboxId);
  if (isRunning(state)) await stopSandbox(options, sandboxId);
  args.reportWarning?.(
    `Daytona sandbox "${sandboxId}" was stopped, not deleted: ${check.error.trim()}`
  );
  return Ok(undefined);
}

function isRunning(state: string): boolean {
  return state !== "stopped" && state !== "archived" && state !== "missing";
}

async function stopSandbox(options: DaytonaArchiveHookOptions, sandboxId: string): Promise<void> {
  const now = options.now ?? Date.now;
  await options.daytonaService.stopAndWait(sandboxId, now() + DAYTONA_STOP_TIMEOUT_MS);
}

async function stopForArchive(
  options: DaytonaArchiveHookOptions,
  args: Parameters<BeforeArchiveHook>[0],
  sandboxId: string
): Promise<Result<void>> {
  const { state } = await options.daytonaService.getSandboxState(sandboxId);
  if (!isRunning(state)) {
    return Ok(undefined);
  }
  if (args.refuseStopUnderUnverifiedRemoteJobs === true) {
    const refusal = await probeRemoteJobs(options, args.workspaceMetadata, sandboxId);
    if (refusal) return Err(refusal);
  }
  log.debug("Stopping Daytona sandbox before archive", { sandboxId, state });
  await stopSandbox(options, sandboxId);
  return Ok(undefined);
}

async function probeRemoteJobs(
  options: DaytonaArchiveHookOptions,
  workspaceMetadata: WorkspaceMetadata,
  sandboxId: string
): Promise<string | undefined> {
  const manual = "Ask the user to archive this workspace manually.";
  if (options.hasUnsettledRemoteBackgroundJobs == null) {
    return `Cannot verify that no background process is still running in Daytona sandbox "${sandboxId}"; stopping it could terminate a surviving job. ${manual}`;
  }
  const probe = await options.hasUnsettledRemoteBackgroundJobs(workspaceMetadata);
  if (!probe.success) {
    return `Cannot verify that no background process is still running in Daytona sandbox "${sandboxId}" (${probe.error}); stopping it could terminate a surviving job. ${manual}`;
  }
  if (probe.data) {
    return `A background process from a previous session may still be running in Daytona sandbox "${sandboxId}"; stopping it would terminate that job. Terminate the process (or wait for it to finish) or ask the user to archive this workspace manually.`;
  }
  return undefined;
}
