import type { WorkspaceConsumersState } from "./WorkspaceStore";
import type { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import type { ChatStats } from "@/common/types/chatStats";

const TOKENIZER_CANCELLED_MESSAGE = "Cancelled by newer request";

let globalTokenStatsRequestId = 0;
const latestRequestByWorkspace = new Map<string, number>();

async function calculateTokenStatsLatest(workspaceId: string, model: string): Promise<ChatStats> {
  const orpcClient = window.__ORPC_CLIENT__;
  if (!orpcClient) {
    throw new Error("ORPC client not initialized");
  }

  const requestId = ++globalTokenStatsRequestId;
  latestRequestByWorkspace.set(workspaceId, requestId);

  try {
    // Only identifiers cross the wire. The backend owns the same history (chat.jsonl +
    // partial.json) and slices it to the active context itself; uploading the renderer's copy
    // on every tool-call-end during a stream was ~36 KB/s of redundant WebSocket traffic.
    const stats = await orpcClient.tokenizer.calculateStats({ workspaceId, model });
    const latestRequestId = latestRequestByWorkspace.get(workspaceId);
    if (latestRequestId !== requestId) {
      throw new Error(TOKENIZER_CANCELLED_MESSAGE);
    }
    return stats;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error));
  }
}

// Timeout for Web Worker calculations (60 seconds - generous but responsive)
const CALCULATION_TIMEOUT_MS = 60_000;

/**
 * Manages consumer token calculations for workspaces.
 *
 * Responsibilities:
 * - Debounces rapid calculation requests (e.g., multiple tool-call-end events)
 * - Caches calculated results to avoid redundant work (source of truth)
 * - Tracks calculation state per workspace
 * - Executes Web Worker tokenization calculations
 * - Handles cleanup and disposal
 *
 * Architecture:
 * - Single responsibility: consumer tokenization calculations
 * - Owns the source-of-truth cache (calculated consumer data)
 * - WorkspaceStore orchestrates (decides when to calculate)
 * - This manager executes (performs calculations, manages cache)
 *
 * Dual-Cache Design:
 * - WorkspaceConsumerManager.cache: Source of truth for calculated data
 * - WorkspaceStore.consumersStore (MapStore): Subscription management only
 *   (components subscribe to workspace changes, delegates to manager for state)
 */
export class WorkspaceConsumerManager {
  // Track scheduled calculations (in debounce window, not yet executing)
  private scheduledCalcs = new Set<string>();

  // Track executing calculations (Web Worker running)
  private pendingCalcs = new Set<string>();

  // Track workspaces that need recalculation after current one completes
  private needsRecalc = new Map<string, StreamingMessageAggregator>();

  // Cache calculated consumer data (persists across bumps)
  private cache = new Map<string, WorkspaceConsumersState>();

  // Debounce timers for consumer calculations (prevents rapid-fire during tool sequences)
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  // Callback to bump the store when calculation completes
  private readonly onCalculationComplete: (workspaceId: string) => void;
  // Stable provider-config fingerprint to stamp persisted token stats cache entries.
  // Returns null before the first config fetch completes (blocks calculation).
  private readonly getProvidersConfigVersion: () => number | null;

  // Track pending store notifications to avoid duplicate bumps within the same tick
  private pendingNotifications = new Set<string>();

  constructor(
    onCalculationComplete: (workspaceId: string) => void,
    getProvidersConfigVersion: () => number | null
  ) {
    this.onCalculationComplete = onCalculationComplete;
    this.getProvidersConfigVersion = getProvidersConfigVersion;
  }

  /**
   * Get cached state without side effects.
   * Returns null if no cache exists.
   */
  getCachedState(workspaceId: string): WorkspaceConsumersState | null {
    return this.cache.get(workspaceId) ?? null;
  }

  /**
   * Check if calculation is pending or scheduled for workspace.
   */
  isPending(workspaceId: string): boolean {
    return this.scheduledCalcs.has(workspaceId) || this.pendingCalcs.has(workspaceId);
  }

