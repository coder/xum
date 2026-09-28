import { EventEmitter } from "events";
import * as path from "path";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import { SessionFileManager } from "@/node/utils/sessionFile";
import { log } from "@/node/services/log";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import { isWorkspaceRemovalTombstoned } from "@/node/services/workspaceRemoval";
import {
  REVIEW_STATE_SECTIONS,
  type ReviewStateDelta,
  type ReviewStateImportLegacyOutput,
  type ReviewStateSections,
  type ReviewStateSnapshot,
  type ReviewStateUpdateOutput,
} from "@/common/orpc/schemas/reviewState";
import {
  applyReviewStateDelta,
  assignSection,
  createEmptyReviewStateSnapshot,
  sanitizeReviewStateSnapshot,
} from "@/common/utils/reviewState";

/**
 * The legacy entries to add to one section: keys it lacks, plus (firstSeen) keys the legacy
 * value should replace. Undefined when the section was not provided.
 */
function importDelta<V>(
  existing: Record<string, V> | undefined,
  legacy: Record<string, V> | undefined,
  replaces?: (kept: V, legacy: V) => boolean
): { set: Record<string, V> } | undefined {
  if (legacy === undefined) return undefined;
  const set = Object.fromEntries(
    Object.entries(legacy).filter(
      ([key, value]) =>
        existing === undefined || !(key in existing) || (replaces?.(existing[key], value) ?? false)
    )
  );
  return { set };
}

/**
 * Per-workspace code-review state (review notes, hunk read/first-seen/expand/read-more maps).
 *
 * Lives in `<sessionsDir>/<workspaceId>/` instead of renderer localStorage because the
 * data (~150 KB per reviewed workspace) multiplied across workspaces and exhausted the
 * localStorage quota. The session dir also gives the lifecycle for free: fork copies the
 * file (WorkspaceService.fork), removal deletes the session dir, and rename keeps the
 * workspace ID, so the file follows the workspace without extra bookkeeping.
 */
export const REVIEW_STATE_FILE_NAME = "review-state.json";

/** Payload of the per-workspace change event: the persisted snapshot and its revision. */
export interface ReviewStateChange {
  snapshot: ReviewStateSnapshot;
  revision: number;
}

export class ReviewStateService extends EventEmitter {
  private readonly config: Config;
  private readonly file: SessionFileManager<unknown>;
  /**
   * In-memory per-workspace revision (see ReviewStateRevisionSchema), bumped under the write
   * lock on every persisted change. Every workspace starts at the process start time, so a
   * restarted backend does not regress below the old process's revisions in practice (writes
   * are far rarer than one per millisecond); clients also reset on each new subscription.
   */
  private readonly revisions = new Map<string, number>();
  private readonly initialRevision = Date.now();

  constructor(config: Config) {
    super();
    this.config = config;
    this.file = new SessionFileManager<unknown>(config, REVIEW_STATE_FILE_NAME);
  }

  static changeEventName(workspaceId: string): string {
    return `change:${workspaceId}`;
  }

  /** Sanitized snapshot; empty sections for an unknown workspace or a missing file. */
  async getSnapshot(workspaceId: string): Promise<ReviewStateSnapshot> {
    assert(workspaceId.trim().length > 0, "ReviewStateService.getSnapshot requires a workspaceId");
    // No lock: writes are atomic renames, so a read sees either the old or the new file.
    return this.load(workspaceId);
  }

  /** A subscription's initial snapshot with a revision that is never newer than its content. */
  async getSnapshotWithRevision(workspaceId: string): Promise<ReviewStateChange> {
    // Read the revision BEFORE the file: a write landing in between leaves content newer than
    // its revision (harmless), never an old file labelled with the new write's revision, which
    // would make a client treat that write's reply as already applied.
    const revision = this.getRevision(workspaceId);
    return { snapshot: await this.getSnapshot(workspaceId), revision };
  }

  async applyDelta(workspaceId: string, delta: ReviewStateDelta): Promise<ReviewStateUpdateOutput> {
    assert(workspaceId.trim().length > 0, "ReviewStateService.applyDelta requires a workspaceId");
    return this.withWriteLock(workspaceId, async () => {
      const current = await this.load(workspaceId);
      const snapshot: ReviewStateSnapshot = {
        sections: applyReviewStateDelta(current.sections, delta),
      };
      const revision = await this.persist(workspaceId, snapshot);
      return { ...snapshot, revision };
    });
  }

