import { dirname } from "path";
import { mkdir, readFile, access } from "fs/promises";
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

  private async mutateWorkspaceSnapshot(
    workspaceId: string,
    recency: number,
    mutate: (workspace: ExtensionMetadata) => void
  ): Promise<WorkspaceActivitySnapshot> {
    return this.withSerializedMutation(async () => {
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

  private async load(): Promise<ExtensionMetadataFile> {
    try {
      await access(this.filePath, constants.F_OK);
    } catch {
      return { version: 1, workspaces: {} };
    }

    try {
      const content = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as ExtensionMetadataFile;

      // Validate structure
      if (typeof parsed !== "object" || parsed.version !== 1) {
        log.error("Invalid metadata file, resetting");
        return { version: 1, workspaces: {} };
      }

      return parsed;
    } catch (error) {
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
    return this.withSerializedMutation(async () => {
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
   * Delete metadata for a workspace.
   * Call this when a workspace is deleted.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.withSerializedMutation(async () => {
      const data = await this.load();

      if (data.workspaces[workspaceId]) {
        delete data.workspaces[workspaceId];
        await this.save(data);
      }
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

  async getAllSnapshots(): Promise<Map<string, WorkspaceActivitySnapshot>> {
    const data = await this.load();
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
