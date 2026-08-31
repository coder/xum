import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "@/node/config";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import {
  BackupOperationErrorSchema,
  type BackupCommandApproval,
  type BackupCredentialKind,
  type BackupFileChange,
  type BackupOperationError,
} from "@/common/orpc/schemas/backup";
import {
  SettingsBackupInputSchema,
  type SettingsBackup,
  type SettingsBackupInput,
} from "@/common/config/schemas/settingsBackup";
import {
  assertNotSymlink,
  backupCacheName,
  discardBackupCache,
  isBackupCacheName,
  reapDiscardedBackupCaches,
} from "./gitRepo";
import { BackupCommandApprovalRequiredError } from "./payload";

export interface PreparedBackupRepository {
  rootDir: string;
  credential: BackupCredentialKind;
  remoteCommit: string | null;
  /**
   * The managed path the prepared cache actually holds: the configured spelling, or its
   * legacy `mux` spelling when only that tree carries a backup manifest (backups pushed
   * before the product rename). Payload reads and writes must use this path — only this
   * tree is materialized, validated, and staged.
   */
  managedPath: string;
}

export interface BackupGitRepo {
  validate(settings: SettingsBackupInput): Promise<{
    credential: BackupCredentialKind;
    empty: boolean;
  }>;
  prepare(
    settings: SettingsBackupInput,
    options?: { onPrepareError?(repositoryRoot: string): Promise<void> }
  ): Promise<PreparedBackupRepository>;
  getPushChanges(repository: PreparedBackupRepository): Promise<BackupFileChange[]>;
  commitAndPush(
    repository: PreparedBackupRepository,
    options: {
      message: string;
      expectedRemoteCommit: string | null;
    }
  ): Promise<{ commit: string; changed: boolean; credential: BackupCredentialKind }>;
}

export interface BackupPayloadStore {
  exportTo(options: {
    repositoryRoot: string;
    managedPath: string;
  }): Promise<{ redactions: string[]; secretFiles: string[]; secretApproval: string }>;
  previewRestore(options: { repositoryRoot: string; managedPath: string }): Promise<{
    changes: BackupFileChange[];
    localOnlyFiles: string[];
    commandApprovals: BackupCommandApproval[];
  }>;
  validateRestore(options: {
    repositoryRoot: string;
    managedPath: string;
    approvedCommandTokens?: readonly string[];
  }): Promise<void>;
  writeSafetySnapshot(snapshotRoot: string): Promise<void>;
  restore(options: {
    repositoryRoot: string;
    managedPath: string;
    approvedCommandTokens?: readonly string[];
  }): Promise<{ changedFiles: string[]; localOnlyFiles: string[] }>;
}

export interface BackupServiceDependencies {
  gitRepo: BackupGitRepo;
  payload: BackupPayloadStore;
}

type BackupErrorCode = BackupOperationError["code"];

const SNAPSHOT_NAME_PREFIX = "restore-";

/**
 * Written beside a snapshot as the restore that owns it finishes, which is what makes the
 * snapshot reapable. A sibling rather than a file inside, so the snapshot directory stays a
 * payload `readBackupPayload(dir, { portable: false })` can read for a manual recovery.
 *
 * Absent covers a restore still running, one killed partway, and one whose marker write failed.
 * None are distinguishable from outside, so all are left alone: leaking a snapshot the user can
 * delete is recoverable, and deleting the recovery point of a live restore is not.
 */
const SNAPSHOT_RELEASED_SUFFIX = ".released";

/** Fixed width so the sequence sorts as text alongside the stamp. */
const SNAPSHOT_SEQUENCE_DIGITS = 6;

async function releaseSnapshot(snapshotPath: string): Promise<void> {
  await fs
    .writeFile(`${snapshotPath}${SNAPSHOT_RELEASED_SUFFIX}`, "", { mode: 0o600 })
    .catch(() => undefined);
}

const STAMPED_SNAPSHOT_NAME = /^restore-(\d{4}-\d{2}-\d{2}T[\d-]+Z)-(?:(\d{6})-)?/;

/**
 * Snapshots are ordered by the stamp and sequence in their own name, never by mtime or by the
 * random `mkdtemp` suffix: several restores can land in the same millisecond, and neither a
 * filesystem timestamp nor a random suffix can put those in creation order. A name from before
 * either part existed sorts oldest, so those are reclaimed first rather than kept forever.
 */
function snapshotOrder(name: string): string {
  const match = STAMPED_SNAPSHOT_NAME.exec(name);
  return `${match?.[1] ?? ""}\u0000${match?.[2] ?? ""}\u0000${name}`;
}

