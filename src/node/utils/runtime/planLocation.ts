import * as path from "path";
import assert from "@/common/utils/assert";
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
import { log } from "@/node/services/log";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { execBuffered, throwIfTransportFailure } from "@/node/utils/runtime/helpers";
import { REMOTE_PLAN_MIGRATION_LOCK_TIMEOUT_MS } from "@/constants/planReview";

/**
 * Where one workspace's plan lives. The one policy every plan reader, existence probe, attachment,
 * rename, fork and deletion uses, so none of them can disagree on which files are the plan.
 */
export interface PlanFileLocation {
  /** The plan: read first, and the only path Xum writes or deletes as the plan. */
  planPath: string;
  /**
   * Local and container rows only: plans/<workspaceId>.md from older builds, read (and moved to
   * planPath) when planPath is missing, deleted with the plan. SSH rows never read it after their
   * one-shot migration (migrateRemotePlan), which copies it and leaves it in place.
   */
  legacyIdPath?: string;
}

/** The Config methods plan locations read: the installation identity and the per-row flag. */
export type PlanLocationConfig = Pick<
  Config,
  "getInstallationId" | "isRemotePlanMigrated" | "markRemotePlanMigrated" | "sessionsDir"
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
    isRemotePlanMigrated: (workspaceId) => config.isRemotePlanMigrated(workspaceId),
    markRemotePlanMigrated: (workspaceId) => config.markRemotePlanMigrated(workspaceId),
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
 * The plan path of `owner` on `runtime`'s storage, without migrating anything. SSH and Coder
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

/**
 * Resolve where `owner`'s plan lives (see PlanFileLocation). For an SSH row not yet migrated this
 * runs its one-shot migration first (migrateRemotePlan), so a caller only ever sees the scoped path.
 * A migration that fails throws: the caller fails closed instead of treating the plan as missing.
 */
export async function resolvePlanFileLocation(
  config: PlanLocationConfig,
  runtime: Runtime,
  owner: PlanOwner
): Promise<PlanFileLocation> {
  const xumHome = runtime.getXumHome();
  const planPath = await resolvePlanFilePath(config, runtime, owner);
  if (!usesInstallationScopedPlans(owner.runtimeConfig)) {
    return { planPath, legacyIdPath: getLegacyPlanFilePath(owner.id, xumHome) };
  }
  if (!config.isRemotePlanMigrated(owner.id)) {
    await migrateRemotePlan(config, runtime, owner, planPath, false);
  }
  return { planPath };
}

/** Run `fn` holding `workspaceId`'s plan-migration lock (in-process and across backends). */
async function withMigrationLock<T>(
  config: Pick<PlanLocationConfig, "sessionsDir">,
  workspaceId: string,
  fn: () => Promise<T>
): Promise<T> {
  // In the workspace's session directory: local to this installation, like the config row whose
  // flag it guards.
  await using _lock = await acquireProcessFileLock({
    lockPath: path.join(config.sessionsDir, workspaceId, "remote-plan-migration.lock"),
    timeoutMs: REMOTE_PLAN_MIGRATION_LOCK_TIMEOUT_MS,
    label: "plan migration lock",
  });
  return await fn();
}

/**
 * Mark an SSH row migrated before a clear or a removal deletes its scoped plan, under the migration
 * lock: a migration that started earlier re-checks the flag under that lock, so it can no longer
 * copy a legacy plan back in after the delete. No-op for rows already migrated and for non-SSH
 * rows.
 */
export async function markRemotePlanMigratedForDeletion(
  config: PlanLocationConfig,
  owner: Pick<PlanOwner, "id" | "runtimeConfig">
): Promise<void> {
  if (!usesInstallationScopedPlans(owner.runtimeConfig) || config.isRemotePlanMigrated(owner.id)) {
    return;
  }
  await withMigrationLock(config, owner.id, () => config.markRemotePlanMigrated(owner.id));
}

/**
 * An SSH plan migration that could not finish (not a transport failure, which keeps its own
 * error): the row stays unmigrated, so the next resolution retries, and the caller fails closed.
 */
export class RemotePlanMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemotePlanMigrationError";
  }
}

/** Exit codes of migrateRemotePlanScript. */
const MIGRATION_EXIT = {
  copied: 0,
  scopedExists: 3,
  sharedOnly: 4,
  notRegular: 5,
  noLegacy: 6,
  unverified: 7,
} as const;

