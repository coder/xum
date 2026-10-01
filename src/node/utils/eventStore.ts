import { SessionFileManager, type SessionFileWriteOptions } from "@/node/utils/sessionFile";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";

/**
 * EventStore - Generic state management with persistence and replay for workspace events.
 *
 * This abstraction captures the common pattern between InitStateManager and StreamManager:
 * 1. In-memory Map for active state
 * 2. Disk persistence for crash recovery / page reload
 * 3. Replay by serializing state into events and emitting them
 *
 * Type parameters:
 * - TState: The state object stored in memory/disk (e.g., InitStatus, WorkspaceStreamInfo)
 * - TEvent: The event type emitted (e.g., WorkspaceInitEvent)
 *
 * Design pattern:
 * - Composition over inheritance (doesn't extend EventEmitter directly)
 * - Subclasses provide serialization logic (state → events)
 * - Handles common operations (get/set/delete state, persist, replay)
 *
 * Example usage:
 *
 * class InitStateManager {
 *   private store = new EventStore<InitStatus, WorkspaceInitEvent>(
 *     config,
 *     "init-status.json",
 *     (state) => this.serializeInitEvents(state),
 *     (event) => this.emit(event.type, event)
 *   );
 *
 *   async replayInit(workspaceId: string) {
 *     await this.store.replay(workspaceId);
 *   }
 * }
 */
export class EventStore<TState, TEvent> {
  private stateMap = new Map<string, TState>();
  private readonly fileManager: SessionFileManager<TState>;
  private readonly serializeState: (state: TState) => TEvent[];
  private readonly emitEvent: (event: TEvent) => void;
  private readonly storeName: string;

  /**
   * Create a new EventStore.
   *
   * @param config - Config object for SessionFileManager
   * @param filename - Filename for persisted state (e.g., "init-status.json")
   * @param serializeState - Function to convert state into array of events for replay
   * @param emitEvent - Function to emit a single event (typically wraps EventEmitter.emit)
   * @param storeName - Name for logging (e.g., "InitStateManager")
   */
  constructor(
    config: Config,
    filename: string,
    serializeState: (state: TState) => TEvent[],
    emitEvent: (event: TEvent) => void,
    storeName = "EventStore"
  ) {
    this.fileManager = new SessionFileManager<TState>(config, filename);
    this.serializeState = serializeState;
    this.emitEvent = emitEvent;
    this.storeName = storeName;
  }

  /**
   * Get in-memory state for a workspace.
   * Returns undefined if no state exists.
   */
  getState(workspaceId: string): TState | undefined {
    return this.stateMap.get(workspaceId);
  }

  /**
   * Set in-memory state for a workspace.
   */
  setState(workspaceId: string, state: TState): void {
    this.stateMap.set(workspaceId, state);
  }

  /**
   * Delete in-memory state for a workspace.
   * Does NOT delete the persisted file (use deletePersisted for that).
   */
  deleteState(workspaceId: string): void {
    this.stateMap.delete(workspaceId);
  }

  /**
   * Check if in-memory state exists for a workspace.
   */
  hasState(workspaceId: string): boolean {
    return this.stateMap.has(workspaceId);
  }

  /**
   * Read persisted state from disk.
   * Returns null if no file exists.
   */
  async readPersisted(workspaceId: string): Promise<TState | null> {
    return this.fileManager.read(workspaceId);
  }

  /**
   * Write state to disk.
   * Logs errors but doesn't throw (fire-and-forget pattern). Resolves false when the write failed
   * (a write skipped by `shouldWrite` did not fail).
   */
  async persist(
    workspaceId: string,
    state: TState,
    options?: SessionFileWriteOptions
  ): Promise<boolean> {
    const result = await this.fileManager.write(workspaceId, state, options);
    if (!result.success) {
      log.error(`[${this.storeName}] Failed to persist state for ${workspaceId}: ${result.error}`);
    }
    return result.success;
  }

  /**
   * Delete persisted state from disk.
   * Does NOT clear in-memory state (use deleteState for that).
   */
  async deletePersisted(workspaceId: string): Promise<void> {
    const result = await this.fileManager.delete(workspaceId);
    if (!result.success) {
      log.error(
        `[${this.storeName}] Failed to delete persisted state for ${workspaceId}: ${result.error}`
      );
    }
  }

  /**
   * Replay events for a workspace.
   * Checks in-memory state first, falls back to disk.
   * Emits events using the provided emitEvent function.
   *
   * @param workspaceId - Workspace ID to replay events for
   * @param context - Optional context to pass to serializeState (e.g., workspaceId)
   */
  async replay(workspaceId: string, context?: Record<string, unknown>): Promise<void> {
    // Try in-memory state first (most recent)
    let state: TState | undefined = this.stateMap.get(workspaceId);

    // Fall back to disk if not in memory
    if (!state) {
      const diskState = await this.fileManager.read(workspaceId);
      if (!diskState) {
        return; // No state to replay
      }
      state = diskState;
    }

    // Augment state with context for serialization
    const augmentedState = { ...state, ...context };

    // Serialize state into events and emit them
    const events = this.serializeState(augmentedState);
    for (const event of events) {
      this.emitEvent(event);
    }
  }

  /**
   * Get all workspace IDs with in-memory state.
   * Useful for debugging or cleanup.
   */
  getActiveWorkspaceIds(): string[] {
    return Array.from(this.stateMap.keys());
  }
}

/**
 * FUTURE REFACTORING: StreamManager Pattern
 *
 * StreamManager (src/services/streamManager.ts) follows a similar pattern to InitStateManager
 * but has NOT been refactored to use EventStore yet due to:
 * 1. Complexity: StreamManager is 1332 LoC with intricate state machine logic
 * 2. Risk: Heavily tested streaming infrastructure (40+ integration tests)
 * 3. Lifecycle differences: Streams auto-cleanup on completion, init logs persist forever
 *
 * Future refactoring could extract:
 * - WorkspaceStreamInfo state management (workspaceStreams Map)
 * - Replay logic (replayStream method at line 1244)
 * - Partial persistence (currently on HistoryService partial methods)
 *
 * Key differences to handle:
 * - StreamManager has complex throttling (partialWriteTimer, PARTIAL_WRITE_THROTTLE_MS)
 * - Different persistence strategy (partial.json → chat.jsonl → delete partial)
 * - AbortController integration for stream cancellation
 * - Token tracking and usage statistics
 *
 * Pattern for adoption:
 * 1. Extract WorkspaceStreamInfo → MessagePart[] serialization into helper
 * 2. Create EventStore instance for stream state (similar to InitStateManager)
 * 3. Replace manual replay loop (line 1270-1272) with store.replay()
 * 4. Keep existing throttling and persistence strategies (out of scope for EventStore)
 *
 * See InitStateManager refactor (this PR) for reference implementation.
 */
