import { EventEmitter } from "events";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import { SessionFileManager } from "@/node/utils/sessionFile";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { log } from "@/node/services/log";
import {
  REVIEW_STATE_SECTIONS,
  type ReviewStateDelta,
  type ReviewStateImportLegacyOutput,
  type ReviewStateSections,
  type ReviewStateSnapshot,
} from "@/common/orpc/schemas/reviewState";
import {
  applyReviewStateDelta,
  createEmptyReviewStateSnapshot,
  sanitizeReviewStateSnapshot,
  withReviewStateSection,
} from "@/common/utils/reviewState";

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

export class ReviewStateService extends EventEmitter {
  private readonly config: Config;
  private readonly file: SessionFileManager<unknown>;
  // Read-modify-write must be serialized per workspace. SessionFileManager.write takes
  // workspaceFileLocks itself and is not reentrant, so use a separate mutex around it.
  private readonly workspaceLocks = new MutexMap<string>();

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
    return this.workspaceLocks.withLock(workspaceId, () => this.load(workspaceId));
  }

  async applyDelta(workspaceId: string, delta: ReviewStateDelta): Promise<ReviewStateSnapshot> {
    assert(workspaceId.trim().length > 0, "ReviewStateService.applyDelta requires a workspaceId");
    return this.workspaceLocks.withLock(workspaceId, async () => {
      const current = await this.load(workspaceId);
      const snapshot: ReviewStateSnapshot = {
        sections: applyReviewStateDelta(current.sections, delta),
      };
      await this.persist(workspaceId, snapshot);
      return snapshot;
    });
  }

  /**
   * One-time localStorage migration: write each provided section ONLY when it is absent
   * on the backend. A present section (even an empty one) is newer than any leftover
   * legacy value, so it is never overwritten.
   */
  async importLegacy(
    workspaceId: string,
    sections: ReviewStateSections
  ): Promise<ReviewStateImportLegacyOutput> {
    assert(workspaceId.trim().length > 0, "ReviewStateService.importLegacy requires a workspaceId");
    return this.workspaceLocks.withLock(workspaceId, async () => {
      const current = await this.load(workspaceId);
      // Sanitize the untrusted legacy payload with the same rules as the file load.
      const incoming = sanitizeReviewStateSnapshot({ sections }).snapshot.sections;
      const results: ReviewStateImportLegacyOutput["results"] = {};
      let next = current.sections;
      for (const section of REVIEW_STATE_SECTIONS) {
        if (sections[section] === undefined) continue;
        if (current.sections[section] !== undefined) {
          results[section] = "present";
          continue;
        }
        next = withReviewStateSection(next, section, incoming[section] ?? {});
        results[section] = "applied";
      }
      const snapshot: ReviewStateSnapshot = { sections: next };
      if (next !== current.sections) {
        await this.persist(workspaceId, snapshot);
      }
      return { snapshot, results };
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

  private async persist(workspaceId: string, snapshot: ReviewStateSnapshot): Promise<void> {
    const result = await this.file.write(workspaceId, snapshot, {
      // A late flush for a deleted workspace must not recreate `sessions/<deletedId>/`.
      shouldWrite: () => this.config.findWorkspace(workspaceId) != null,
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    this.emit(ReviewStateService.changeEventName(workspaceId), snapshot);
  }
}
