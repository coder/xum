import { dirname } from "path";
import { mkdir, readFile, access, rename, link, unlink, copyFile, writeFile } from "fs/promises";
import { constants } from "fs";
import writeFileAtomic from "write-file-atomic";
import {
  coerceAgentStatus,
  coerceExtensionMetadata,
  coerceStatusUrl,
  toWorkspaceActivitySnapshot,
  type ExtensionAgentStatus,
  type ExtensionMetadata,
  type ExtensionMetadataFile,
} from "@/node/utils/extensionMetadata";
import { getXumExtensionMetadataPath } from "@/common/constants/paths";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import type { GoalSnapshot } from "@/common/types/goal";
import { log } from "@/node/services/log";

/**
 * Marker code for "file written by a newer schema version" load failures.
 * Shaped like an errno code so the corruption/quarantine classification
 * (isDeterministicCorruption: errors WITH a code are not quarantinable)
 * treats downgrade encounters as retryable, never as resettable corruption.
 */
const UNSUPPORTED_METADATA_VERSION_CODE = "XUM_UNSUPPORTED_METADATA_VERSION";

/**
 * Stateless service for managing workspace metadata used by VS Code extension integration.
 *
 * This service tracks:
 * - recency: Unix timestamp (ms) of last user interaction
 * - streaming: Boolean indicating if workspace has an active stream
 * - streamingGeneration: Monotonic stream counter used to detect newer background turns
 * - lastModel: Last model used in this workspace
 * - lastThinkingLevel: Last thinking/reasoning level used in this workspace
 * - displayStatus: Current non-todo status payload for transient system-driven progress
 * - todoStatus: Status derived from the current todo list (preferred sidebar progress surface)
 * - hasTodos: Whether the workspace still had todos when streaming last stopped
 *
 * File location: ~/.xum/extensionMetadata.json
 *
 * Design:
 * - Stateless: reads from disk on every operation, no in-memory cache
 * - Atomic writes: uses write-file-atomic to prevent corruption
 * - Read-heavy workload: extension reads, main app writes on user interactions
 */

export interface ExtensionMetadataStreamingUpdate {
  model?: string;
  thinkingLevel?: ExtensionMetadata["lastThinkingLevel"];
  todoStatus?: ExtensionAgentStatus | null;
  hasTodos?: boolean;
  generation?: number;
}

export class ExtensionMetadataService {
  private readonly filePath: string;
  private mutationQueue: Promise<void> = Promise.resolve();
  /**
   * Per-process write tombstones for removed workspaces. Workspace removal
   * cannot drain every in-flight metadata producer (e.g. a stream-abort's
   * fire-and-forget stop-status handler that is still reading todos when the
   * entry is deleted), so late writers would silently recreate entries for
   * removed workspaces and re-leak stale keys until the next process-start
   * prune. Ids are added synchronously in deleteWorkspace/prune, so combined
   * with the FIFO mutation queue there is no gap: a writer enqueued before
   * the delete lands first and its entry is deleted; one enqueued after
   * no-ops on this set. Workspace ids are never reused (generateStableId),
   * so a tombstone never blocks a legitimate new workspace; recreations of
   * legacy fixed-id workspaces happen in a different (downgraded) process.
   */
  private readonly deletedWorkspaceIds = new Set<string>();

  /**
   * Serialize all mutating operations on the shared metadata file.
   * Prevents cross-workspace read-modify-write races since all workspaces
   * share a single extensionMetadata.json file.
   */
  private async withSerializedMutation<T>(fn: () => Promise<T>): Promise<T> {
    let result!: T;
    const run = async () => {
      result = await fn();
    };
    const next = this.mutationQueue.catch(() => undefined).then(run);
    this.mutationQueue = next;
    await next;
    return result;
  }

  private getOrCreateWorkspaceEntry(
    data: ExtensionMetadataFile,
    workspaceId: string,
    recency: number
  ): ExtensionMetadata {
    const normalized = coerceExtensionMetadata(data.workspaces[workspaceId]);
    if (normalized) {
      data.workspaces[workspaceId] = normalized;
      return normalized;
    }

    // Self-heal malformed persisted workspace entries instead of crashing future metadata writes.
    const created: ExtensionMetadata = {
      recency,
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
      displayStatus: null,
      lastStatusUrl: null,
      goal: null,
    };
    data.workspaces[workspaceId] = created;
    return created;
  }

  private toSnapshot(entry: unknown): WorkspaceActivitySnapshot | null {
    const normalized = coerceExtensionMetadata(entry);
    return normalized ? toWorkspaceActivitySnapshot(normalized) : null;
  }

  /**
   * Late write for a removed workspace: compute the snapshot for the caller
   * but never persist it, so the deleted entry cannot be resurrected.
   */
  private buildTransientSnapshot(
    workspaceId: string,
    recency: number,
    mutate: (workspace: ExtensionMetadata) => void
  ): WorkspaceActivitySnapshot {
    const transient = this.getOrCreateWorkspaceEntry(
      { version: 1, workspaces: {} },
      workspaceId,
      recency
    );
    mutate(transient);
    return toWorkspaceActivitySnapshot(transient);
  }

