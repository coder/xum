import * as path from "node:path";
import { listBackupManagedPathSpellings } from "@/common/compat/legacyMux";
import { VERSION } from "@/version";
import type { Config } from "@/node/config";
import type { BackupFileChange } from "@/common/orpc/schemas/backup";
import { normalizeUserPreferences } from "@/common/config/schemas/userPreferences";
import {
  BackupServiceError,
  type BackupGitRepo,
  type BackupPayloadStore,
  type PreparedBackupRepository,
} from "./backupService";
import { BACKUP_GIT_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import { BackupRepoCache } from "./gitRepo";
import {
  backupPayloadExists,
  resolveContainedPath,
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

  return {
    async exportTo(exportOptions) {
      const payload = await buildPayload();
      // Owner-only like the safety snapshot: the export copies allowlisted sources that may
      // themselves be owner-only, and it lands here before the secret scan has said anything
      // about it. Git records only the exec bit, so the modes never reach the remote.
      await writeBackupPayload(
        await managedDir(exportOptions.repositoryRoot, exportOptions.managedPath),
        payload,
        { ownerOnly: true }
      );
      const secretFiles = scanBackupFilesForSecrets(payload.files);
      return {
        redactions: payload.redactions,
        secretFiles,
        secretApproval: backupSecretApprovalDigest(payload.files, secretFiles),
      };
    },

    async previewRestore(previewOptions) {
      const sourceDir = await managedDir(previewOptions.repositoryRoot, previewOptions.managedPath);
      const local = await localFilesByPath();
      // A repository with no backup yet is a normal first-run state, not an error:
      // nothing would be restored, and every local file is local-only.
      if (!(await backupPayloadExists(sourceDir))) {
        return { changes: [], localOnlyFiles: [...local.keys()].sort(), commandApprovals: [] };
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
      return {
        changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
        localOnlyFiles: localOnly,
        commandApprovals: await collectMcpCommandApprovals(
          muxRoot,
          payload.files,
          payload.manifest.mcpRedactions
        ),
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
    },

    async writeSafetySnapshot(snapshotRoot) {
      // Unredacted: this copy never leaves the machine, and a redacted snapshot could
      // not restore a credential whose MCP server the restore removed.
      await writeBackupPayload(snapshotRoot, await buildPayload({ keepLocalSecrets: true }), {
        portable: false,
        ownerOnly: true,
      });
    },

    async restore(restoreOptions) {
      const payload = await readBackupPayload(
        await managedDir(restoreOptions.repositoryRoot, restoreOptions.managedPath)
      );
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
        .map(([file]) => file)
        .sort();
      return { changedFiles, localOnlyFiles: result.localOnlyFiles };
    },
  };
}
