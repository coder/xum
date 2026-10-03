import * as path from "path";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  getInstallationScopedPlanFilePath,
  getLegacyPlanFilePath,
  getPlanFilePath,
  usesInstallationScopedPlans,
} from "@/common/utils/planStorage";
import type { Config } from "@/node/config";
import type { Runtime } from "@/node/runtime/Runtime";
import { createRemoteProjectId } from "@/node/runtime/remoteProjectLayout";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { REMOTE_PLAN_LEGACY_LOCK_TIMEOUT_MS } from "@/constants/planReview";

/**
 * The shared pre-#5174 SSH plan path plans/<project basename>/<name>.md, which every installation
 * on the host used. Another installation's workspace may own a plan there, so Xum only ever reads
 * it: never moves, deletes or writes it.
 */
export interface SharedLegacyPlanFallback {
  path: string;
  /** Fresh read of the row's flag: a clear may have retired it after this location was resolved. */
  isRetired(): boolean;
  /** Persist the retirement; monotone, never undone. */
  retire(): Promise<void>;
  /**
   * Run `fn` holding this workspace's legacy-plan lock (in-process and across backends sharing the
   * data root). A legacy plan's copy into planPath and a full clear's retirement both run under it,
   * so a read that saw the fallback open cannot copy the legacy plan back in after a clear retired
   * it and deleted planPath: it re-checks isRetired() under the lock first.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Where one workspace's plan lives. The one policy every plan reader, existence probe, attachment,
 * rename, fork and deletion uses, so none of them can disagree on which files are the plan.
 */
export interface PlanFileLocation {
  /** The plan: read first, and the only path Xum writes or deletes as the plan. */
  planPath: string;
  /**
   * plans/<workspaceId>.md from older builds. Workspace ids are random, so it is provably this
   * workspace's: read (and moved to planPath) when planPath is missing, deleted with the plan.
   */
  legacyIdPath: string;
  /** SSH rows whose legacy fallback is not retired (older rows): read-only, last. */
  sharedLegacy?: SharedLegacyPlanFallback;
}

/** The Config methods plan locations read: the installation identity and the per-row flag. */
export type PlanLocationConfig = Pick<
  Config,
  | "getInstallationId"
  | "isRemotePlanLegacyFallbackRetired"
  | "retireRemotePlanLegacyFallback"
  | "sessionsDir"
>;

/**
 * `config` with its installation identity fixed to `installationId`, for callers that resolve
 * several plan paths from one identity snapshot (a turn: its plan and its ancestors' paths).
 */
export function withInstallationId(
  config: PlanLocationConfig,
  installationId: string
): PlanLocationConfig {
  return {
    getInstallationId: () => Promise.resolve(installationId),
    isRemotePlanLegacyFallbackRetired: (workspaceId) =>
      config.isRemotePlanLegacyFallbackRetired(workspaceId),
    retireRemotePlanLegacyFallback: (workspaceId) =>
      config.retireRemotePlanLegacyFallback(workspaceId),
    sessionsDir: config.sessionsDir,
  };
}

/** The workspace fields a plan location depends on. */
export interface PlanOwner {
  id: string;
  name: string;
  projectName: string;
  projectPath: string;
  runtimeConfig: RuntimeConfig;
}

/**
 * The plan path of `owner` on `runtime`'s storage, without the legacy fallbacks. SSH and Coder
 * runtimes need this installation's identity: without it there is no remote plan path, and the
 * InstallationIdentityError propagates so callers fail closed.
 */
export async function resolvePlanFilePath(
  config: Pick<Config, "getInstallationId">,
  runtime: Runtime,
  owner: Pick<PlanOwner, "name" | "projectName" | "projectPath" | "runtimeConfig">
): Promise<string> {
  const xumHome = runtime.getXumHome();
  if (!usesInstallationScopedPlans(owner.runtimeConfig)) {
    return getPlanFilePath(owner.name, owner.projectName, xumHome);
  }
  return getInstallationScopedPlanFilePath(
    owner.name,
    createRemoteProjectId(owner.projectPath),
    await config.getInstallationId(),
    xumHome
  );
}

/** Resolve where `owner`'s plan lives (see PlanFileLocation). */
export async function resolvePlanFileLocation(
  config: PlanLocationConfig,
  runtime: Runtime,
  owner: PlanOwner
): Promise<PlanFileLocation> {
  const xumHome = runtime.getXumHome();
  const location: PlanFileLocation = {
    planPath: await resolvePlanFilePath(config, runtime, owner),
    legacyIdPath: getLegacyPlanFilePath(owner.id, xumHome),
  };
  if (
    usesInstallationScopedPlans(owner.runtimeConfig) &&
    !config.isRemotePlanLegacyFallbackRetired(owner.id)
  ) {
    location.sharedLegacy = {
      path: getPlanFilePath(owner.name, owner.projectName, xumHome),
      isRetired: () => config.isRemotePlanLegacyFallbackRetired(owner.id),
      retire: () => config.retireRemotePlanLegacyFallback(owner.id),
      exclusive: async (fn) => {
        // In the workspace's session directory: local to this installation, like the config row
        // whose flag it guards.
        await using _lock = await acquireProcessFileLock({
          lockPath: path.join(config.sessionsDir, owner.id, "remote-plan-legacy.lock"),
          timeoutMs: REMOTE_PLAN_LEGACY_LOCK_TIMEOUT_MS,
          label: "legacy plan lock",
        });
        return await fn();
      },
    };
  }
  return location;
}