export class BackupServiceError extends Error {
  constructor(
    public readonly code: BackupErrorCode,
    message: string,
    public readonly files?: string[],
    public readonly secretApproval?: string
  ) {
    super(message);
    this.name = "BackupServiceError";
  }
}

function toOperationError(error: unknown): BackupOperationError {
  if (error instanceof BackupServiceError) {
    return {
      code: error.code,
      message: error.message,
      files: error.files,
      secretApproval: error.secretApproval,
    };
  }

  // A restore attempted without a preview, or after the backup's commands drifted, fails
  // with an approval list the UI has not seen yet. Dropping it would leave the user unable
  // to approve anything without guessing that Preview must be run again.
  if (error instanceof BackupCommandApprovalRequiredError) {
    return {
      code: error.code,
      message: error.message,
      commandApprovals: [...error.approvals],
    };
  }

  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; files?: unknown };
    const code = BackupOperationErrorSchema.shape.code.safeParse(candidate.code);
    if (code.success) {
      return {
        code: code.data,
        message: candidate.message,
        files: Array.isArray(candidate.files)
          ? candidate.files.filter((file): file is string => typeof file === "string")
          : undefined,
      };
    }
    return { code: "IO_ERROR", message: error.message };
  }

  return { code: "IO_ERROR", message: "Settings backup failed" };
}

function repoLockKey(settings: SettingsBackupInput): string {
  return `${settings.repoUrl}\0${settings.branch}`;
}

const activeCacheUses = new Map<string, number>();
const cacheReapClaims = new Map<string, Promise<void>>();

type ReleaseActiveCache = () => void;

function registerActiveCache(cacheName: string): ReleaseActiveCache | Promise<ReleaseActiveCache> {
  const pendingReap = cacheReapClaims.get(cacheName);
  if (pendingReap !== undefined) {
    return pendingReap.then(() => registerActiveCache(cacheName));
  }

  activeCacheUses.set(cacheName, (activeCacheUses.get(cacheName) ?? 0) + 1);
  return () => {
    const remaining = (activeCacheUses.get(cacheName) ?? 1) - 1;
    if (remaining === 0) activeCacheUses.delete(cacheName);
    else activeCacheUses.set(cacheName, remaining);
  };
}

function isCacheActive(cacheName: string): boolean {
  return activeCacheUses.has(cacheName);
}

async function discardInactiveCache(cachePath: string): Promise<void> {
  const cacheName = path.basename(cachePath);
  if (isCacheActive(cacheName)) return;
  const existingClaim = cacheReapClaims.get(cacheName);
  if (existingClaim !== undefined) {
    await existingClaim;
    return;
  }

  let releaseClaim: () => void;
  const claim = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  cacheReapClaims.set(cacheName, claim);
  try {
    await discardBackupCache(cachePath);
  } finally {
    cacheReapClaims.delete(cacheName);
    releaseClaim!();
  }
}

/** Service-level validation prevents direct callers from bypassing schema invariants. */
function normalizeBackupSettings(settings: SettingsBackupInput): SettingsBackupInput {
  const parsed = SettingsBackupInputSchema.safeParse(settings);
  if (!parsed.success) {
    throw new BackupServiceError(
      "INVALID_BACKUP",
      parsed.error.issues[0]?.message ?? "Invalid backup settings"
    );
  }
  return parsed.data;
}

export class BackupService {
  /** Keeps quick switches among recent repository settings from forcing a fresh clone. */
  static readonly RETAINED_INACTIVE_CACHES = 2;

  private readonly locks = new MutexMap<string>();

  /**
   * `locks` is keyed per repository, so different repository and branch tuples overlap on the one
   * Xum root every payload adapter reads and writes: a push can publish a half-restored mixture.
   * Held only around local payload work, so git and network work stays parallel.
   */
  private readonly localPayload = new MutexMap<string>();

  /**
   * Orders snapshots the stamp cannot separate. Restores that land in the same millisecond would
   * otherwise be ranked by `mkdtemp`'s random suffix, which can reap a newer recovery point and
   * keep an older one.
   */
  private snapshotSequence = 0;

  constructor(
    private readonly config: Config,
    private readonly dependencies: BackupServiceDependencies
  ) {}

  getSettings(): SettingsBackup | null {
    return this.config.loadConfigOrDefault().settingsBackup ?? null;
  }

  async saveSettings(
    settings: SettingsBackupInput
  ): Promise<Result<SettingsBackup, BackupOperationError>> {
    try {
      const normalized = normalizeBackupSettings(settings);
      const saved = await this.persistSettings(normalized);
      return Ok(saved);
    } catch (error) {
      return Err(toOperationError(error));
    }
  }