  /**
   * Get current state synchronously without triggering calculations.
   * Returns cached result if available, otherwise returns default state.
   *
   * Note: This is called from WorkspaceStore.getWorkspaceConsumers(),
   * which handles the lazy trigger logic separately.
   */
  getStateSync(workspaceId: string): WorkspaceConsumersState {
    const cached = this.cache.get(workspaceId);
    if (cached) {
      return cached;
    }

    // Default state while scheduled/calculating or before first calculation
    return {
      consumers: [],
      tokenizerName: "",
      totalTokens: 0,
      isCalculating: this.scheduledCalcs.has(workspaceId) || this.pendingCalcs.has(workspaceId),
    };
  }

  /**
   * Hydrate consumer breakdown from a persisted cache (session-usage.json).
   * Skips hydration if a calculation is already scheduled/running.
   */
  hydrateFromCache(
    workspaceId: string,
    state: Omit<WorkspaceConsumersState, "isCalculating">
  ): void {
    if (this.pendingCalcs.has(workspaceId) || this.scheduledCalcs.has(workspaceId)) {
      return;
    }

    this.cache.set(workspaceId, { ...state, isCalculating: false });
    this.notifyStoreAsync(workspaceId);
  }

  /**
   * Schedule a consumer calculation (debounced).
   * Batches rapid events (e.g., multiple tool-call-end) into single calculation.
   * Marks as "calculating" immediately to prevent UI flash.
   *
   * If a calculation is already running, marks workspace for recalculation
   * after the current one completes.
   */
  scheduleCalculation(workspaceId: string, aggregator: StreamingMessageAggregator): void {
    // Clear existing timer for this workspace
    const existingTimer = this.debounceTimers.get(workspaceId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // If already executing, queue a follow-up recalculation
    if (this.pendingCalcs.has(workspaceId)) {
      this.needsRecalc.set(workspaceId, aggregator);
      return;
    }

    // Mark as scheduled immediately (triggers "Calculating..." UI, prevents flash)
    const isNewSchedule = !this.scheduledCalcs.has(workspaceId);
    this.scheduledCalcs.add(workspaceId);

    // Notify store if newly scheduled (triggers UI update)
    if (isNewSchedule) {
      this.notifyStoreAsync(workspaceId);
    }

    // Set new timer (150ms - imperceptible to humans, batches rapid events)
    const timer = setTimeout(() => {
      this.debounceTimers.delete(workspaceId);
      this.scheduledCalcs.delete(workspaceId); // Move from scheduled to pending
      this.executeCalculation(workspaceId, aggregator);
    }, 150);

    this.debounceTimers.set(workspaceId, timer);
  }

  /**
   * Execute background consumer calculation.
   * Only one calculation per workspace at a time.
   */
  private executeCalculation(workspaceId: string, aggregator: StreamingMessageAggregator): void {
    // Skip if already calculating
    if (this.pendingCalcs.has(workspaceId)) {
      return;
    }

    this.pendingCalcs.add(workspaceId);

    // Mark as calculating and notify store
    this.notifyStoreAsync(workspaceId);

    // Run in next tick to avoid blocking caller
    void (async () => {
      try {
        const model = aggregator.getCurrentModel() ?? "unknown";

        const providersConfigFingerprint = this.getProvidersConfigVersion();
        // Skip calculation until provider config has loaded — we don't know
        // which tokenizer/pricing to use yet. When config arrives,
        // refreshProvidersConfig() calls invalidateAll() which clears the cache,
        // and the next component access will naturally re-schedule calculation.
        // Don't set needsRecalc or throw — that would create an infinite retry
        // loop since the finally block re-schedules from needsRecalc.
        if (providersConfigFingerprint == null) {
          // Config not ready yet. Cache a stable "blocked" state so repeated
          // getWorkspaceConsumers() reads don't continuously requeue work while
          // fingerprint is null. WorkspaceStore.invalidateAll() clears this
          // cache when config changes so tokenization retries naturally.
          this.cache.set(workspaceId, {
            consumers: [],
            tokenizerName: "",
            totalTokens: 0,
            isCalculating: false,
          });
          this.notifyStoreAsync(workspaceId);
          return;
        }

        // Calculate in piscina pool with timeout protection.
        // Store the timer ID so we can clear it on early exit to prevent
        // unhandled promise rejections from orphaned timeout callbacks.
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Calculation timeout")),
            CALCULATION_TIMEOUT_MS
          );
        });

        const fullStats = await Promise.race([
          calculateTokenStatsLatest(workspaceId, model),
          timeoutPromise,
        ]).finally(() => clearTimeout(timeoutId));

        // Provider mappings may change while tokenization is in flight.
        // Drop outdated results instead of repopulating cache with stale tokenizer metadata.
        if (this.getProvidersConfigVersion() !== providersConfigFingerprint) {
          this.needsRecalc.set(workspaceId, aggregator);
          throw new Error(TOKENIZER_CANCELLED_MESSAGE);
        }

        // Store result in cache
        this.cache.set(workspaceId, {
          consumers: fullStats.consumers,
          tokenizerName: fullStats.tokenizerName,
          totalTokens: fullStats.totalTokens,
          isCalculating: false,
          topFilePaths: fullStats.topFilePaths,
        });

        // Notify store to trigger re-render
        this.notifyStoreAsync(workspaceId);
      } catch (error) {
        // Cancellations are expected during rapid events - don't cache, don't log
        // This allows lazy trigger to retry on next access
        if (error instanceof Error && error.message === TOKENIZER_CANCELLED_MESSAGE) {
          return;
        }

        // Real errors (including timeout): log and cache empty result
        console.error(`[WorkspaceConsumerManager] Calculation failed for ${workspaceId}:`, error);
        this.cache.set(workspaceId, {
          consumers: [],
          tokenizerName: "",
          totalTokens: 0,
          isCalculating: false,
        });
        this.notifyStoreAsync(workspaceId);
      } finally {
        this.pendingCalcs.delete(workspaceId);

        // If recalculation was requested while we were running, schedule it now
        const needsRecalcAggregator = this.needsRecalc.get(workspaceId);
        if (needsRecalcAggregator) {
          this.needsRecalc.delete(workspaceId);
          this.scheduleCalculation(workspaceId, needsRecalcAggregator);
        }
      }
    })();
  }

  private notifyStoreAsync(workspaceId: string): void {
    if (this.pendingNotifications.has(workspaceId)) {
      return;
    }

    this.pendingNotifications.add(workspaceId);

    const schedule =
      typeof queueMicrotask === "function"
        ? queueMicrotask
        : (callback: () => void) => {
            void Promise.resolve().then(callback);
          };

    schedule(() => {
      this.pendingNotifications.delete(workspaceId);
      this.onCalculationComplete(workspaceId);
    });
  }

  /**
   * Remove workspace state and cleanup timers.
   */
  removeWorkspace(workspaceId: string): void {
    // Clear debounce timer
    const timer = this.debounceTimers.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(workspaceId);
    }

    // Clean up state
    this.cache.delete(workspaceId);
    this.scheduledCalcs.delete(workspaceId);
    this.pendingCalcs.delete(workspaceId);
    this.needsRecalc.delete(workspaceId);
    this.pendingNotifications.delete(workspaceId);
  }

  /**
   * Invalidate cached consumer data for all workspaces.
   * Clears the in-memory cache so the next access triggers recalculation
   * (e.g., after provider config changes affect tokenizer/metadata resolution).
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Cleanup all resources.
   */
  dispose(): void {
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Clear state
    this.cache.clear();
    this.scheduledCalcs.clear();
    this.pendingCalcs.clear();
    this.needsRecalc.clear();
    this.pendingNotifications.clear();
  }
}
