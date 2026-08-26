import { dirname } from "path";
import { mkdir, readFile, access, rename } from "fs/promises";
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

  private async load(options?: { throwOnError?: boolean }): Promise<ExtensionMetadataFile> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as ExtensionMetadataFile;

      // Validate structure, including the workspaces container: a parseable
      // file with e.g. an array or primitive `workspaces` would otherwise
      // enumerate as zero entries and masquerade as an authoritative empty
      // state in strict reads.
      if (
        typeof parsed !== "object" ||
        parsed?.version !== 1 ||
        typeof parsed.workspaces !== "object" ||
        parsed.workspaces === null ||
        Array.isArray(parsed.workspaces)
      ) {
        throw new Error("Invalid extension metadata file structure");
      }

      return parsed;
    } catch (error) {
      // Only a genuinely missing file is a healthy empty state. Other read
      // failures (EACCES/ENOTDIR/EIO, parse or structure errors) must not
      // masquerade as one: throwOnError lets read paths distinguish them
      // from an authoritative empty state, while the default self-heals so
      // writers can always make progress.
      if (typeof error === "object" && error != null && "code" in error) {
        if (error.code === "ENOENT") {
          return { version: 1, workspaces: {} };
        }
      }
      if (options?.throwOnError) {
        throw error;
      }
      log.error("Failed to load metadata:", error);
      return { version: 1, workspaces: {} };
    }
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
    getKnownWorkspaceIds: () => Promise<ReadonlySet<string>>
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
      let prunedCount = 0;
      for (const workspaceId of staleWorkspaceIds) {
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
        const quarantinePath = `${this.filePath}.corrupt`;
        await rename(this.filePath, quarantinePath);
        log.error(
          `Extension metadata file was corrupt; moved it to ${quarantinePath} and reset to empty`
        );
        return true;
      }
    });
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
      if (!ExtensionMetadataService.isDeterministicCorruption(error)) {
        throw error;
      }
      await this.quarantineCorruptFile();
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
