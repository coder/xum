import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import { Err, Ok, type Result } from "@/common/types/result";
import { getDaytonaSandboxId, isDedicatedDaytonaSandbox } from "@/common/types/runtime";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import type { BeforeArchiveHook } from "@/node/services/workspaceLifecycleHooks";
import type { DaytonaService } from "./daytonaService";

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
    | "isSandboxReferencedElsewhere"
    | "releaseSshAccess"
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
  const sandboxId = await unsharedSandboxId(options, args.workspaceMetadata);
  if (!sandboxId) return Ok(undefined);

  const result = isDedicatedDaytonaSandbox(args.workspaceMetadata.runtimeConfig)
    ? await applyArchiveBehavior(options, args, sandboxId)
    : Ok(undefined);
  if (result.success) await releaseSshAccess(options, sandboxId);
  return result;
}

async function applyArchiveBehavior(
  options: DaytonaArchiveHookOptions,
  args: Parameters<BeforeArchiveHook>[0],
  sandboxId: string
): Promise<Result<void>> {
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
}

/** The archived workspace's sandbox, unless another workspace (archived ones too) uses it. */
async function unsharedSandboxId(
  options: DaytonaArchiveHookOptions,
  workspaceMetadata: WorkspaceMetadata
): Promise<string | undefined> {
  // A shared-checkout sub-agent copies its parent's runtime config, sandbox ID included:
  // the sandbox belongs to the parent.
  if (workspaceMetadata.taskIsolation === "none") return undefined;
  const sandboxId = getDaytonaSandboxId(workspaceMetadata.runtimeConfig);
  if (!sandboxId) return undefined;
  if (await options.daytonaService.isSandboxReferencedElsewhere(sandboxId, workspaceMetadata.id)) {
    return undefined;
  }
  return sandboxId;
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