  async validate(
    settings: SettingsBackupInput
  ): Promise<
    Result<
      { reachable: true; credential: BackupCredentialKind; empty: boolean },
      BackupOperationError
    >
  > {
    try {
      const normalized = normalizeBackupSettings(settings);
      const result = await this.dependencies.gitRepo.validate(normalized);
      return Ok({ reachable: true, ...result });
    } catch (error) {
      return Err(toOperationError(error));
    }
  }

  async preview(settings: SettingsBackupInput): Promise<
    Result<
      {
        pushChanges: BackupFileChange[];
        restoreChanges: BackupFileChange[];
        localOnlyFiles: string[];
        redactions: string[];
        commandApprovals: BackupCommandApproval[];
      },
      BackupOperationError
    >
  > {
    return this.withRepoLock(settings, async (normalized) => {
      const repository = await this.prepareRepository(normalized);
      // One critical section: the reported restore plan and the exported payload must describe
      // the same local state, or the two halves of the preview disagree.
      const { restorePreview, exported } = await this.withLocalPayload(async () => ({
        restorePreview: await this.dependencies.payload.previewRestore({
          repositoryRoot: repository.rootDir,
          managedPath: repository.managedPath,
        }),
        exported: await this.dependencies.payload.exportTo({
          repositoryRoot: repository.rootDir,
          managedPath: repository.managedPath,
        }),
      }));
      const pushChanges = await this.dependencies.gitRepo.getPushChanges(repository);
      return Ok({
        pushChanges,
        restoreChanges: restorePreview.changes,
        localOnlyFiles: restorePreview.localOnlyFiles,
        redactions: exported.redactions,
        commandApprovals: restorePreview.commandApprovals,
      });
    });
  }

  pushWithApproval(input: SettingsBackupInput & { approvedSecretDigest?: string | null }) {
    const { approvedSecretDigest, ...settings } = input;
    return this.push(settings, { approvedSecretDigest: approvedSecretDigest ?? undefined });
  }

  restoreWithApproval(
    input: SettingsBackupInput & { approvedCommandTokens?: readonly string[] | null }
  ) {
    const { approvedCommandTokens, ...settings } = input;
    return this.restore(settings, { approvedCommandTokens: approvedCommandTokens ?? undefined });
  }

  async push(
    settings: SettingsBackupInput,
    options: { approvedSecretDigest?: string } = {}
  ): Promise<
    Result<
      {
        commit: string;
        changed: boolean;
        credential: BackupCredentialKind;
        redactions: string[];
      },
      BackupOperationError
    >
  > {
    const approvedSecretDigest = options.approvedSecretDigest;
    return this.withRepoLock(settings, async (normalized) => {
      const repository = await this.prepareRepository(normalized);
      const exported = await this.withLocalPayload(() =>
        this.dependencies.payload.exportTo({
          repositoryRoot: repository.rootDir,
          managedPath: repository.managedPath,
        })
      );
      // Approval is bound to the exact flagged bytes, so an override the user granted for
      // one payload cannot publish a different one another window wrote in between.
      if (exported.secretFiles.length > 0 && approvedSecretDigest !== exported.secretApproval) {
        throw new BackupServiceError(
          "SECRET_DETECTED",
          "Potential secrets were found in the backup payload",
          exported.secretFiles,
          exported.secretApproval
        );
      }

      const pushed = await this.dependencies.gitRepo.commitAndPush(repository, {
        message: "Back up Xum settings",
        expectedRemoteCommit: repository.remoteCommit,
      });
      await this.persistSettings(normalized, { lastPushedCommit: pushed.commit });
      // The pushing credential, not the one prepare() used: the ladder can fall through
      // to a later rung when the earlier one can read but not write.
      return Ok({
        ...pushed,
        redactions: exported.redactions,
      });
    });
  }