/**
 * The SSH plan migration (#5174) on the host. A scoped plan that already exists wins. Else the
 * workspace's own plan at plans/<workspace id>.md is copied in; the shared pre-#5174 path
 * plans/<project>/<name>.md only when `imp=1` (the user's explicit import, Option B: another
 * installation may own that file). The copy: write a temp file, fsync it, hard-link it into place
 * (never replacing a plan that appeared meanwhile), fsync the directories. Only then may the caller
 * set the row flag, so a power cut can leave no scoped file or the whole plan, never an empty one
 * shadowing the legacy plan. Legacy files are never moved, deleted or written: another
 * installation, or an older build of this one, may still use them.
 *
 * GNU and uutils `sync FILE...` fsync the named files and directories; a sync without file
 * arguments (busybox) flushes everything, which is slower but just as durable.
 *
 * "No legacy plan" needs confirmed absence (#5620): `[ -f ]` is also false when a folder on the
 * way cannot be searched or a stat fails, and reading that as absence would mark the row migrated
 * and hide its legacy plan for good. `known` accepts a path that exists, or whose nearest existing
 * ancestor is a searchable directory (so the lookup below it found nothing); anything else exits
 * `unverified`, and the row stays unmigrated for the next access to retry.
 */
function migrateRemotePlanScript(importShared: boolean): string {
  return [
    `imp=${importShared ? 1 : 0}; p="$XUM_PLAN"; d="\${p%/*}"`,
    'syncp() { sync -- "$@" 2>/dev/null || sync; }',
    `scoped() { [ -f "$p" ] || exit ${MIGRATION_EXIT.notRegular}; syncp "$p" "$d"; exit ${MIGRATION_EXIT.scopedExists}; }`,
    'ex() { [ -e "$1" ] || [ -L "$1" ]; }',
    `known() { ex "$1" && return 0; a="\${1%/*}"; while ! ex "$a"; do [ "\${a%/*}" = "$a" ] && exit ${MIGRATION_EXIT.unverified}; a="\${a%/*}"; done; { [ -d "$a" ] && [ -x "$a" ]; } || exit ${MIGRATION_EXIT.unverified}; }`,
    'ex "$p" && scoped',
    'if [ -f "$XUM_ID_PLAN" ]; then src="$XUM_ID_PLAN"',
    `elif known "$XUM_ID_PLAN" && [ -f "$XUM_SHARED_PLAN" ]; then [ "$imp" = 1 ] || exit ${MIGRATION_EXIT.sharedOnly}; src="$XUM_SHARED_PLAN"`,
    `else known "$XUM_SHARED_PLAN"; exit ${MIGRATION_EXIT.noLegacy}; fi`,
    'mkdir -p "$d" || exit 1; t="$p.migrate.$$"',
    'if cp -- "$src" "$t" && syncp "$t" && ln -- "$t" "$p"; then r=0; else r=1; fi',
    'rm -f -- "$t"',
    // A failed link with a plan in place: another backend's migration or the agent's first write
    // linked first, and theirs wins.
    'if [ "$r" -ne 0 ]; then { [ -e "$p" ] || [ -L "$p" ]; } && scoped; exit 1; fi',
    `syncp "$d" "\${d%/*}" "\${d%/*/*}"; exit ${MIGRATION_EXIT.copied}`,
  ].join("\n");
}

/** What a migration found: "sharedOnly" is a row whose only legacy plan is the shared path. */
type MigrationOutcome = "copied" | "scopedExists" | "noLegacy" | "sharedOnly" | "alreadyMigrated";

/**
 * Migrate an SSH row's plan into its installation-scoped path (see migrateRemotePlanScript), then
 * set the row flag, after which every read uses the scoped path only: a missing scoped plan, or an
 * identity reset that starts an empty namespace, never brings a legacy file back. Under the
 * migration lock with the flag re-checked, so a clear that marked the row first wins.
 *
 * Automatic (`importShared` false): a row whose only legacy plan is the shared path imports
 * nothing and stays unmigrated, so the user can still import it (Option B). The row
 * reads its scoped path only; its first plan write there migrates it ("scopedExists").
 */
