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
export function createDaytonaArchiveHook(options: {
  daytonaService: Pick<DaytonaService, "getSandboxState" | "stopAndWait" | "deleteSandbox">;
  getArchiveBehavior: () => CoderWorkspaceArchiveBehavior;
  /** As for Coder: model-driven archives must not stop a box under a surviving detached job. */
  hasUnsettledRemoteBackgroundJobs?: (
    workspaceMetadata: WorkspaceMetadata
  ) => Promise<Result<boolean>>;
  now?: () => number;
}): BeforeArchiveHook {
  const now = options.now ?? Date.now;
  return async ({
    workspaceMetadata,
    coderWorkspaceArchiveBehavior,
    refuseStopUnderUnverifiedRemoteJobs,
  }): Promise<Result<void>> => {
    const runtimeConfig = workspaceMetadata.runtimeConfig;
    if (!isDedicatedDaytonaSandbox(runtimeConfig) || !isSSHRuntime(runtimeConfig)) {
      return Ok(undefined);
    }
    const sandboxId = runtimeConfig.daytona?.sandboxId;
    if (!sandboxId) return Ok(undefined);

    // The archive operation's policy snapshot wins (see the Coder hook).
    const behavior = coderWorkspaceArchiveBehavior ?? options.getArchiveBehavior();
    if (behavior === "keep") return Ok(undefined);

    try {
      if (behavior === "delete") {
        await options.daytonaService.deleteSandbox(sandboxId);
        return Ok(undefined);
      }

      const { state } = await options.daytonaService.getSandboxState(sandboxId);
      if (state === "stopped" || state === "archived" || state === "missing") {
        return Ok(undefined);
      }
      if (refuseStopUnderUnverifiedRemoteJobs === true) {
        const refusal = await probeRemoteJobs(options, workspaceMetadata, sandboxId);
        if (refusal) return Err(refusal);
      }
      log.debug("Stopping Daytona sandbox before archive", { sandboxId, state });
      await options.daytonaService.stopAndWait(sandboxId, now() + DAYTONA_STOP_TIMEOUT_MS);
      return Ok(undefined);
    } catch (error) {
      return Err(`Failed to ${behavior} Daytona sandbox "${sandboxId}": ${getErrorMessage(error)}`);
    }
  };
}

async function probeRemoteJobs(
  options: Parameters<typeof createDaytonaArchiveHook>[0],
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