  async restore(
    settings: SettingsBackupInput,
    options: { approvedCommandTokens?: readonly string[] } = {}
  ): Promise<
    Result<
      { commit: string; snapshotPath: string; changedFiles: string[]; localOnlyFiles: string[] },
      BackupOperationError
    >
  > {
    const approvedCommandTokens =
      options.approvedCommandTokens == null ? undefined : [...options.approvedCommandTokens];
    return this.withRepoLock(settings, async (normalized) => {
      const repository = await this.prepareRepository(normalized);
      const remoteCommit = repository.remoteCommit;
      if (remoteCommit == null) {
        throw new BackupServiceError("INVALID_BACKUP", "The backup repository is empty");
      }

      // One critical section from the check through the write loop: a concurrent push must not
      // collect a half-restored Xum root, and a concurrent restore must not interleave its
      // writes with this one.
      return await this.withLocalPayload(async () => {
        // Before the snapshot, so a restore blocked on command approval does not leave an
        // unredacted copy of the local settings on disk.
        await this.dependencies.payload.validateRestore({
          repositoryRoot: repository.rootDir,
          managedPath: repository.managedPath,
          approvedCommandTokens,
        });
        const snapshotPath = await this.createSnapshotPath();
        try {
          await this.dependencies.payload.writeSafetySnapshot(snapshotPath);
        } catch (error) {
          // Nothing has been restored yet, so a snapshot that did not finish is an empty or
          // partial unredacted copy that no recovery can use, and every retry would add one.
          await fs.rm(snapshotPath, { recursive: true, force: true });
          throw error;
        }
        try {
          const restored = await this.dependencies.payload.restore({
            repositoryRoot: repository.rootDir,
            managedPath: repository.managedPath,
            approvedCommandTokens,
          });
          await this.persistSettings(normalized, { lastRestoredCommit: remoteCommit });
          return Ok({
            commit: remoteCommit,
            snapshotPath,
            changedFiles: restored.changedFiles,
            localOnlyFiles: restored.localOnlyFiles,
          });
        } catch (error) {
          // Past the snapshot, the restore may have overwritten files before failing, and
          // the snapshot is the only recovery path, so the failure must carry it.
          return Err({ ...toOperationError(error), snapshotPath });
        } finally {
          // Released only now, because until this restore returns its snapshot is the recovery
          // point it may still hand back. Reaping is safe here rather than gated on other
          // restores because the local payload lock already excludes them.
          await releaseSnapshot(snapshotPath);
          await this.reapOldSnapshots(path.dirname(snapshotPath), snapshotPath);
        }
      });
    });
  }

  private async prepareRepository(
    settings: SettingsBackupInput
  ): Promise<PreparedBackupRepository> {
    const repository = await this.dependencies.gitRepo.prepare(settings, {
      onPrepareError: (repositoryRoot) => this.reapInactiveCaches(repositoryRoot),
    });
    await this.reapInactiveCaches(repository.rootDir);
    return repository;
  }

  private async reapInactiveCaches(repositoryRoot: string): Promise<void> {
    const currentCache = path.resolve(repositoryRoot);
    const currentName = path.basename(currentCache);
    if (!isBackupCacheName(currentName)) return;

    const cacheRoot = path.dirname(currentCache);
    await assertNotSymlink(cacheRoot);
    const now = new Date();
    await fs.utimes(currentCache, now, now).catch(() => undefined);

    const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
    const inactive: Array<{ cachePath: string; mtimeMs: number; name: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isBackupCacheName(entry.name)) continue;
      if (entry.name === currentName || isCacheActive(entry.name)) continue;
      const cachePath = path.join(cacheRoot, entry.name);
      const stat = await fs.lstat(cachePath).catch(() => null);
      if (stat?.isDirectory() === true) {
        inactive.push({ cachePath, mtimeMs: stat.mtimeMs, name: entry.name });
      }
    }
    inactive.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