  private async mutateWorkspaceSnapshot(
    workspaceId: string,
    recency: number,
    mutate: (workspace: ExtensionMetadata) => void
  ): Promise<WorkspaceActivitySnapshot> {
    if (this.deletedWorkspaceIds.has(workspaceId)) {
      return this.buildTransientSnapshot(workspaceId, recency, mutate);
    }
    return this.withSerializedMutation(async () => {
      // Re-check inside the queue: pruneMissingWorkspaces publishes its
      // tombstones only while its queued mutation runs, so a writer that
      // passed the pre-queue check and enqueued behind the prune must not
      // recreate an entry the prune just reclaimed.
      if (this.deletedWorkspaceIds.has(workspaceId)) {
        return this.buildTransientSnapshot(workspaceId, recency, mutate);
      }
      const data = await this.load();
      const workspace = this.getOrCreateWorkspaceEntry(data, workspaceId, recency);
      mutate(workspace);
      await this.save(data);
      return toWorkspaceActivitySnapshot(workspace);
    });
  }

  constructor(filePath?: string) {
    this.filePath = filePath ?? getXumExtensionMetadataPath();
  }

  /**
   * Initialize the service by ensuring directory exists and clearing stale
   * streaming flags. Call once on app startup.
   *
   * Per AGENTS.md ("Startup-time initialization must never crash the app")
   * disk failures here are logged and swallowed; save() itself throws so
   * strict callers (e.g. AgentStatusService) can react.
   */
  async initialize(): Promise<void> {
    // Ensure directory exists
    const dir = dirname(this.filePath);
    try {
      await access(dir, constants.F_OK);
    } catch {
      try {
        await mkdir(dir, { recursive: true });
      } catch (error) {
        log.error("ExtensionMetadataService: failed to create metadata dir at startup", { error });
        return;
      }
    }

    // Clear stale streaming flags (from crashes)
    try {
      await this.clearStaleStreaming();
    } catch (error) {
      log.error("ExtensionMetadataService: failed to clear stale streaming at startup", { error });
    }
  }

  /**
   * Seam for load()'s missing-main handling (and deterministic TOCTOU tests):
   * reports whether the quarantine sidecar currently exists.
   */
  private probeQuarantineSidecar(): Promise<boolean> {
    return access(`${this.filePath}.corrupt`).then(
      () => true,
      (error: unknown) => {
        if (ExtensionMetadataService.isErrnoCode(error, "ENOENT")) {
          return false;
        }
        // EACCES/EIO/...: the sidecar's existence is unknowable, and only a
        // verified absence may let an ENOENT main read resolve as a healthy
        // empty file — recoverable metadata may sit in the unprobeable
        // sidecar. Propagate so the read stays a retryable failure for
        // strict readers and fails the mutation for lenient writers (same
        // tradeoff as the in-window recovery: failing one operation beats
        // clobbering the sidecar's data with a partial save).
        throw error;
      }
    );
  }

