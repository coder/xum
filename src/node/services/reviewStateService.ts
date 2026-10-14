import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import { SessionFileManager } from "@/node/utils/sessionFile";
import { log } from "@/node/services/log";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import { isWorkspaceRemovalTombstoned } from "@/node/services/workspaceRemoval";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
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
 * Legacy review notes to add: the ids the backend lacks (all of them when the section is
 * absent). Undefined when the section was not provided.
 */
function missingEntries<V>(
  existing: Record<string, V> | undefined,
  legacy: Record<string, V> | undefined
): { set: Record<string, V> } | undefined {
  if (legacy === undefined) return undefined;
  return {
    set: Object.fromEntries(
      Object.entries(legacy).filter(([key]) => existing === undefined || !(key in existing))
    ),
  };
}

/** A hunk-keyed legacy section is imported whole, and only when the backend lacks it. */
function wholeIfAbsent<V>(
  existing: Record<string, V> | undefined,
  legacy: Record<string, V> | undefined
): { set: Record<string, V> } | undefined {
  return existing === undefined ? missingEntries(undefined, legacy) : undefined;
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
    this.sessionDirFor(workspaceId);
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
    this.sessionDirFor(workspaceId);
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
   * Non-clobbering localStorage migration. An absent section is created from the legacy value;
   * existing backend entries are never overwritten. Caps apply after.
   *
   * `reviews` also gains the legacy notes whose ids it lacks. localStorage is per origin
   * (desktop app vs a browser tab) while this file is shared, and a client removes its legacy
   * keys once imported, so a key that still exists means that origin was never imported: its
   * notes (unique per-origin ids, user-authored) are new data that must not be lost.
   *
   * The hunk-keyed sections (readState, firstSeen, hunkExpand, readMore) are NOT merged per
   * entry: their keys are deterministic hunk ids, so an older origin's key would resurrect an
   * entry the user deliberately cleared (e.g. marked unread = deleted). When present, they are
   * only reported. Results: "applied" = the section was absent and was created, "present" = it
   * existed (reviews: gained only missing notes; other sections: untouched).
   */
  async importLegacy(
    workspaceId: string,
    sections: ReviewStateSections
  ): Promise<ReviewStateImportLegacyOutput> {
    assert(workspaceId.trim().length > 0, "ReviewStateService.importLegacy requires a workspaceId");
    this.sessionDirFor(workspaceId);
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
        reviews: missingEntries(has.reviews, provided.reviews),
        readState: wholeIfAbsent(has.readState, provided.readState),
        firstSeen: wholeIfAbsent(has.firstSeen, provided.firstSeen),
        hunkExpand: wholeIfAbsent(has.hunkExpand, provided.hunkExpand),
        readMore: wholeIfAbsent(has.readMore, provided.readMore),
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

  /**
   * The workspace's session dir. Rejects IDs that would resolve anywhere but a direct child of
   * the sessions dir (e.g. `../x`): IDs arrive over the API and must not reach other paths.
   */
  private sessionDirFor(workspaceId: string): string {
    const sessionDir = path.join(this.config.sessionsDir, workspaceId);
    if (path.dirname(path.resolve(sessionDir)) !== path.resolve(this.config.sessionsDir)) {
      throw new Error(`Invalid workspace id for review state: ${JSON.stringify(workspaceId)}`);
    }
    return sessionDir;
  }

  /**
   * Missing or unparseable file: self-heal to empty. Any other read failure (EACCES, EIO,
   * EISDIR...) throws: treating it as empty would let the next write replace data that exists
   * but could not be read, while a rejection makes the client keep its change and retry.
   */
  private async load(workspaceId: string): Promise<ReviewStateSnapshot> {
    const filePath = path.join(this.sessionDirFor(workspaceId), REVIEW_STATE_FILE_NAME);
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      // Not `instanceof Error`: fs errors can come from another realm (e.g. jest vm contexts).
      if (hasErrorCode(error, "ENOENT")) {
        return createEmptyReviewStateSnapshot();
      }
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      log.warn(`Ignoring unparseable ${REVIEW_STATE_FILE_NAME}`, { workspaceId, error });
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
    return withTargetMutationLock(this.config.rootDir, this.sessionDirFor(workspaceId), fn);
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
    // Refuse with an error rather than a silent skip: the probe fails closed on I/O errors and a
    // removal can roll back, so the client must keep its change and retry. It drops the pending
    // change itself once the workspace-removed event arrives.
    if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId)) {
      throw new Error(`Review state write refused: workspace ${workspaceId} is being removed`);
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