    const stale = inactive.slice(BackupService.RETAINED_INACTIVE_CACHES);
    for (const cache of stale) {
      await discardInactiveCache(cache.cachePath).catch(() => undefined);
    }
    if (stale.length > 0) await reapDiscardedBackupCaches(cacheRoot);
  }

  private async persistSettings(
    settings: SettingsBackupInput,
    commitUpdate: Pick<SettingsBackup, "lastPushedCommit" | "lastRestoredCommit"> = {}
  ): Promise<SettingsBackup> {
    let saved: SettingsBackup | undefined;
    await this.config.editConfig((current) => {
      const previous = current.settingsBackup;
      const sameRepository =
        previous?.repoUrl === settings.repoUrl &&
        previous.branch === settings.branch &&
        previous.path === settings.path;
      // Commit metadata must not rewrite the repository settings tuple. Another window can
      // save a different repository while a push or restore is in flight.
      if (previous !== undefined && !sameRepository && Object.keys(commitUpdate).length > 0) {
        saved = previous;
        return current;
      }
      saved = {
        ...settings,
        ...(sameRepository
          ? {
              lastPushedCommit: previous.lastPushedCommit,
              lastRestoredCommit: previous.lastRestoredCommit,
            }
          : {}),
        ...commitUpdate,
      };
      return { ...current, settingsBackup: saved };
    });

    if (saved == null) {
      throw new BackupServiceError("IO_ERROR", "Settings backup configuration was not saved");
    }
    // saveConfig logs and swallows write failures by design, so a resolved editConfig does
    // not prove the write landed; on a full disk this method would otherwise report saved
    // settings, a recorded push, or a recorded restore that config.json never received.
    // loadConfigOrDefault reads the file fresh, so a lost write reads back as the old value.
    const stored = this.config.loadConfigOrDefault().settingsBackup;
    if (
      stored?.repoUrl !== saved.repoUrl ||
      stored.branch !== saved.branch ||
      stored.path !== saved.path ||
      stored.lastPushedCommit !== saved.lastPushedCommit ||
      stored.lastRestoredCommit !== saved.lastRestoredCommit
    ) {
      throw new BackupServiceError(
        "IO_ERROR",
        "The backup settings could not be written to config.json"
      );
    }
    return saved;
  }

  /**
   * A snapshot is an unredacted copy of the whole local payload, and one is kept per restore as
   * its only recovery path, so they would otherwise grow without limit. Older ones are dropped
   * once this many newer released recovery points exist.
   */
  static readonly RETAINED_SNAPSHOTS = 3;

  private async reapOldSnapshots(cacheRoot: string, keepFrom: string): Promise<void> {
    const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
    const released = new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(SNAPSHOT_RELEASED_SUFFIX))
        .map((entry) => entry.name.slice(0, -SNAPSHOT_RELEASED_SUFFIX.length))
    );
    const keepName = path.basename(keepFrom);
    // Released only, which is what keeps a concurrent restore's snapshot out of reach; every
    // candidate's own restore has returned, so the order below only chooses which recovery
    // points to keep, never whether one is still in use.
    const reapable = entries
      // `isDirectory` is false for a symlink here, so a link is never followed or removed.
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(SNAPSHOT_NAME_PREFIX))
      .map((entry) => entry.name)
      .filter((name) => name !== keepName && released.has(name))
      .sort((a, b) => (snapshotOrder(a) < snapshotOrder(b) ? 1 : -1));
    for (const stale of reapable.slice(BackupService.RETAINED_SNAPSHOTS - 1)) {
      // Per entry, because one snapshot nobody can delete must not stop the rest from being
      // reclaimed, and the restore it belongs to has already returned either way.
      await fs
        .rm(path.join(cacheRoot, stale), { recursive: true, force: true })
        .then(() => fs.rm(path.join(cacheRoot, `${stale}${SNAPSHOT_RELEASED_SUFFIX}`)))
        .catch(() => undefined);
    }
  }

  private async createSnapshotPath(): Promise<string> {
    // Mode matches the chmod `ensureCache` applies to this same directory: the snapshot
    // below is unredacted, so the tree above it must not be traversable by other users.
    const cacheRoot = path.join(this.config.rootDir, "backup-cache");
    // The snapshot holds the local settings unredacted, so a link here would put the copy
    // wherever it points (a world-readable /tmp, say).
    await assertNotSymlink(cacheRoot);
    await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    // Stamped so `reapOldSnapshots` can order snapshots by name; `mkdtemp` still supplies the
    // uniqueness, since two restores can start in the same millisecond.
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const sequence = String(this.snapshotSequence++).padStart(SNAPSHOT_SEQUENCE_DIGITS, "0");
    return fs.mkdtemp(path.join(cacheRoot, `${SNAPSHOT_NAME_PREFIX}${stamp}-${sequence}-`));
  }

  /**
   * One key, because the resource is the Xum root itself rather than any repository. Taken inside
   * `withRepoLock` everywhere, so the two are always acquired in the same order.
   */
  private withLocalPayload<T>(operation: () => Promise<T>): Promise<T> {
    return this.localPayload.withLock("mux-root", operation);
  }

  private withRepoLock<T>(
    settings: SettingsBackupInput,
    operation: (normalized: SettingsBackupInput) => Promise<Result<T, BackupOperationError>>
  ): Promise<Result<T, BackupOperationError>> {
    let normalized: SettingsBackupInput;
    try {
      normalized = normalizeBackupSettings(settings);
    } catch (error) {
      return Promise.resolve(Err(toOperationError(error)));
    }
    const cacheName = backupCacheName(normalized.repoUrl, normalized.branch);
    return this.locks.withLock(repoLockKey(normalized), async () => {
      const registration = registerActiveCache(cacheName);
      const releaseCache = typeof registration === "function" ? registration : await registration;
      try {
        return await operation(normalized);
      } catch (error) {
        return Err(toOperationError(error));
      } finally {
        releaseCache();
      }
    });
  }
}
