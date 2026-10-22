import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import { Err, Ok, type Result } from "@/common/types/result";
import { getDaytonaSandboxId, isDedicatedDaytonaSandbox } from "@/common/types/runtime";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import type { BeforeArchiveHook } from "@/node/services/workspaceLifecycleHooks";
import { notOwnedSandboxNotice, type DaytonaService } from "./daytonaService";

const DAYTONA_STOP_TIMEOUT_MS = 60_000;

/**
 * Archive reuses the Coder archive behavior setting (keep, stop, delete) for sandboxes Xum
 * created; attached sandboxes are never stopped or deleted, and no sandbox another workspace
 * still references is touched at all. Otherwise Xum's ssh access (token, include block) is
 * released. No unarchive hook: ensureReady starts a stopped sandbox and mints a token on the
 * next use.
 */
export interface DaytonaArchiveHookOptions {
  daytonaService: Pick<
    DaytonaService,
    | "getSandboxState"
    | "stopAndWait"
    | "deleteSandbox"
    | "sandboxOwnership"
    | "sandboxUseElsewhere"
    | "isAliasStoredElsewhere"
    | "releaseSshAccess"
    | "waitForSandboxReadiness"
    | "withAccountLease"
  >;
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
  // Its checks decide what it stops or deletes: all of it runs on one account.
  return (args) => options.daytonaService.withAccountLease(() => archiveSandbox(options, args));
}

async function archiveSandbox(
  options: DaytonaArchiveHookOptions,
  args: Parameters<BeforeArchiveHook>[0]
): Promise<Result<void>> {
  const sandboxId = storedSandboxId(args.workspaceMetadata);
  if (!sandboxId) return Ok(undefined);
  const workspaceId = args.workspaceMetadata.id;
  const others = await options.daytonaService.sandboxUseElsewhere(sandboxId, workspaceId);
  if (others === "active") {
    // The sandbox stays as it is, but ssh access is per stored string: another workspace that
    // stores the same sandbox under its other identifier (name or id) never uses this alias.
    if (!options.daytonaService.isAliasStoredElsewhere(sandboxId, workspaceId)) {
      await releaseSshAccess(options, sandboxId);
    }
    return Ok(undefined);
  }

  // A start in flight would restart the sandbox after the stop below.
  await options.daytonaService.waitForSandboxReadiness(sandboxId);
  // Only archived workspaces left on it: nobody works there now, so the archive setting applies,
  // for this workspace's own sandbox or for one whose archived owner left it to this archive.
  const owned =
    isDedicatedDaytonaSandbox(args.workspaceMetadata.runtimeConfig) || others === "archivedOwner";
  const result = owned
    ? await applyArchiveBehavior(options, args, sandboxId, others !== "none")
    : Ok(undefined);
  if (result.success) await releaseSshAccess(options, sandboxId);
  return result;
}

async function applyArchiveBehavior(
  options: DaytonaArchiveHookOptions,
  args: Parameters<BeforeArchiveHook>[0],
  sandboxId: string,
  archivedOthers: boolean
): Promise<Result<void>> {
  // The archive operation's policy snapshot wins (see the Coder hook).
  const behavior = args.coderWorkspaceArchiveBehavior ?? options.getArchiveBehavior();
  if (behavior === "keep") return Ok(undefined);
  try {
    // Neither policy, nor the delete checks' start, touches a sandbox that is not Xum's.
    if ((await options.daytonaService.sandboxOwnership(sandboxId)) === "notOwned") {
      args.reportWarning?.(notOwnedSandboxNotice(sandboxId));
      return Ok(undefined);
    }
    if (behavior === "delete") {
      return archivedOthers
        ? await stopInsteadOfDelete(options, args, sandboxId)
        : await deleteForArchive(options, args, sandboxId);
    }
    return await stopForArchive(options, args, sandboxId);
  } catch (error) {
    return Err(`Failed to ${behavior} Daytona sandbox "${sandboxId}": ${getErrorMessage(error)}`);
  }
}

/**
 * Archived workspaces still have checkouts on the sandbox: they were never checked for
 * unsaved work, and unarchiving one needs the sandbox back. So it is stopped, not deleted.
 */
