import * as path from "node:path";
import { listBackupManagedPathSpellings } from "@/common/compat/legacyMux";
import { VERSION } from "@/version";
import type { Config } from "@/node/config";
import type { BackupFileChange, BackupProjectImport } from "@/common/orpc/schemas/backup";
import { normalizeUserPreferences } from "@/common/config/schemas/userPreferences";
import {
  MAX_BACKUP_PROJECT_ENTRIES,
  sanitizeBackupGitRemote,
  type BackupProjectBundleEntry,
} from "@/common/config/schemas/settingsBackup";
import { AsyncSemaphore } from "@/node/utils/concurrency/asyncSemaphore";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import type { ProjectConfig } from "@/common/types/project";
import { getProjectDisplayName } from "@/common/utils/subProjects";
import { projectMemoryDirName } from "@/node/services/memoryService";
import {
  memoryMutationLockKey,
  withTargetMutationLock,
} from "@/node/services/refinement/targetMutationLocks";
import { execFileAsync } from "@/node/utils/disposableExec";
import {
  BackupServiceError,
  type BackupGitRepo,
  type BackupPayloadStore,
  type PreparedBackupRepository,
} from "./backupService";
import { BACKUP_GIT_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import { BackupRepoCache } from "./gitRepo";
import {
  PROJECT_BUNDLE_DIR,
  PROJECT_BUNDLE_MANIFEST_PATH,
  ProjectMemoryRestoreError,
  ProjectMemoryWriteError,
  assertManagedTreeWithinLimits,
  backupPayloadExists,
  bundleEntryFiles,
  serializeProjectBundleManifest,
  collectProjectBundle,
  planProjectBundleRestore,
  projectBundleExists,
  projectImportToken,
  readProjectBundle,
  rekeyProjectMemoryPath,
  resolveContainedPath,
  writeProjectBundle,
  writeProjectMemoryFiles,
  assertBackupCommandsApproved,
  collectMcpCommandApprovals,
  resolveRestoredContent,
  collectAllowlistedFiles,
  createBackupPayload,
  mergeBackupPreferences,
  projectBackupPreferences,
  localOnlyPayloadFiles,
  planRestoreWrites,
  readBackupPayload,
  restoreBackupPayload,
  backupSecretApprovalDigest,
  scanBackupFilesForSecrets,
  serializeBackupPreferences,
  writeBackupPayload,
  type BackupFile,
  type BackupProjectBundle,
  type ProjectBundleRestorePlan,
} from "./payload";

/**
 * Parses `git status --porcelain=v1 -z`, whose records are NUL-terminated with verbatim
 * pathnames. A rename or copy spends a second record on its source path, which is consumed
 * here rather than reported: the destination is what a push writes.
 */
function parsePorcelainStatus(output: string): BackupFileChange[] {
  const records = output.split("\0").filter(Boolean);
  const changes: BackupFileChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const status = record.slice(0, 2).trim() || "?";
    changes.push({ status, path: record.slice(3) });
    if (status.startsWith("R") || status.startsWith("C")) index += 1;
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * BackupService prepares the cache before push-related calls. Retaining that instance
 * preserves the fetched base commit used by the push guard.
 */
export function createBackupGitRepo(options: {
  cacheRoot: string;
  timeoutMs?: number;
}): BackupGitRepo {
  const prepared = new WeakMap<PreparedBackupRepository, BackupRepoCache>();

  function newCache(settings: { repoUrl: string; branch: string; path: string }): BackupRepoCache {
    return new BackupRepoCache({
      ...settings,
      managedPath: settings.path,
      cacheRoot: options.cacheRoot,
      timeoutMs: options.timeoutMs ?? BACKUP_GIT_TIMEOUT_MS,
    });
  }

  function cacheFor(repository: PreparedBackupRepository): BackupRepoCache {
    const cache = prepared.get(repository);
    if (!cache) throw new Error("Backup repository was not prepared");
    return cache;
  }

  return {
    async validate(settings) {
      const cache = newCache(settings);
      const refs = await cache.lsRemote();
      return { credential: refs.credential, empty: refs.refs.size === 0 };
    },

    async prepare(settings, options) {
      const cache = newCache(settings);
      let remoteCommit: string | null;
      try {
        remoteCommit = await cache.materialize();
      } catch (error) {
        const cleanup = options?.onPrepareError?.(cache.cachePath);
        await cleanup?.catch(() => undefined);
        throw error;
      }
      const repository = {
        rootDir: cache.cachePath,
        credential: cache.credential ?? "ambient",
        remoteCommit,
        managedPath: cache.effectiveManagedPath,
      };
      prepared.set(repository, cache);
      return repository;
    },

    async getPushChanges(repository) {
      return parsePorcelainStatus(await cacheFor(repository).porcelainStatus());
    },

    async commitAndPush(repository, commitOptions) {
      const cache = cacheFor(repository);
      const commit = await cache.stageAndCommit(commitOptions.message);
      if (commit == null) {
        // Nothing to commit, but the remote may have moved since prepare(). Reporting
        // "unchanged" without checking would persist a commit that no longer describes
        // the repository, and this path never reaches the check inside push().
        await cache.assertRemoteUnchanged();
        return {
          commit: commitOptions.expectedRemoteCommit ?? "",
          changed: false,
          credential: cache.credential ?? repository.credential,
        };
      }
      const commitSha = await cache.push();
      return {
        commit: commitSha,
        changed: true,
        credential: cache.credential ?? repository.credential,
      };
    },
  };
}

/**
 * `muxVersion` is provenance only, but writing it as undefined drops the key from the
 * manifest and makes the backup unreadable, so never let a missing build stamp through.
 */
function resolveMuxVersion(): string {
  const describe: unknown = VERSION.git_describe;
  return typeof describe === "string" && describe.length > 0 ? describe : "unknown";
}

/**
 * Bridges payload collection to the service-level contract. Preferences are read
 * from and written through `Config` rather than the config file so restores reuse
 * schema validation and reach open windows through the existing change stream.
 */
function sameMode(a: BackupFile, b: BackupFile): boolean {
  return (a.executable === true) === (b.executable === true);
}

/**
 * Names every spelling that was considered, so the error explains the legacy fallback.
 * The repository preparation selects the legacy `mux` spelling whenever it holds a
 * manifest and the configured spelling does not, so reaching this with the configured
 * path means the legacy spelling was checked and held no backup either.
 */
function describeMissingBackup(managedPath: string): string {
  const [, ...legacySpellings] = listBackupManagedPathSpellings(managedPath);
  const fallbacks = legacySpellings.map((spelling) => `'${spelling}'`).join(" or ");
  return fallbacks === ""
    ? `No Xum backup found in '${managedPath}' on this branch`
    : `No Xum backup found in '${managedPath}' or legacy ${fallbacks} on this branch`;
}

/** Concurrent `git remote get-url` probes during bundle export. */
const REMOTE_DISCOVERY_CONCURRENCY = 8;

/** Best-effort: a missing origin, a non-git directory, or a hung git must never fail an export. */
async function readProjectGitRemote(projectPath: string): Promise<string | undefined> {
  try {
    using gitProcess = execFileAsync("git", ["-C", projectPath, "remote", "get-url", "origin"], {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
      killTreeOnTermination: true,
    });
    const { stdout } = await gitProcess.result;
    return sanitizeBackupGitRemote(stdout.trim());
  } catch {
    return undefined;
  }
}

export function createBackupPayloadStore(options: { config: Config }): BackupPayloadStore {
  const muxRoot = options.config.rootDir;

  // Walks the chain so a symlinked ancestor is rejected before writeBackupPayload's
  // recursive removal could follow it out of the cache clone.
  async function managedDir(repositoryRoot: string, managedPath: string): Promise<string> {
    const segments = managedPath.split("/").filter((segment) => segment !== "");
    return await resolveContainedPath(repositoryRoot, segments.join("/"));
  }

  function localPreferences() {
    return options.config.loadConfigOrDefault().userPreferences;
  }

  /** The portable subset an export writes. Machine-local keys are excluded by design. */
  function exportablePreferences() {
    return projectBackupPreferences(localPreferences() ?? {});
  }

  async function localFilesByPath(): Promise<Map<string, BackupFile>> {
    return new Map((await collectAllowlistedFiles(muxRoot)).map((file) => [file.path, file]));
  }

  async function buildPayload(overrides?: { keepLocalSecrets: true }) {
    return await createBackupPayload({
      muxRoot,
      preferences: exportablePreferences(),
      muxVersion: resolveMuxVersion(),
      sourceLabel: path.basename(muxRoot),
      // The service owns the user-facing override, so report rather than throw.
      reportSecrets: true,
      ...overrides,
    });
  }

  /**
   * The same lock MemoryService mutations take (its project stores resolve to the shared
   * `<muxRoot>/memory` key), so backup never becomes an uncoordinated memory writer.
   */
  function withMemoryLock<T>(operation: () => Promise<T>): Promise<T> {
    return withTargetMutationLock(
      muxRoot,
      memoryMutationLockKey(muxRoot, path.join(muxRoot, "memory")),
      operation
    );
  }

  function isSystemProjectEntry(projectPath: string, projectConfig: ProjectConfig): boolean {
    return (
      projectPath === MULTI_PROJECT_CONFIG_KEY ||
      projectPath === SCRATCH_PROJECT_CONFIG_KEY ||
      projectConfig.projectKind === "system"
    );
  }

  function userProjects(): Array<[string, ProjectConfig]> {
    return [...options.config.loadConfigOrDefault().projects.entries()].filter(
      ([projectPath, projectConfig]) => !isSystemProjectEntry(projectPath, projectConfig)
    );
  }

  /**
   * Every user project becomes an entry, including zero-memory ones: the project list is
   * half the feature. `memoryDir` records this install's actual directory name, which is
   * also what restore-side matching recomputes.
   */
  async function listProjectBundleEntries(): Promise<BackupProjectBundleEntry[]> {
    const projects = userProjects();
    // Before any lookup: an over-limit config would otherwise run every remote probe
    // only to be refused by the bundle collector afterwards.
    if (projects.length > MAX_BACKUP_PROJECT_ENTRIES) {
      throw new Error(`Backup has more than ${MAX_BACKUP_PROJECT_ENTRIES} projects`);
    }
    // Each probe has its own timeout, so sequential discovery over many projects on slow
    // filesystems could stall a preview or push for minutes; bounded parallelism keeps the
    // worst case proportional to the limit, not the project count.
    const probes = new AsyncSemaphore(REMOTE_DISCOVERY_CONCURRENCY);
    return await Promise.all(
      projects.map(async ([projectPath, projectConfig]) => {
        const slot = await probes.acquire();
        let gitRemote: string | undefined;
        try {
          gitRemote = await readProjectGitRemote(projectPath);
        } finally {
          slot.release();
        }
        return {
          path: projectPath,
          // Clamped to the manifest schema's cap so a long custom title cannot produce a
          // bundle this build's own restore would refuse.
          name: getProjectDisplayName(projectPath, projectConfig).slice(0, 256),
          ...(gitRemote !== undefined ? { gitRemote } : {}),
          memoryDir: projectMemoryDirName(projectPath),
        };
      })
    );
  }

  function registeredProjectDirs(): Map<string, string> {
    return new Map(
      userProjects().map(([projectPath]) => [projectPath, projectMemoryDirName(projectPath)])
    );
  }

  function toProjectImports(plan: ProjectBundleRestorePlan): BackupProjectImport[] {
    // Remotes were already sanitized when the manifest was parsed, so a crafted checkout
    // cannot reach the UI through this field.
    return plan.imports.map(({ entry, files, token }) => ({
      sourcePath: entry.path,
      name: entry.name,
      ...(entry.gitRemote !== undefined ? { gitRemote: entry.gitRemote } : {}),
      memoryFileCount: files.length,
      token,
    }));
  }

  async function readBundleWithPlan(
    sourceDir: string
  ): Promise<{ bundle: BackupProjectBundle; plan: ProjectBundleRestorePlan } | null> {
    const bundle = await readProjectBundle(sourceDir);
    if (bundle === null) return null;
    return { bundle, plan: planProjectBundleRestore(bundle, registeredProjectDirs()) };
  }

  /** Restore-preview statuses for matched entries, diffed against the local memory files. */
  async function matchedProjectChanges(
    plan: ProjectBundleRestorePlan
  ): Promise<BackupFileChange[]> {
    if (plan.matched.length === 0) return [];
    // Under the memory lock like every other backup read of project memory, so a
    // concurrent memory edit cannot yield a torn diff or a failed identity check.
    const localBundle = await withMemoryLock(() =>
      collectProjectBundle(
        muxRoot,
        plan.matched.map((match) => match.entry)
      )
    );
    const localByPath = new Map(localBundle.files.map((file) => [file.path, file]));
    const changes: BackupFileChange[] = [];
    for (const match of plan.matched) {
      for (const file of match.files) {
        const existing = localByPath.get(file.path);
        if (existing === undefined) {
          changes.push({ status: "A", path: file.path });
        } else if (!existing.content.equals(file.content)) {
          changes.push({ status: "M", path: file.path });
        }
      }
    }
    return changes;
  }

  return {
    async exportTo(exportOptions) {
      const payload = await buildPayload();
      const destination = await managedDir(exportOptions.repositoryRoot, exportOptions.managedPath);
      // Owner-only like the safety snapshot: the export copies allowlisted sources that may
      // themselves be owner-only, and it lands here before the secret scan has said anything
      // about it. Git records only the exec bit, so the modes never reach the remote.
      await writeBackupPayload(destination, payload, { ownerOnly: true });
      // The core write wiped the whole managed path, so with the toggle off a previously
      // pushed bundle disappears from the next tree, and with it on the sidecar is written
      // fresh after the core payload.
      let scanFiles = payload.files;
      if (exportOptions.includeProjects) {
        const entries = await listProjectBundleEntries();
        // Collected under the memory lock so an agent writing memory mid-export cannot
        // produce a torn bundle or trip the collector's identity checks.
        const bundle = await withMemoryLock(() =>
          collectProjectBundle(
            muxRoot,
            entries,
            // Restore refuses files past the memory subsystem's read limit, so exporting
            // them would only produce a backup no build can bring back.
            { portableMemoryOnly: true }
          )
        );
        await writeProjectBundle(path.join(destination, PROJECT_BUNDLE_DIR), bundle, {
          ownerOnly: true,
        });
        // Core and bundle were budgeted separately; the next checkout will bound them as
        // one tree, so refuse here what it would refuse there.
        await assertManagedTreeWithinLimits(destination);
        // One scan and one digest over everything the push would publish: core files,
        // bundle files, and the bundle manifest itself — project paths, names, and remotes
        // are published text too, and a token in a remote's path survives the URL
        // credential sanitizer.
        scanFiles = [
          ...payload.files,
          ...bundle.files,
          {
            path: PROJECT_BUNDLE_MANIFEST_PATH,
            content: serializeProjectBundleManifest(bundle.manifest),
          },
        ];
      }
      const secretFiles = scanBackupFilesForSecrets(scanFiles);
      return {
        redactions: payload.redactions,
        secretFiles,
        secretApproval: backupSecretApprovalDigest(scanFiles, secretFiles),
      };
    },

    async previewRestore(previewOptions) {
      const sourceDir = await managedDir(previewOptions.repositoryRoot, previewOptions.managedPath);
      const local = await localFilesByPath();
      // A repository with no backup yet is a normal first-run state, not an error:
      // nothing would be restored, and every local file is local-only.
      if (!(await backupPayloadExists(sourceDir))) {
        return {
          changes: [],
          localOnlyFiles: [...local.keys()].sort(),
          commandApprovals: [],
          projectImports: [],
          projectBundleSkipped: false,
        };
      }

      const payload = await readBackupPayload(sourceDir);
      // The preflight restore itself runs, so a destination this payload cannot be written to
      // fails here instead of after the user accepts a plan that cannot execute. Recomputed
      // rather than carried over to the restore, for the same reason the approvals are.
      await planRestoreWrites(muxRoot, payload);
      const restoredPaths = new Set(
        payload.files.filter((file) => file.path !== "preferences.json").map((file) => file.path)
      );
      const { localOnly, overwritten } = await localOnlyPayloadFiles(
        muxRoot,
        local.keys(),
        restoredPaths
      );
      const changes: BackupFileChange[] = [];
      for (const file of payload.files) {
        // Preferences live in config, and restore merges them rather than replacing the
        // file, so compare the merge result. A backup that only repeats values the local
        // config already holds changes nothing.
        if (file.path === "preferences.json") {
          const local = localPreferences();
          const merged = mergeBackupPreferences(local, JSON.parse(file.content.toString("utf-8")));
          if (!serializeBackupPreferences(local).equals(serializeBackupPreferences(merged))) {
            changes.push({ status: "M", path: file.path });
          }
          continue;
        }
        // Under a spelling the filesystem actually resolves this path to, so a restore that
        // overwrites a differently-cased local file reads as a change to it. Any alias will
        // do: they are one file, so they read the same content and mode.
        const existing = local.get(overwritten.get(file.path)?.[0] ?? file.path);
        if (!existing) {
          changes.push({ status: "A", path: file.path });
          continue;
        }
        // Diff what restore would write, not the raw backup: rehydrated redactions
        // would otherwise read as a change on every preview.
        const restored = await resolveRestoredContent(
          muxRoot,
          file,
          payload.manifest.mcpRedactions
        );
        if (!existing.content.equals(restored) || !sameMode(existing, file)) {
          changes.push({ status: "M", path: file.path });
        }
      }

      let projectImports: BackupProjectImport[] = [];
      let projectBundleSkipped = false;
      if (!previewOptions.includeProjects) {
        // Existence-only: with the toggle off the sidecar is never parsed, so a malformed
        // bundle cannot block a core-only preview.
        projectBundleSkipped = await projectBundleExists(sourceDir);
      } else {
        const bundlePlan = await readBundleWithPlan(sourceDir);
        if (bundlePlan !== null) {
          projectImports = toProjectImports(bundlePlan.plan);
          changes.push(...(await matchedProjectChanges(bundlePlan.plan)));
        }
      }
      return {
        changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
        localOnlyFiles: localOnly,
        commandApprovals: await collectMcpCommandApprovals(
          muxRoot,
          payload.files,
          payload.manifest.mcpRedactions
        ),
        projectImports,
        projectBundleSkipped,
      };
    },

    async validateRestore(validateOptions) {
      const sourceDir = await managedDir(
        validateOptions.repositoryRoot,
        validateOptions.managedPath
      );
      if (!(await backupPayloadExists(sourceDir))) {
        throw new BackupServiceError(
          "INVALID_BACKUP",
          describeMissingBackup(validateOptions.managedPath)
        );
      }
      const payload = await readBackupPayload(sourceDir);
      assertBackupCommandsApproved(
        await collectMcpCommandApprovals(muxRoot, payload.files, payload.manifest.mcpRedactions),
        validateOptions.approvedCommandTokens
      );
      // The same preflight the restore runs, so a payload it would refuse is refused here,
      // before the caller takes a safety snapshot it would have no use for.
      await planRestoreWrites(muxRoot, payload);
      if (!validateOptions.includeProjects) {
        return { hasProjectBundle: false, projectImports: [], matchedProjectPaths: [] };
      }
      // A bundle the restore would refuse is refused here too, for the same reason.
      const bundlePlan = await readBundleWithPlan(sourceDir);
      if (bundlePlan === null) {
        return { hasProjectBundle: false, projectImports: [], matchedProjectPaths: [] };
      }
      return {
        hasProjectBundle: true,
        projectImports: toProjectImports(bundlePlan.plan),
        // The classification the caller validated against. Restore re-partitions the
        // bundle, but only writes matched entries that were also matched here, so a
        // project registered mid-restore cannot be overwritten outside the plan the
        // snapshot covered.
        matchedProjectPaths: bundlePlan.plan.matched.map((match) => match.entry.path),
      };
    },

    async writeSafetySnapshot(snapshotRoot) {
      // Unredacted: this copy never leaves the machine, and a redacted snapshot could
      // not restore a credential whose MCP server the restore removed.
      // Project memory is intentionally absent here: restore snapshots exactly the
      // matched entries it will overwrite, inside the same memory-lock window as the
      // write, so nothing can edit a file between its snapshot bytes and its overwrite.
      await writeBackupPayload(snapshotRoot, await buildPayload({ keepLocalSecrets: true }), {
        portable: false,
        ownerOnly: true,
      });
    },

    async restore(restoreOptions) {
      const sourceDir = await managedDir(restoreOptions.repositoryRoot, restoreOptions.managedPath);
      const payload = await readBackupPayload(sourceDir);
      const before = await localFilesByPath();
      const result = await restoreBackupPayload({
        muxRoot,
        payload,
        approvedCommandTokens: restoreOptions.approvedCommandTokens,
      });
      if (result.backupPreferences !== undefined) {
        let merged: ReturnType<typeof normalizeUserPreferences> | undefined;
        await options.config.editConfig((current) => {
          // Merged against the config this edit reads, not a snapshot taken before the
          // restore: a whole-object write would otherwise discard preferences another
          // window saved meanwhile, including the machine-local keys no backup carries.
          merged = normalizeUserPreferences(
            mergeBackupPreferences(current.userPreferences, result.backupPreferences)
          );
          return { ...current, userPreferences: merged };
        });
        // saveConfig logs and swallows write failures, so a resolved edit does not prove
        // the preferences landed. Compared through the backup projection because every
        // key a restore can change is portable, so a lost write is visible there, while
        // machine-local keys the load path normalizes differently stay out of the check.
        const stored = options.config.loadConfigOrDefault().userPreferences;
        if (
          merged !== undefined &&
          !serializeBackupPreferences(stored ?? {}).equals(serializeBackupPreferences(merged))
        ) {
          throw new BackupServiceError(
            "IO_ERROR",
            "The restored preferences could not be written to config.json"
          );
        }
      }

      const after = await localFilesByPath();
      const changedFiles = [...after.entries()]
        .filter(([file, current]) => {
          const previous = before.get(file);
          return !previous?.content.equals(current.content) || !sameMode(previous, current);
        })
        .map(([file]) => file);

      let projectBundleSkipped = false;
      const restoredProjectMemory: Array<{ projectPath: string; files: string[] }> = [];
      if (!restoreOptions.includeProjects) {
        // Existence-only, like the preview: a malformed sidecar must never block a
        // core-only restore, but its presence is reported so the skip is visible.
        projectBundleSkipped = await projectBundleExists(sourceDir);
      } else {
        const bundlePlan = await readBundleWithPlan(sourceDir);
        if (bundlePlan !== null) {
          // Only entries the caller validated as matched. A project registered at its
          // recorded path since validation was previewed as an import and is not covered
          // by the snapshot, so it must not be overwritten here; one unregistered since
          // validation drops out of the recomputed plan on its own.
          const validatedMatched = new Set(restoreOptions.matchedProjectPaths);
          const matched = bundlePlan.plan.matched.filter((match) =>
            validatedMatched.has(match.entry.path)
          );
          // One lock window for the snapshot and the overwrite: a memory edit landing
          // between them would otherwise be destroyed with a snapshot that predates it.
          await withMemoryLock(async () => {
            if (matched.length > 0) {
              // Exactly the memory these writes can overwrite — unrelated registered
              // projects neither need covering nor may count against the bundle limits.
              const localBundle = await collectProjectBundle(
                muxRoot,
                matched.map((match) => match.entry)
              );
              await writeProjectBundle(
                path.join(restoreOptions.snapshotPath, PROJECT_BUNDLE_DIR),
                localBundle,
                { portable: false, ownerOnly: true }
              );
            }
            // Matched entries restore verbatim, exactly what the preview promised. Imports
            // are executed separately by the service, after project registration.
            for (const match of matched) {
              let written: string[];
              try {
                written = (
                  await writeProjectMemoryFiles(
                    muxRoot,
                    match.files.map((file) => ({ path: file.path, content: file.content })),
                    { addOnly: false }
                  )
                ).written;
              } catch (error) {
                // Files written so far — earlier entries and this one's partial progress —
                // are on disk; the failure must still announce them.
                if (error instanceof ProjectMemoryWriteError && error.written.length > 0) {
                  restoredProjectMemory.push({
                    projectPath: match.entry.path,
                    files: error.written,
                  });
                }
                throw new ProjectMemoryRestoreError(
                  error instanceof Error ? error.message : String(error),
                  restoredProjectMemory,
                  { cause: error }
                );
              }
              if (written.length > 0) {
                changedFiles.push(...written);
                restoredProjectMemory.push({ projectPath: match.entry.path, files: written });
              }
            }
          });
        }
      }
      return {
        changedFiles: changedFiles.sort(),
        localOnlyFiles: result.localOnlyFiles,
        projectBundleSkipped,
        restoredProjectMemory,
      };
    },

    async prepareProjectImports(prepareOptions) {
      const sourceDir = await managedDir(prepareOptions.repositoryRoot, prepareOptions.managedPath);
      const bundle = await readProjectBundle(sourceDir);
      if (bundle === null) {
        throw new BackupServiceError(
          "INVALID_BACKUP",
          "The backup no longer carries a project bundle"
        );
      }
      // Tokens computed once for the parsed bundle: the repo lock has held the checkout
      // stable since the service validated it, so per-import rehashing would only repeat
      // this work.
      const entriesByToken = new Map(
        bundle.manifest.projects.map((entry) => [projectImportToken(entry, bundle.files), entry])
      );
      return {
        async importProjectMemory(importOptions) {
          // Token lookup rather than trusting any caller-named entry: the token binds the
          // approval to the exact entry and content, so a miss here is defensive only.
          const entry = entriesByToken.get(importOptions.token);
          if (entry === undefined) {
            throw new BackupServiceError(
              "INVALID_BACKUP",
              "The approved project import no longer matches the backup"
            );
          }
          const targetDir = projectMemoryDirName(importOptions.targetPath);
          const writes = bundleEntryFiles(bundle.files, entry).map((file) => ({
            path: rekeyProjectMemoryPath(file.path, targetDir),
            content: file.content,
          }));
          const { written, skipped } = await withMemoryLock(() =>
            writeProjectMemoryFiles(muxRoot, writes, { addOnly: true })
          );
          return { writtenFiles: written, skippedFiles: skipped };
        },
      };
    },
  };
}