  private async load(options?: { throwOnError?: boolean }): Promise<ExtensionMetadataFile> {
    // Bounded because the ENOENT branch below re-reads: each retry only
    // happens after a fresh ENOENT, so the loop converges.
    const MAX_READ_ATTEMPTS = 3;
    let lastError: unknown;
    // True when the final failed attempt hit the mid-quarantine window
    // (main missing, sidecar present). That failure must never resolve as
    // an empty file, even leniently — see the sidecar branch below.
    let blockedByQuarantineWindow = false;
    for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt++) {
      try {
        const content = await readFile(this.filePath, "utf-8");
        const parsed = JSON.parse(content) as ExtensionMetadataFile;

        // A syntactically valid file whose version is not 1 was written by a
        // build with a newer schema — NOT corruption. It must never be
        // quarantined/reset (upgrading back would find the canonical file
        // empty and lose all activity state) and never self-healed to {} by
        // a lenient writer (saving version-1 bytes over it is the same data
        // loss). Both read modes propagate; see the catch below.
        if (ExtensionMetadataService.isUnsupportedVersion(parsed)) {
          throw ExtensionMetadataService.unsupportedVersionError();
        }

        // Validate structure, including the workspaces container: a parseable
        // file with e.g. an array or primitive `workspaces` would otherwise
        // enumerate as zero entries and masquerade as an authoritative empty
        // state in strict reads.
        if (!ExtensionMetadataService.isValidMetadataFileShape(parsed)) {
          throw new Error("Invalid extension metadata file structure");
        }

        return parsed;
      } catch (error) {
        // Only a genuinely missing file is a healthy empty state. Other read
        // failures (EACCES/ENOTDIR/EIO, parse or structure errors) must not
        // masquerade as one: throwOnError lets read paths distinguish them
        // from an authoritative empty state, while the default self-heals so
        // writers can always make progress.
        lastError = error;
        blockedByQuarantineWindow = false;
        if (!ExtensionMetadataService.isErrnoCode(error, "ENOENT")) {
          break;
        }
        // A missing main file WITH the quarantine sidecar present is not a
        // healthy empty state: it is the (rare) window where quarantine
        // moved the file aside and has not yet written the empty
        // replacement — the moved bytes may even be a concurrent writer's
        // healthy repair awaiting restore. Resolving this window as an
        // empty file is never safe, lenient or strict: a lenient WRITER
        // would mutate {} and save, recreating the main path — and the
        // pending restore (deliberately no-overwrite) would then strand
        // every other workspace's metadata in the sidecar for good.
        if (await this.probeQuarantineSidecar()) {
          blockedByQuarantineWindow = true;
          if (options?.throwOnError) {
            // Strict readers surface a retryable failure (ENOENT carries an
            // errno code, so callers classify it as transient) and
            // getAllSnapshots resumes the recovery through the mutation
            // queue — never an authoritative {} that a subsequent restore
            // cannot retract.
            break;
          }
          // Lenient callers complete the recovery INLINE and re-read.
          // Inline (unqueued) is deliberate: most lenient loads run inside
          // withSerializedMutation, whose promise-chain queue is not
          // reentrant — enqueueing resumeQuarantineRecovery here would
          // deadlock. Racing a concurrent recovery is safe because every
          // step is no-overwrite (link/COPYFILE_EXCL) and idempotent. A
          // recovery failure propagates: failing one mutation in this
          // pathological window beats destroying the sidecar's data.
          await this.completeQuarantineRecovery(`${this.filePath}.corrupt`);
          continue;
        }
        // No sidecar either. With multiple instances the failed read may
        // have raced another process's COMPLETED recovery — main restored
        // (or reset to empty) and the sidecar already consumed — so the
        // absent sidecar proves nothing about the earlier ENOENT. Re-read
        // the main path instead of trusting the stale failure; only a file
        // still missing on the final attempt is a healthy empty state.
        if (attempt === MAX_READ_ATTEMPTS) {
          return { version: 1, workspaces: {} };
        }
      }
    }
    if (
      options?.throwOnError ||
      blockedByQuarantineWindow ||
      ExtensionMetadataService.isErrnoCode(lastError, UNSUPPORTED_METADATA_VERSION_CODE)
    ) {
      throw lastError;
    }
    log.error("Failed to load metadata:", lastError);
    return { version: 1, workspaces: {} };
  }

  private async save(data: ExtensionMetadataFile): Promise<void> {
    // Throws on failure so callers that need to know whether the write
    // actually happened (e.g. AgentStatusService dedup) can react.
    // emitWorkspaceActivityUpdate (the historical wrapper used elsewhere)
    // downgrades throws to logged warnings for log-and-continue paths.
    try {
      const content = JSON.stringify(data, null, 2);
      await writeFileAtomic(this.filePath, content, "utf-8");
    } catch (error) {
      log.error("Failed to save metadata:", error);
      throw error;
    }
  }

  /**
   * Update the recency timestamp for a workspace.
   * Call this on user messages or other interactions.
   */
  async updateRecency(
    workspaceId: string,
    timestamp: number = Date.now()
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, timestamp, (workspace) => {
      workspace.recency = timestamp;
    });
  }

  /**
   * Set the streaming status for a workspace.
   * Call this when streams start/end.
   */
  async setStreaming(
    workspaceId: string,
    streaming: boolean,
    update: ExtensionMetadataStreamingUpdate = {}
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, Date.now(), (workspace) => {
      workspace.streaming = streaming;
      if (update.generation !== undefined) {
        workspace.streamingGeneration = update.generation;
      }
      if (update.model) {
        workspace.lastModel = update.model;
      }
      if (update.thinkingLevel !== undefined) {
        workspace.lastThinkingLevel = update.thinkingLevel;
      }
      if (update.todoStatus !== undefined) {
        if (update.todoStatus) {
          workspace.todoStatus = update.todoStatus;
        } else {
          delete workspace.todoStatus;
        }
      }
      if (update.hasTodos !== undefined) {
        workspace.hasTodos = update.hasTodos;
      }
    });
  }

  /**
   * Update the todo-derived status payload for a workspace.
   */
  async setTodoStatus(
    workspaceId: string,
    todoStatus: ExtensionAgentStatus | null,
    hasTodos: boolean
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, Date.now(), (workspace) => {
      if (todoStatus) {
        workspace.todoStatus = todoStatus;
      } else {
        delete workspace.todoStatus;
      }
      workspace.hasTodos = hasTodos;
    });
  }

  /**
   * AgentStatusService writes its AI-generated payload into the same
   * `todoStatus` field used by the todo-derived path. Passing `null` clears
   * the slot.
   *
   * Unlike `setTodoStatus`, this writer:
   * - Never advances `recency`. Background regeneration must not promote
   *   idle workspaces in the sidebar or mark them unread. Existing entries
   *   keep their user-interaction recency; brand-new entries (rare: chat
   *   exists but no metadata yet) are seeded with `recency=0` until the
   *   next real user interaction.
   * - Doesn't touch `hasTodos`. The todo-derivation path owns that flag.
   * - Persists `inputHash` (AgentStatusService's dedup key for the input
   *   that produced `status`) atomically with the status so a restarted
   *   process can skip regenerating unchanged chats. A skipped write records
   *   nothing; clearing the status clears the hash.
   */
  async setSidebarStatus(
    workspaceId: string,
    status: ExtensionAgentStatus | null,
    options: { skipIfRecencyAdvancedSince?: number | null; inputHash?: string | null } = {}
  ): Promise<WorkspaceActivitySnapshot | null> {
    // See deletedWorkspaceIds: never resurrect a removed workspace's entry.
    if (this.deletedWorkspaceIds.has(workspaceId)) {
      return null;
    }
    return this.withSerializedMutation(async () => {
      // Re-check inside the queue (see mutateWorkspaceSnapshot): tombstones
      // published by an already-enqueued prune must be honored here too.
      if (this.deletedWorkspaceIds.has(workspaceId)) {
        return null;
      }
      const data = await this.load();
      const existing = coerceExtensionMetadata(data.workspaces[workspaceId]);
      const workspace: ExtensionMetadata = existing ?? {
        recency: 0,
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
        agentStatus: null,
        displayStatus: null,
        lastStatusUrl: null,
      };
      if (
        options.skipIfRecencyAdvancedSince !== undefined &&
        existing &&
        (options.skipIfRecencyAdvancedSince === null ||
          existing.recency > options.skipIfRecencyAdvancedSince)
      ) {
        return null;
      }
      if (status) {
        workspace.todoStatus = status;
        // The hash must describe exactly the input that produced the
        // persisted status; a write without a hash invalidates any stale one.
        workspace.sidebarStatusInputHash = options.inputHash ?? null;
      } else {
        delete workspace.todoStatus;
        delete workspace.sidebarStatusInputHash;
      }
      data.workspaces[workspaceId] = workspace;
      await this.save(data);
      return toWorkspaceActivitySnapshot(workspace);
    });
  }

  /**
   * Backend-only reader for the dedup hash persisted by setSidebarStatus.
   * Deliberately not part of getSnapshot()/getAllSnapshots():
   * WorkspaceActivitySnapshot is an IPC shape and must not grow
   * backend-only fields.
   */
  async getSidebarStatusInputHash(workspaceId: string): Promise<string | null> {
    const data = await this.load();
    const entry = coerceExtensionMetadata(data.workspaces[workspaceId]);
    // Codex review: other writers (setTodoStatus, setStreaming) clear or
    // replace the shared todoStatus slot without touching the hash. A hash
    // with no live status behind it is orphaned and must read as absent —
    // otherwise a restart would dedup an unchanged transcript against a
    // cleared slot and leave the sidebar blank until the transcript changed.
    if (!entry?.todoStatus) return null;
    return entry.sidebarStatusInputHash ?? null;
  }

  /**
   * Update the latest transient non-todo status payload for a workspace.
   */
  async setAgentStatus(
    workspaceId: string,
    agentStatus: ExtensionAgentStatus | null
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, Date.now(), (workspace) => {
      const previousUrl =
        coerceAgentStatus(workspace.displayStatus)?.url ??
        coerceStatusUrl(workspace.lastStatusUrl) ??
        null;

      if (agentStatus) {
        const carriedUrl = agentStatus.url ?? previousUrl ?? undefined;
        workspace.displayStatus =
          carriedUrl !== undefined
            ? {
                ...agentStatus,
                url: carriedUrl,
              }
            : agentStatus;
        workspace.lastStatusUrl = carriedUrl ?? null;
      } else {
        workspace.displayStatus = null;
        // Once a transient display status clears, also clear any legacy status payload so
        // upgraded workspaces do not resurface stale pre-todo progress on the next snapshot.
        workspace.agentStatus = null;
        // Keep lastStatusUrl across clears so the next transient status without `url`
        // can still reuse the previous deep link.
        workspace.lastStatusUrl = previousUrl;
      }
    });
  }

  async setGoal(
    workspaceId: string,
    goal: GoalSnapshot | null
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, Date.now(), (workspace) => {
      workspace.goal = goal;
    });
  }

  async getSnapshot(workspaceId: string): Promise<WorkspaceActivitySnapshot | null> {
    const data = await this.load();
    return this.toSnapshot(data.workspaces[workspaceId]);
  }

  /**
   * Whether this process removed the workspace's entry (see
   * deletedWorkspaceIds). Lets emit paths suppress late activity broadcasts
   * whose disk writes the tombstone already blocked.
   */
  isWorkspaceDeleted(workspaceId: string): boolean {
    return this.deletedWorkspaceIds.has(workspaceId);
  }

  /**
   * Drop write tombstones for ids a fresh config view proves are registered.
   * Tombstones are process-local removal knowledge and the shared config is
   * the authority: with XUM_ALLOW_MULTIPLE_INSTANCES a downgraded concurrent
   * backend can legitimately re-register a deterministic legacy id this
   * process pruned earlier, and without this hook the stale tombstone would
   * suppress every one of the revived workspace's metadata writes (and
   * filter it from activity lists) until restart. Called from the activity
   * bootstrap with fresh config-derived id sets only — never with snapshot
   * or in-memory cache keys, which do not prove registration.
   *
   * `eligibleIds` must be a getTombstonedIds() snapshot captured BEFORE the
   * registration evidence was gathered: clearing is sound only when the
   * evidence postdates the tombstone. A tombstone published while the
   * evidence reads were in flight (same-process removal during the activity
   * list's authoritative enumeration await) would otherwise be cleared by a
   * stale pre-removal view, un-suppressing late writers and letting the
   * removed entry ride back into the renderer.
   */
  clearTombstonesForRegisteredIds(
    registeredIds: ReadonlySet<string>,
    eligibleIds: ReadonlySet<string>
  ): void {
    for (const workspaceId of eligibleIds) {
      if (registeredIds.has(workspaceId)) {
        this.deletedWorkspaceIds.delete(workspaceId);
      }
    }
  }

  /**
   * Snapshot of the ids currently write-tombstoned in this process. Capture
   * it before gathering registration evidence and pass it back to
   * clearTombstonesForRegisteredIds as the set of clearable tombstones.
   */
  getTombstonedIds(): ReadonlySet<string> {
    return new Set(this.deletedWorkspaceIds);
  }

  /**
   * Delete metadata for a workspace.
   * Call this when a workspace is deleted.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    // Synchronously, before the queued mutation: any writer enqueued from now
    // on must see the tombstone (see deletedWorkspaceIds).
    this.deletedWorkspaceIds.add(workspaceId);
    await this.withSerializedMutation(async () => {
      const data = await this.load();

      // Key presence, not truthiness: malformed falsy persisted entries
      // (e.g. null) must be deleted too, or removal leaves a stale key
      // behind until the next process-start prune.
      if (workspaceId in data.workspaces) {
        delete data.workspaces[workspaceId];
        await this.save(data);
      }
    });
  }

  /**
   * Remove entries whose workspace no longer exists. Removed workspaces and
   * sub-agents were historically never pruned here, so long-lived deployments
   * accumulate thousands of stale entries that inflate every read and rewrite
   * of this file (issue #3959 measured 13,895 entries for 1,513 known
   * workspaces). Called once per process; `deleteWorkspace` keeps the file
   * bounded afterwards.
   *
   * Loss safety: `getKnownWorkspaceIds` is invoked INSIDE the serialized
   * mutation and strictly AFTER the file is loaded, and the callback reads
   * config fresh from disk. A workspace is durably registered in config
   * before its first metadata write, so every entry visible in the loaded
   * file belongs to a workspace whose registration is already on disk — the
   * post-load fetch therefore always includes live entries' ids, even for
   * workspaces created concurrently by another backend process
   * (XUM_ALLOW_MULTIPLE_INSTANCES). Fetching before the load would leave a
   * window where another process registers + writes a fresh entry that the
   * stale known-ids set misclassifies as prunable.
   *
   * Cross-process writers (XUM_ALLOW_MULTIPLE_INSTANCES) are not serialized
   * by the in-process queue, so this pass never rewrites its own working
   * snapshot: it computes the stale-id set from the first load, then re-loads
   * a FRESH snapshot and applies only those deletions before saving. A fresh
   * entry another backend wrote between the two loads is preserved (its id
   * was not in the first snapshot, so it is never classified stale), and
   * since workspace ids are never reused, a stale id cannot have become live
   * in between. The residual window (a foreign write landing during the
   * final stringify+atomic-write) is the same lost-update window every
   * existing writer of this file already has.
   *
   * Upgrade↔downgrade safety: surviving entries are round-tripped verbatim
   * (no coercion), so fields written by other builds are preserved and the
   * on-disk format is unchanged.
   */
  async pruneMissingWorkspaces(
    getKnownWorkspaceIds: () => Promise<ReadonlySet<string>>,
    // Optional cheaper view for the mid-prune re-registration recheck: it
    // only needs to answer "is this stale-classified id registered NOW", so
    // callers whose full enumeration is expensive (per-workspace filesystem
    // walks) can substitute an equally-complete but cheaper read. It must be
    // COMPLETE (contain every currently registered id) or throw — resolving
    // with a lossy set would let the prune delete a re-registered
    // workspace's data. Defaults to getKnownWorkspaceIds.
    recheckKnownWorkspaceIds?: () => Promise<ReadonlySet<string>>
  ): Promise<number> {
    return this.withSerializedMutation(async () => {
      const data = await this.load();
      const knownWorkspaceIds = await getKnownWorkspaceIds();
      const staleWorkspaceIds = Object.keys(data.workspaces).filter(
        (workspaceId) => !knownWorkspaceIds.has(workspaceId)
      );
      for (const workspaceId of staleWorkspaceIds) {
        // Same guard as deleteWorkspace: a late in-process writer must not
        // resurrect an entry this pass reclaims.
        this.deletedWorkspaceIds.add(workspaceId);
      }
      if (staleWorkspaceIds.length === 0) {
        return 0;
      }
      // Deletion-only merge against a fresh snapshot (see doc comment above).
      const fresh = await this.load();
      // Re-fetch the known ids AFTER the fresh load: with multiple instances
      // a downgraded backend can re-register a deterministic legacy id (and
      // write new activity for it) between the enumeration above and here.
      // Deleting on the stale classification would destroy that new entry's
      // recency/goal/status — clearing the tombstone later cannot restore
      // data. A re-registered id is dropped from the deletion set and its
      // write tombstone lifted. If the recheck fails, abort the prune (throw
      // to the caller's catch) rather than deleting on stale knowledge.
      const recheckedKnownIds = await (recheckKnownWorkspaceIds ?? getKnownWorkspaceIds)();
      let prunedCount = 0;
      for (const workspaceId of staleWorkspaceIds) {
        if (recheckedKnownIds.has(workspaceId)) {
          this.deletedWorkspaceIds.delete(workspaceId);
          continue;
        }
        if (workspaceId in fresh.workspaces) {
          delete fresh.workspaces[workspaceId];
          prunedCount++;
        }
      }
      if (prunedCount > 0) {
        await this.save(fresh);
      }
      return prunedCount;
    });
  }

  /**
   * Clear all streaming flags.
   * Call this on app startup to clean up stale streaming states from crashes.
   */
  async clearStaleStreaming(): Promise<void> {
    await this.withSerializedMutation(async () => {
      const data = await this.load();
      let modified = false;

      for (const [workspaceId, entry] of Object.entries(data.workspaces)) {
        const normalized = coerceExtensionMetadata(entry);
        if (!normalized?.streaming) {
          continue;
        }

        normalized.streaming = false;
        data.workspaces[workspaceId] = normalized;
        modified = true;
      }

      if (modified) {
        await this.save(data);
      }
    });
  }

  /**
   * fs errors carry an errno `code` and may be transient (EACCES/EIO/...);
   * anything readFile's content produced afterwards (JSON parse or structure
   * validation errors) fails identically for the same bytes on every retry.
   */
  private static isDeterministicCorruption(error: unknown): boolean {
    return !(typeof error === "object" && error != null && "code" in error);
  }

  private static isErrnoCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error != null && "code" in error && error.code === code;
  }

  /**
   * A structurally sound file whose version is not 1: written by a newer
   * schema, not corrupt. Carries the marker code so isDeterministicCorruption
   * classifies it as non-quarantinable and load() refuses to self-heal it.
   */
  private static isUnsupportedVersion(parsed: unknown): boolean {
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "version" in parsed &&
      (parsed as { version?: unknown }).version !== 1
    );
  }

  private static unsupportedVersionError(): NodeJS.ErrnoException {
    const error = new Error(
      "Unsupported extension metadata file version (written by a newer build)"
    ) as NodeJS.ErrnoException;
    error.code = UNSUPPORTED_METADATA_VERSION_CODE;
    return error;
  }

  private static isValidMetadataFileShape(parsed: unknown): parsed is ExtensionMetadataFile {
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const candidate = parsed as { version?: unknown; workspaces?: unknown };
    return (
      candidate.version === 1 &&
      typeof candidate.workspaces === "object" &&
      candidate.workspaces !== null &&
      !Array.isArray(candidate.workspaces)
    );
  }

  /**
   * Move a deterministically corrupt metadata file aside so strict readers
   * stop failing on every retry across process restarts (nothing else
   * repairs the file until some unrelated writer happens to replace it).
   * The original bytes are preserved at a fixed `.corrupt` path for
   * inspection rather than deleted; the fixed name keeps quarantine bounded.
   * Serialized with writers, and corruption is re-verified inside the queue
   * so a concurrently repaired (just-saved) file is never quarantined.
   */
  private async quarantineCorruptFile(): Promise<boolean> {
    return this.withSerializedMutation(async () => {
      try {
        await this.load({ throwOnError: true });
        return false; // Healed concurrently (or transiently unreadable before).
      } catch (error) {
        if (!ExtensionMetadataService.isDeterministicCorruption(error)) {
          return false;
        }
      }
      const quarantinePath = `${this.filePath}.corrupt`;
      await rename(this.filePath, quarantinePath);
      return this.completeQuarantineRecovery(quarantinePath);
    });
  }

  /**
   * Finish a quarantine whose main file was already moved to the sidecar:
   * restore the sidecar to the main path when its bytes turn out healthy,
   * otherwise leave the corrupt bytes quarantined and reset the main path to
   * a valid empty file. Factored out of quarantineCorruptFile so a recovery
   * interrupted by a crash between the rename and this completion can be
   * RESUMED on the next strict read (see resumeQuarantineRecovery) instead
   * of leaving strict reads failing until an unrelated writer saves.
   * Must run inside withSerializedMutation.
   */
  private async completeQuarantineRecovery(quarantinePath: string): Promise<boolean> {
    // The mutation queue is process-local: another backend's atomic save
    // can land a healthy file between the validation above and the rename,
    // and the rename would move THAT file aside. Re-validate the bytes that
    // actually got moved and undo the move when they turn out healthy.
    // Only deterministic parse corruption is the expected quarantine
    // outcome here; a transient failure reading the sidecar means the
    // moved bytes cannot be verified, so it propagates (retryable) rather
    // than reporting a successful reset over possibly-healthy data.
    let moved: unknown;
    let movedParses = true;
    try {
      moved = JSON.parse(await readFile(quarantinePath, "utf-8")) as unknown;
    } catch (readError) {
      if (!ExtensionMetadataService.isDeterministicCorruption(readError)) {
        throw readError;
      }
      movedParses = false;
    }
    if (
      movedParses &&
      (ExtensionMetadataService.isValidMetadataFileShape(moved) ||
        // A newer build's schema stranded in the sidecar (crash-interrupted
        // quarantine on a downgraded install, or a newer backend saving the
        // main file between the in-queue corruption check and the rename) is
        // preserved data, not corruption: restore it instead of falling
        // through to the empty-reset below, which would hand the newer build
        // an empty canonical file. The subsequent re-read then fails with
        // the non-destructive unsupported-version signal.
        ExtensionMetadataService.isUnsupportedVersion(moved))
    ) {
      // Restore without ever overwriting a newer file yet another writer
      // may have re-created at the main path: link and COPYFILE_EXCL both
      // fail with EEXIST in that case. EEXIST is NOT a successful recovery
      // though — the re-created file may be a PARTIAL snapshot an older
      // backend self-healed from the missing-main window (older builds read
      // ENOENT as empty and save their one mutated entry), so the sidecar's
      // other entries must be reconciled into it rather than abandoned.
      try {
        await link(quarantinePath, this.filePath);
      } catch (linkError) {
        if (ExtensionMetadataService.isErrnoCode(linkError, "EEXIST")) {
          return this.reconcileRecreatedMainWithSidecar(quarantinePath);
        }
        try {
          // Filesystems without hard-link support (or EPERM): copy-based
          // restore with the same EEXIST no-overwrite guarantee.
          await copyFile(quarantinePath, this.filePath, constants.COPYFILE_EXCL);
        } catch (copyError) {
          if (ExtensionMetadataService.isErrnoCode(copyError, "EEXIST")) {
            return this.reconcileRecreatedMainWithSidecar(quarantinePath);
          }
          // Restore failed with the main path missing: rethrow so the
          // strict reader propagates a retryable failure instead of
          // reading ENOENT as an authoritative empty state while the
          // healthy bytes sit in the sidecar.
          throw copyError;
        }
      }
      await unlink(quarantinePath).catch(() => undefined);
      return false;
    }
    // Replace the quarantined main file with a valid EMPTY file instead of
    // leaving the path missing: between the rename above and here, strict
    // readers (this or another process) would otherwise observe ENOENT.
    // A missing-main window is dangerous because load() treats plain
    // ENOENT as a healthy empty state — combined with a concurrent writer
    // repairing the file right before the rename, a reader in the gap
    // could return an authoritative {} that a later restore cannot
    // retract. With a real empty file the corrupt→empty transition is
    // atomic (link/COPYFILE_EXCL below never overwrite a file a
    // concurrent writer re-created first), and load()'s sidecar check
    // turns any remaining missing-main window into a retryable failure
    // instead of an empty read.
    const emptyTmpPath = `${this.filePath}.empty.tmp`;
    await writeFile(
      emptyTmpPath,
      JSON.stringify({ version: 1, workspaces: {} } satisfies ExtensionMetadataFile, null, 2),
      "utf-8"
    );
    try {
      await link(emptyTmpPath, this.filePath);
    } catch (linkError) {
      if (!ExtensionMetadataService.isErrnoCode(linkError, "EEXIST")) {
        try {
          await copyFile(emptyTmpPath, this.filePath, constants.COPYFILE_EXCL);
        } catch (copyError) {
          if (!ExtensionMetadataService.isErrnoCode(copyError, "EEXIST")) {
            // Main path still missing: rethrow (retryable) so the caller's
            // re-read hits the sidecar guard instead of reading ENOENT.
            throw copyError;
          }
        }
      }
    }
    await unlink(emptyTmpPath).catch(() => undefined);
    log.error(
      `Extension metadata file was corrupt; moved it to ${quarantinePath} and reset to empty`
    );
    return true;
  }

  /**
   * Resume a quarantine that a crash interrupted between quarantineCorruptFile's
   * rename and its completion: the main file is missing while the sidecar still
   * holds the moved bytes. Without this, every strict read rethrows the ENOENT
   * (load()'s sidecar guard classifies it retryable) until an unrelated writer
   * happens to save — activity hydration would retry forever on an idle
   * process. No-op when the main file reappeared or no sidecar exists.
   */
  private async resumeQuarantineRecovery(): Promise<void> {
    await this.withSerializedMutation(async () => {
      // Re-check inside the queue: a concurrent writer save or a sibling
      // strict read may already have recovered the main path.
      const quarantinePath = `${this.filePath}.corrupt`;
      const sidecarExists = await access(quarantinePath).then(
        () => true,
        () => false
      );
      if (!sidecarExists) {
        return;
      }
      const mainExists = await access(this.filePath).then(
        () => true,
        () => false
      );
      if (mainExists) {
        // Main was recreated during the crash window — possibly a PARTIAL
        // file another backend self-healed from the missing-main state.
        // Merge the sidecar's other entries back instead of abandoning them.
        await this.reconcileRecreatedMainWithSidecar(quarantinePath);
        return;
      }
      await this.completeQuarantineRecovery(quarantinePath);
    });
  }

  /**
   * A restore found the main path already re-created (EEXIST), or a resumed
   * recovery found both files present. The re-created file may be a PARTIAL
   * snapshot an older backend self-healed from the missing-main window;
   * treating it as authoritative would permanently hide every other
   * workspace's recency/goal/status while the full data sits in the sidecar.
   * Merge sidecar-only entries into the main file (main wins per key — its
   * writes are newer; ids this process write-tombstoned stay out) and consume
   * the sidecar. Only same-schema (version 1) sidecars can be merged: a
   * corrupt sidecar is left as the bounded fixed-name leftover, while a
   * newer-schema sidecar is restored to the canonical path (superseding the
   * recreated file, preserved as its own leftover). Must run inside
   * withSerializedMutation. Returns false (no empty reset happened).
   */
  private async reconcileRecreatedMainWithSidecar(quarantinePath: string): Promise<boolean> {
    let sidecarParsed: unknown;
    try {
      sidecarParsed = JSON.parse(await readFile(quarantinePath, "utf-8")) as unknown;
    } catch (readError) {
      // Sidecar gone: a concurrent recovery consumed it and the recreated
      // main is all there is — nothing left to reconcile.
      if (ExtensionMetadataService.isErrnoCode(readError, "ENOENT")) {
        return false;
      }
      // Transient I/O failure (EACCES/EIO/...): the sidecar cannot be
      // verified, and reporting success would make the caller accept the
      // possibly-partial recreated main while the healthy sidecar is never
      // inspected again (loads stop probing it once the main path exists).
      // Propagate so the strict read stays retryable; only deterministic
      // parse corruption below stays as the bounded fixed-name leftover.
      if (!ExtensionMetadataService.isDeterministicCorruption(readError)) {
        throw readError;
      }
      return false;
    }
    if (ExtensionMetadataService.isUnsupportedVersion(sidecarParsed)) {
      // A newer build's schema stranded in the sidecar while an older-schema
      // backend re-created the main path (usually a partial ENOENT self-heal
      // holding one freshly mutated entry). Accepting the recreated file
      // would lose the newer data permanently: nothing re-inspects the
      // sidecar once the main path exists, so even re-upgrading reads the
      // partial file — and a later quarantine's rename would destroy the
      // sidecar bytes. Restore the newer bytes to the canonical path
      // (upgrade↔downgrade preservation; this build's readers then see the
      // same non-destructive retryable unsupported-version signal as any
      // downgrade overlap) and preserve the recreated file as a bounded
      // fixed-name leftover. A crash between the two steps leaves the
      // resumable missing-main + sidecar state, which restores the
      // unsupported sidecar via completeQuarantineRecovery.
      await rename(this.filePath, `${this.filePath}.recreated`);
      try {
        await link(quarantinePath, this.filePath);
      } catch (linkError) {
        if (ExtensionMetadataService.isErrnoCode(linkError, "EEXIST")) {
          // Yet another writer re-created the main path mid-swap: re-enter
          // with the new file (the leftover keeps the latest superseded one).
          return this.reconcileRecreatedMainWithSidecar(quarantinePath);
        }
        try {
          await copyFile(quarantinePath, this.filePath, constants.COPYFILE_EXCL);
        } catch (copyError) {
          if (ExtensionMetadataService.isErrnoCode(copyError, "EEXIST")) {
            return this.reconcileRecreatedMainWithSidecar(quarantinePath);
          }
          // Main path missing with the newer bytes still in the sidecar:
          // rethrow (retryable) — the resumed recovery restores them.
          throw copyError;
        }
      }
      await unlink(quarantinePath).catch(() => undefined);
      return false;
    }
    if (!ExtensionMetadataService.isValidMetadataFileShape(sidecarParsed)) {
      return false;
    }
    let main: ExtensionMetadataFile;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf-8")) as unknown;
      if (!ExtensionMetadataService.isValidMetadataFileShape(parsed)) {
        // Corrupt/newer-schema main: leave both files for the normal read
        // classification paths rather than merging across schemas.
        return false;
      }
      main = parsed;
    } catch (readError) {
      // Main vanished again mid-reconcile: back to the resumable
      // missing-main state the normal read paths already handle.
      if (ExtensionMetadataService.isErrnoCode(readError, "ENOENT")) {
        return false;
      }
      // Same transient-I/O contract as the sidecar read above: an
      // unverifiable main must stay retryable, not report success.
      if (!ExtensionMetadataService.isDeterministicCorruption(readError)) {
        throw readError;
      }
      return false;
    }
    let modified = false;
    for (const [workspaceId, entry] of Object.entries(sidecarParsed.workspaces)) {
      if (workspaceId in main.workspaces || this.deletedWorkspaceIds.has(workspaceId)) {
        continue;
      }
      main.workspaces[workspaceId] = entry;
      modified = true;
    }
    if (modified) {
      await this.save(main);
    }
    // Consumed either way: every surviving sidecar entry is now represented
    // at the main path.
    await unlink(quarantinePath).catch(() => undefined);
    return false;
  }

  async getAllSnapshots(options?: {
    throwOnError?: boolean;
  }): Promise<Map<string, WorkspaceActivitySnapshot>> {
    let data: ExtensionMetadataFile;
    try {
      data = await this.load(options);
    } catch (error) {
      // Strict reads must propagate transient failures (renderer keeps
      // last-known state and retries), but deterministic corruption would
      // fail every retry forever on an idle process. Quarantine the corrupt
      // bytes and re-read: the post-quarantine empty state is authoritative.
      if (ExtensionMetadataService.isDeterministicCorruption(error)) {
        try {
          await this.quarantineCorruptFile();
        } catch (quarantineError) {
          // ENOENT means the file vanished between validation and rename
          // (another process moved it) — the re-read below decides the
          // outcome. Anything else (rename denied, sidecar unverifiable,
          // restore failed) must stay a retryable failure: an ENOENT re-read
          // would masquerade as authoritative empty while the moved bytes may
          // hold healthy data.
          if (!ExtensionMetadataService.isErrnoCode(quarantineError, "ENOENT")) {
            throw quarantineError;
          }
        }
      } else if (ExtensionMetadataService.isErrnoCode(error, "ENOENT")) {
        // load() only propagates ENOENT while the quarantine sidecar exists:
        // a crash between quarantine's rename and its completion left the
        // recovery half-done, and nothing else finishes it (lenient writer
        // reads self-heal in memory without saving). Resume it here so
        // strict reads stop failing on every retry across restarts.
        await this.resumeQuarantineRecovery();
      } else {
        throw error;
      }
      data = await this.load(options);
    }
    const map = new Map<string, WorkspaceActivitySnapshot>();
    for (const [workspaceId, entry] of Object.entries(data.workspaces)) {
      const snapshot = this.toSnapshot(entry);
      if (snapshot) {
        map.set(workspaceId, snapshot);
      }
    }
    return map;
  }
}
