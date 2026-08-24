import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import { isSSHRuntime } from "@/common/types/runtime";
import { Err, Ok, type Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import type { CoderService, WorkspaceStatusResult } from "@/node/services/coderService";
import { log } from "@/node/services/log";
import type {
  AfterUnarchiveHook,
  BeforeArchiveHook,
} from "@/node/services/workspaceLifecycleHooks";

const DEFAULT_STOP_TIMEOUT_MS = 60_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_STATUS_TIMEOUT_MS = 10_000;

const DEFAULT_STOPPING_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_STOPPING_POLL_INTERVAL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlreadyStoppedOrGone(status: WorkspaceStatusResult): boolean {
  if (status.kind === "not_found") {
    return true;
  }

  if (status.kind !== "ok") {
    return false;
  }

  // "stopping" is treated as "good enough" for archive — we don't want to block the user on a
  // long tail stop operation when the workspace is already on its way down.
  return (
    status.status === "stopped" ||
    status.status === "stopping" ||
    status.status === "deleted" ||
    status.status === "deleting"
  );
}

function isAlreadyRunningOrStarting(status: WorkspaceStatusResult): boolean {
  if (status.kind !== "ok") {
    return false;
  }

  return status.status === "running" || status.status === "starting";
}

export function createCoderArchiveHook(options: {
  coderService: CoderService;
  getArchiveBehavior: () => CoderWorkspaceArchiveBehavior;
  timeoutMs?: number;
}): BeforeArchiveHook {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  return async ({
    workspaceId,
    workspaceMetadata,
    coderWorkspaceArchiveBehavior,
  }): Promise<Result<void>> => {
    const runtimeConfig = workspaceMetadata.runtimeConfig;
    if (!isSSHRuntime(runtimeConfig) || !runtimeConfig.coder) {
      return Ok(undefined);
    }

    const coder = runtimeConfig.coder;

    // Important safety invariant:
    // Only stop/delete Coder workspaces that mux created (dedicated workspaces). If the user
    // connected mux to an existing Coder workspace, archiving in mux should *not* manage their
    // environment.
    if (coder.existingWorkspace === true) {
      return Ok(undefined);
    }

    const workspaceName = coder.workspaceName?.trim();
    if (!workspaceName) {
      return Ok(undefined);
    }

    // Prefer the archive operation's policy snapshot: it is the same read the sink used to
    // enforce forbidCoderWorkspaceDeletion, so a concurrent settings flip cannot turn a
    // guarded archive into a remote deletion.
    const archiveBehavior = coderWorkspaceArchiveBehavior ?? options.getArchiveBehavior();
    if (archiveBehavior === "keep") {
      return Ok(undefined);
    }

    if (archiveBehavior === "delete") {
      log.debug("Deleting Coder workspace before mux archive", {
        workspaceId,
        coderWorkspaceName: workspaceName,
      });

      try {
        await options.coderService.deleteWorkspace(workspaceName);
        return Ok(undefined);
      } catch (error) {
        return Err(
          `Failed to delete Coder workspace "${workspaceName}": ${getErrorMessage(error)}`
        );
      }
    }

    // Best-effort: skip the stop call if the control-plane already thinks the workspace is down.
    const status = await options.coderService.getWorkspaceStatus(workspaceName, {
      timeoutMs: DEFAULT_STATUS_TIMEOUT_MS,
    });

    if (isAlreadyStoppedOrGone(status)) {
      return Ok(undefined);
    }

    log.debug("Stopping Coder workspace before mux archive", {
      workspaceId,
      coderWorkspaceName: workspaceName,
      statusKind: status.kind,
      status: status.kind === "ok" ? status.status : undefined,
    });

    const stopResult = await options.coderService.stopWorkspace(workspaceName, { timeoutMs });
    if (!stopResult.success) {
      return Err(`Failed to stop Coder workspace "${workspaceName}": ${stopResult.error}`);
    }

    return Ok(undefined);
  };
}

export function createCoderUnarchiveHook(options: {
  coderService: CoderService;
  getArchiveBehavior: () => CoderWorkspaceArchiveBehavior;
  timeoutMs?: number;
  stoppingWaitTimeoutMs?: number;
  stoppingPollIntervalMs?: number;
}): AfterUnarchiveHook {
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  return async ({ workspaceId, workspaceMetadata }): Promise<Result<void>> => {
    const runtimeConfig = workspaceMetadata.runtimeConfig;
    if (!isSSHRuntime(runtimeConfig) || !runtimeConfig.coder) {
      return Ok(undefined);
    }

    const coder = runtimeConfig.coder;

    // Important safety invariant:
    // Only start Coder workspaces that mux created (dedicated workspaces). If the user connected
    // mux to an existing Coder workspace, unarchiving in mux should *not* start their environment.
    if (coder.existingWorkspace === true) {
      return Ok(undefined);
    }

    const workspaceName = coder.workspaceName?.trim();
    if (!workspaceName) {
      return Ok(undefined);
    }

    if (options.getArchiveBehavior() !== "stop") {
      return Ok(undefined);
    }

    let status = await options.coderService.getWorkspaceStatus(workspaceName, {
      timeoutMs: DEFAULT_STATUS_TIMEOUT_MS,
    });

    // Unarchive can happen immediately after archive, while the Coder workspace is still
    // transitioning through "stopping". Starting during that transition can fail, so we
    // best-effort poll briefly until it reaches a terminal state.
    if (status.kind === "ok" && status.status === "stopping") {
      const waitTimeoutMs = options.stoppingWaitTimeoutMs ?? DEFAULT_STOPPING_WAIT_TIMEOUT_MS;
      const pollIntervalMs = options.stoppingPollIntervalMs ?? DEFAULT_STOPPING_POLL_INTERVAL_MS;
      const deadlineMs = Date.now() + waitTimeoutMs;

      log.debug(
        "Coder workspace is still stopping after mux unarchive; waiting briefly before starting",
        {
          workspaceId,
          coderWorkspaceName: workspaceName,
          waitTimeoutMs,
          pollIntervalMs,
        }
      );

      while (status.kind === "ok" && status.status === "stopping") {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          break;
        }

        await sleep(Math.min(pollIntervalMs, remainingMs));

        const statusRemainingMs = deadlineMs - Date.now();
        if (statusRemainingMs <= 0) {
          break;
        }

        status = await options.coderService.getWorkspaceStatus(workspaceName, {
          timeoutMs: Math.min(DEFAULT_STATUS_TIMEOUT_MS, statusRemainingMs),
        });
      }

      if (status.kind === "ok" && status.status === "stopping") {
        log.debug("Timed out waiting for Coder workspace to stop after mux unarchive", {
          workspaceId,
          coderWorkspaceName: workspaceName,
          waitTimeoutMs,
        });
        return Ok(undefined);
      }
    }

    // If the workspace is gone, that's "good enough" — there's nothing to start.
    if (status.kind === "not_found") {
      return Ok(undefined);
    }

    if (status.kind === "error") {
      log.debug("Skipping Coder workspace start after mux unarchive due to status check error", {
        workspaceId,
        coderWorkspaceName: workspaceName,
        error: status.error,
      });
      return Ok(undefined);
    }

    // Best-effort: don't start if the control-plane already thinks the workspace is coming up.
    if (isAlreadyRunningOrStarting(status)) {
      return Ok(undefined);
    }

    // Only start when the workspace is definitively stopped.
    if (status.status !== "stopped") {
      return Ok(undefined);
    }

    log.debug("Starting Coder workspace after mux unarchive", {
      workspaceId,
      coderWorkspaceName: workspaceName,
      status: status.status,
    });

    const startResult = await options.coderService.startWorkspace(workspaceName, { timeoutMs });
    if (!startResult.success) {
      return Err(`Failed to start Coder workspace "${workspaceName}": ${startResult.error}`);
    }

    return Ok(undefined);
  };
}