async function stopInsteadOfDelete(
  options: DaytonaArchiveHookOptions,
  args: Parameters<BeforeArchiveHook>[0],
  sandboxId: string
): Promise<Result<void>> {
  const stopped = await stopForArchive(options, args, sandboxId);
  if (stopped.success) args.reportWarning?.(stoppedNotDeletedNotice(sandboxId));
  return stopped;
}

export function stoppedNotDeletedNotice(sandboxId: string): string {
  return `Daytona sandbox "${sandboxId}" was stopped, not deleted: an archived workspace still has its checkout on it.`;
}

/**
 * The archive setting for a sandbox whose last use just ended while archived workspaces stay on
 * it (see archiveSandbox): "delete" stops too, since they still have their checkouts there.
 * The caller proved the sandbox is Xum's. Undefined when nothing was done, else the notice.
 */
export async function applyArchiveSettingToIdleSandbox(
  daytonaService: Pick<DaytonaService, "getSandboxState" | "stopAndWait">,
  behavior: CoderWorkspaceArchiveBehavior,
  sandboxId: string,
  now: () => number = Date.now
): Promise<{ notice?: string } | undefined> {
  if (behavior === "keep") return undefined;
  const { state } = await daytonaService.getSandboxState(sandboxId);
  if (!isRunning(state)) return undefined;
  log.debug("Stopping a Daytona sandbox that only archived workspaces use", { sandboxId });
  await daytonaService.stopAndWait(sandboxId, now() + DAYTONA_STOP_TIMEOUT_MS);
  return behavior === "delete" ? { notice: stoppedNotDeletedNotice(sandboxId) } : {};
}

/** The sandbox as the archived workspace stores it (its name or its id). */
function storedSandboxId(workspaceMetadata: WorkspaceMetadata): string | undefined {
  // A shared-checkout sub-agent copies its parent's runtime config, sandbox ID included:
  // the sandbox and its access belong to the parent.
  if (workspaceMetadata.taskIsolation === "none") return undefined;
  return getDaytonaSandboxId(workspaceMetadata.runtimeConfig);
}

/** The archived workspace needs no token; unarchive mints a new one. */
async function releaseSshAccess(
  options: DaytonaArchiveHookOptions,
  sandboxId: string
): Promise<void> {
  try {
    await options.daytonaService.releaseSshAccess(sandboxId);
  } catch (error) {
    log.warn("Failed to release Daytona ssh access on archive", {
      sandboxId,
      error: getErrorMessage(error),
    });
  }
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
  // Both outcomes (delete, or stop when the checks fail) end a surviving job.
  const refusal = await refuseUnderRemoteJobs(options, args, sandboxId);
  if (refusal) return Err(refusal);
  const check = options.checkSandboxDeletable
    ? await options.checkSandboxDeletable(args.workspaceMetadata)
    : Err("its worktree could not be checked for uncommitted work");
  if (check.success) {
    // Not Xum's after all (see deleteSandbox): it is neither deleted nor stopped.
    if ((await options.daytonaService.deleteSandbox(sandboxId)) === "notOwned") {
      args.reportWarning?.(notOwnedSandboxNotice(sandboxId));
    }
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
  const refusal = await refuseUnderRemoteJobs(options, args, sandboxId, state);
  if (refusal) return Err(refusal);
  log.debug("Stopping Daytona sandbox before archive", { sandboxId, state });
  await stopSandbox(options, sandboxId);
  return Ok(undefined);
}

/**
 * Why a model-driven archive must not stop or delete the sandbox: a detached job may survive
 * in it. A sandbox that is not running has no job to end.
 */
async function refuseUnderRemoteJobs(
  options: DaytonaArchiveHookOptions,
  args: Parameters<BeforeArchiveHook>[0],
  sandboxId: string,
  knownState?: string
): Promise<string | undefined> {
  if (args.refuseStopUnderUnverifiedRemoteJobs !== true) return undefined;
  const state = knownState ?? (await options.daytonaService.getSandboxState(sandboxId)).state;
  if (!isRunning(state)) return undefined;
  return probeRemoteJobs(options, args.workspaceMetadata, sandboxId);
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