  /**
   * Non-clobbering, per-entry localStorage migration: add only the legacy entries whose keys a
   * section lacks (creating an absent section); existing backend entries always win, except
   * that firstSeen keeps the earlier timestamp, as in every other merge. Caps apply after.
   *
   * localStorage is per origin (desktop app vs a browser tab) while this file is shared, and a
   * client removes its legacy keys once imported. So a key that still exists means that origin
   * was never imported, and its missing entries are new data, not stale leftovers. Results:
   * "applied" = the section was absent and was created, "present" = it existed and gained only
   * missing entries.
   */
  async importLegacy(
    workspaceId: string,
    sections: ReviewStateSections
  ): Promise<ReviewStateImportLegacyOutput> {
    assert(workspaceId.trim().length > 0, "ReviewStateService.importLegacy requires a workspaceId");
    return this.withWriteLock(workspaceId, async () => {
      const current = await this.load(workspaceId);
      // Sanitize the untrusted legacy payload with the same rules as the file load.
      const incoming = sanitizeReviewStateSnapshot({ sections }).snapshot.sections;
      const results: ReviewStateImportLegacyOutput["results"] = {};
      // A provided section the sanitizer dropped entirely (wrong shape) still creates it empty.
      const provided: ReviewStateSections = {};
      let changed = false;
      for (const section of REVIEW_STATE_SECTIONS) {
        if (sections[section] === undefined) continue;
        assignSection(provided, section, incoming[section] ?? {});
        const present = current.sections[section] !== undefined;
        results[section] = present ? "present" : "applied";
        changed ||= !present;
      }
      const has = current.sections;
      const delta: ReviewStateDelta = {
        reviews: importDelta(has.reviews, provided.reviews),
        readState: importDelta(has.readState, provided.readState),
        firstSeen: importDelta(has.firstSeen, provided.firstSeen, (kept, legacy) => legacy < kept),
        hunkExpand: importDelta(has.hunkExpand, provided.hunkExpand),
        readMore: importDelta(has.readMore, provided.readMore),
      };
      changed ||= REVIEW_STATE_SECTIONS.some(
        (section) => Object.keys(delta[section]?.set ?? {}).length > 0
      );
      const snapshot: ReviewStateSnapshot = {
        sections: changed ? applyReviewStateDelta(has, delta) : has,
      };
      const revision = changed
        ? await this.persist(workspaceId, snapshot)
        : this.getRevision(workspaceId);
      return { snapshot, revision, results };
    });
  }

  private async load(workspaceId: string): Promise<ReviewStateSnapshot> {
    const raw = await this.file.read(workspaceId);
    if (raw === null) {
      // Missing or unparseable file (SessionFileManager logs parse errors): self-heal to empty.
      return createEmptyReviewStateSnapshot();
    }
    const { snapshot, droppedEntries } = sanitizeReviewStateSnapshot(raw);
    if (droppedEntries > 0 || typeof raw !== "object" || Array.isArray(raw)) {
      log.warn(`Dropped malformed entries from ${REVIEW_STATE_FILE_NAME}`, {
        workspaceId,
        droppedEntries,
      });
    }
    return snapshot;
  }

  /**
   * Serialize a read-modify-write on the session dir's target mutation lock, the same
   * in-process mutex + cross-process file lock that workspace removal holds while it publishes
   * its tombstone and deletes the session dir (removeSessionDirUnderMemoryLocks), like the
   * other session-dir writers (DevToolsService, SessionUsageService). It also serializes two
   * backends sharing one Xum root, which an in-memory mutex alone cannot.
   */
  private withWriteLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    return withTargetMutationLock(
      this.config.rootDir,
      path.join(this.config.sessionsDir, workspaceId),
      fn
    );
  }

  private getRevision(workspaceId: string): number {
    return this.revisions.get(workspaceId) ?? this.initialRevision;
  }

  /**
   * Call under withWriteLock, so a removal cannot start between this check and the write.
   * Returns the revision of the write (the current revision when the write was skipped).
   */
  private async persist(workspaceId: string, snapshot: ReviewStateSnapshot): Promise<number> {
    // A late flush for a removed workspace must not recreate `sessions/<removedId>/`. Removal
    // publishes its tombstone under the same lock before deleting the dir, and deregisters from
    // config only afterwards, so the tombstone (not config) is what closes that window.
    if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId)) {
      return this.getRevision(workspaceId);
    }
    // Strict lookup: an unreadable config throws, failing the update so the client keeps its
    // change and retries. Only a conclusive "not registered" skips the write.
    if (this.config.findWorkspace(workspaceId, { throwOnError: true }) == null) {
      return this.getRevision(workspaceId);
    }
    const result = await this.file.write(workspaceId, snapshot);
    if (!result.success) {
      throw new Error(result.error);
    }
    const revision = this.getRevision(workspaceId) + 1;
    this.revisions.set(workspaceId, revision);
    const change: ReviewStateChange = { snapshot, revision };
    this.emit(ReviewStateService.changeEventName(workspaceId), change);
    return revision;
  }
}