async function migrateRemotePlan(
  config: PlanLocationConfig,
  runtime: Runtime,
  owner: PlanOwner,
  planPath: string,
  importShared: boolean
): Promise<MigrationOutcome> {
  const xumHome = runtime.getXumHome();
  const idPlanPath = getLegacyPlanFilePath(owner.id, xumHome);
  const sharedPlanPath = getPlanFilePath(owner.name, owner.projectName, xumHome);
  return withMigrationLock(config, owner.id, async () => {
    if (config.isRemotePlanMigrated(owner.id)) return "alreadyMigrated";
    const result = await execBuffered(runtime, migrateRemotePlanScript(importShared), {
      cwd: "/tmp",
      pathEnv: { XUM_PLAN: planPath, XUM_ID_PLAN: idPlanPath, XUM_SHARED_PLAN: sharedPlanPath },
      timeout: 10,
    });
    throwIfTransportFailure(runtime, result, "Failed to migrate the plan file");
    let outcome: MigrationOutcome;
    switch (result.exitCode) {
      case MIGRATION_EXIT.copied:
        outcome = "copied";
        break;
      case MIGRATION_EXIT.scopedExists:
        outcome = "scopedExists";
        break;
      case MIGRATION_EXIT.noLegacy:
        outcome = "noLegacy";
        break;
      case MIGRATION_EXIT.sharedOnly:
        return "sharedOnly";
      case MIGRATION_EXIT.notRegular:
        throw new RemotePlanMigrationError(
          `Cannot migrate the plan of workspace ${owner.name}: ${planPath} exists and is not a regular file`
        );
      case MIGRATION_EXIT.unverified:
        throw new RemotePlanMigrationError(
          `Cannot migrate the plan of workspace ${owner.name}: Xum cannot check whether ${idPlanPath} or ${sharedPlanPath} exists (a folder on the way cannot be searched). Xum retries on the next access.`
        );
      default:
        throw new RemotePlanMigrationError(
          `Failed to migrate the plan of workspace ${owner.name} to ${planPath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
        );
    }
    // The scoped plan (or its absence) is final and durable now. A failed flag write only repeats
    // the migration next time, which then finds the scoped plan (or still no legacy plan).
    await config.markRemotePlanMigrated(owner.id).catch((error: unknown) => {
      log.warn("Failed to record a migrated SSH plan", {
        workspaceId: owner.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return outcome;
  });
}

/**
 * The shared pre-#5174 plan path a user can import into an SSH row (Option B), or undefined. Runs
 * the row's automatic migration (as resolvePlanFileLocation does) and offers the path only when
 * that migration found the shared file to be the row's only legacy plan, so a row left unmarked by
 * a failed flag write is never offered a file that is not there.
 */
export async function findImportableLegacyPlanPath(
  config: PlanLocationConfig,
  runtime: Runtime,
  owner: PlanOwner
): Promise<string | undefined> {
  if (!usesInstallationScopedPlans(owner.runtimeConfig) || config.isRemotePlanMigrated(owner.id)) {
    return undefined;
  }
  const planPath = await resolvePlanFilePath(config, runtime, owner);
  const outcome = await migrateRemotePlan(config, runtime, owner, planPath, false);
  return outcome === "sharedOnly"
    ? getPlanFilePath(owner.name, owner.projectName, runtime.getXumHome())
    : undefined;
}

/** Result of importLegacyRemotePlan. */
export type LegacyPlanImportResult =
  /** The legacy plan was copied into planPath. */
  | { status: "imported"; planPath: string }
  /** planPath already holds a plan, which was kept: a repeated import changes nothing. */
  | { status: "already_present"; planPath: string }
  /** No legacy plan to import (none on the host, or the row already migrated without one). */
  | { status: "nothing_to_import"; planPath: string };

/**
 * The user's explicit import of an SSH row's legacy plan (Option B, #5174): the same migration
 * with the shared pre-#5174 path allowed as a source (the row's own plans/<id>.md still wins).
 * Never replaces a plan at planPath, so it is idempotent, and never moves or deletes the legacy
 * file. Throws InstallationIdentityError or RemotePlanMigrationError like a resolution would.
 */
export async function importLegacyRemotePlan(
  config: PlanLocationConfig,
  runtime: Runtime,
  owner: PlanOwner
): Promise<LegacyPlanImportResult> {
  assert(usesInstallationScopedPlans(owner.runtimeConfig), "legacy plan import is SSH-only");
  const planPath = await resolvePlanFilePath(config, runtime, owner);
  const outcome = await migrateRemotePlan(config, runtime, owner, planPath, true);
  switch (outcome) {
    case "copied":
      return { status: "imported", planPath };
    case "scopedExists":
      return { status: "already_present", planPath };
    case "alreadyMigrated": {
      // Migrated earlier (an earlier import, a migration, a clear): report what is there.
      const present = await execBuffered(runtime, '[ -f "$XUM_PLAN" ]', {
        cwd: "/tmp",
        pathEnv: { XUM_PLAN: planPath },
        timeout: 10,
      });
      throwIfTransportFailure(runtime, present, "Failed to check the plan file");
      return {
        status: present.exitCode === 0 ? "already_present" : "nothing_to_import",
        planPath,
      };
    }
    case "noLegacy":
      return { status: "nothing_to_import", planPath };
    case "sharedOnly":
      // Unreachable: an import copies a shared-only plan.
      throw new RemotePlanMigrationError(`Unexpected migration outcome for ${owner.name}`);
  }
}
