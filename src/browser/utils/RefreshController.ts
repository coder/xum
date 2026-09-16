/**
 * Generic refresh controller with rate-limiting, trailing debounce, focus/visibility handling,
 * and in-flight guards.
 *
 * Handles common patterns for event-driven refresh:
 * - Rate-limits rapid trigger events (first event starts timer, subsequent coalesce)
 * - Applies trailing debounce after activity stops to capture final state
 * - Pauses refresh while document is hidden, flushes when visible
 * - Optionally triggers proactive refresh on focus (for catching external changes)
 * - Guards against concurrent refresh operations
 *
 * Used by GitStatusStore and ReviewPanel.
 */

/** Reason that triggered a refresh - useful for debugging */
export type RefreshTrigger =
  | "manual" // User clicked refresh button
  | "scheduled" // Debounced tool completion
  | "focus" // Window regained focus
  | "visibility" // Tab became visible
  | "unpaused" // Interaction ended, flushing pending
  | "in-flight-followup"; // Queued while previous refresh was running

export interface LastRefreshInfo {
  /** Timestamp of last refresh completion */
  timestamp: number;
  /** What triggered the refresh */
  trigger: RefreshTrigger;
}

export interface RefreshFailureInfo {
  /** Timestamp of failed refresh attempt */
  timestamp: number;
  /** What triggered the refresh */
  trigger: RefreshTrigger;
  /** Human-readable error message */
  errorMessage: string;
}

export interface RefreshControllerOptions {
  /** Called to execute the actual refresh. Can be async. */
  onRefresh: () => Promise<void> | void;

  /** Called after refresh completes with info about the refresh (for state updates) */
  onRefreshComplete?: (info: LastRefreshInfo) => void;

  /** Called when refresh fails (sync throw or async rejection) */
  onRefreshError?: (info: RefreshFailureInfo) => void;

  /** Debounce delay for triggered refreshes (ms). Default: 3000 */
  debounceMs?: number;

  /**
   * Whether to proactively refresh on focus, not just flush pending.
   * Enable for stores that need to catch external changes (e.g., git status).
   * Default: false (only flush pending refreshes)
   */
  refreshOnFocus?: boolean;

  /** Minimum interval between focus-triggered refreshes (ms). Default: 500 */
  focusDebounceMs?: number;

  /**
   * Optional callback to check if refresh should be paused (e.g., user is interacting).
   * If returns true, scheduled refresh is deferred until the condition clears.
   * Manual refresh (requestImmediate) still works unless isManualBlocked is also set.
   */
  isPaused?: () => boolean;

  /**
   * Optional callback to check if manual refresh should be blocked (e.g., user composing review note).
   * If returns true, BOTH scheduled AND manual refresh are blocked.
   * Use for cases where any refresh would disrupt user work-in-progress.
   */
  isManualBlocked?: () => boolean;

  /** Label for debug logging (e.g., workspace name). If set, enables debug logs. */
  debugLabel?: string;
}

/** Minimum ms between refresh executions - hard guard against loops */
const MIN_REFRESH_INTERVAL_MS = 500;

export class RefreshController {
  private readonly onRefresh: () => Promise<void> | void;
  private readonly onRefreshComplete: ((info: LastRefreshInfo) => void) | null;
  private readonly onRefreshError: ((info: RefreshFailureInfo) => void) | null;
  private readonly debounceMs: number;
  private readonly refreshOnFocus: boolean;
  private readonly focusDebounceMs: number;
  private readonly isPaused: (() => boolean) | null;
  private readonly isManualBlockedFn: (() => boolean) | null;
  private readonly debugLabel: string | null;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private pendingBecauseHidden = false;
  private pendingBecauseInFlight = false;
  private pendingBecausePaused = false;
  private lastFocusRefreshMs = 0;
  private disposed = false;
  private lifecycleGeneration = 0;

  // Track last refresh for debugging
  private _lastRefreshInfo: LastRefreshInfo | null = null;
  private pendingTrigger: RefreshTrigger | null = null;

  // Timestamp of last refresh START (not completion)
  private lastRefreshStartMs = 0;

  // Track if listeners are bound (for cleanup)
  private listenersBound = false;
  private boundHandleVisibility: (() => void) | null = null;
  private boundHandleFocus: (() => void) | null = null;

  constructor(options: RefreshControllerOptions) {
    this.onRefresh = options.onRefresh;
    this.onRefreshComplete = options.onRefreshComplete ?? null;
    this.onRefreshError = options.onRefreshError ?? null;
    this.debounceMs = options.debounceMs ?? 3000;
    this.refreshOnFocus = options.refreshOnFocus ?? false;
    this.focusDebounceMs = options.focusDebounceMs ?? 500;
    this.isPaused = options.isPaused ?? null;
    this.isManualBlockedFn = options.isManualBlocked ?? null;
    this.debugLabel = options.debugLabel ?? null;
  }

  private updatePendingTrigger(trigger: RefreshTrigger): void {
    const priorities: Record<RefreshTrigger, number> = {
      manual: 3,
      scheduled: 1,
      focus: 0,
      visibility: 0,
      unpaused: 0,
      "in-flight-followup": 0,
    };

    if (!this.pendingTrigger) {
      this.pendingTrigger = trigger;
      return;
    }

    if (priorities[trigger] >= priorities[this.pendingTrigger]) {
      this.pendingTrigger = trigger;
    }
  }
  private debug(message: string): void {
    if (this.debugLabel) {
      console.debug(`[RefreshController:${this.debugLabel}] ${message}`);
    }
  }

  /**
   * Schedule a rate-limited refresh with trailing debounce.
   *
   * Behavior (rate-limit + trailing debounce):
   * - First call starts timer for delayMs
   * - Subsequent calls mark "pending" but don't reset timer (rate-limit)
   * - When timer fires, refresh runs
   * - If calls came in during refresh, a trailing debounce timer starts after completion
   * - This captures final state after activity stops, while rate-limiting during constant activity
   */
  schedule(): void {
    this.scheduleWithDelay(this.debounceMs, "scheduled");
  }

  private scheduleWithDelay(delayMs: number, trigger: RefreshTrigger): void {
    if (this.disposed) return;

    // Always update pending trigger (manual > scheduled)
    this.updatePendingTrigger(trigger);

    // If refresh is in-flight, mark pending and let onComplete handle scheduling
    if (this.inFlight) {
      this.debug("in-flight, queueing for completion");
      this.pendingBecauseInFlight = true;
      return;
    }

    // Rate-limit: if timer already running, don't reset it
    if (this.debounceTimer) {
      this.debug("timer running, coalescing");
      return;
    }

    this.debug(`starting ${delayMs}ms timer (${trigger})`);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const t = this.pendingTrigger ?? trigger;
      this.pendingTrigger = null;
      this.debug(`timer fired, refreshing (${t})`);
      this.tryRefresh({ trigger: t });
    }, delayMs);
  }

  /**
   * Request immediate refresh, bypassing debounce and normal pause checks.
   * Use for manual refresh (user clicked button).
   *
   * Note: If isManualBlocked() returns true, the refresh is deferred (not executed).
   * This is for cases like composing a review note where any refresh would be disruptive.
   */
  requestImmediate(): void {
    if (this.disposed) return;

    // Check if manual refresh is blocked (e.g., composing review note)
    if (this.isManualBlockedFn?.()) {
      this.debug("manual refresh blocked, queueing");
      this.pendingBecausePaused = true;
      this.updatePendingTrigger("manual");
      return;
    }

    // Clear any pending debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.tryRefresh({ bypassPause: true, bypassHidden: true, trigger: "manual" });
  }

  /**
   * Attempt refresh, respecting pause conditions.
   */
  private tryRefresh(options?: {
    bypassPause?: boolean;
    bypassHidden?: boolean;
    bypassMinInterval?: boolean;
    trigger?: RefreshTrigger;
  }): void {
    if (this.disposed) return;

    const trigger = options?.trigger ?? this.pendingTrigger ?? "scheduled";
    const bypassHidden = (options?.bypassHidden ?? false) || trigger === "manual";
    const bypassPause = (options?.bypassPause ?? false) || trigger === "manual";
    const bypassMinInterval = (options?.bypassMinInterval ?? false) || trigger === "manual";

    // Hidden → queue for visibility (unless bypassed)
    if (!bypassHidden && typeof document !== "undefined" && document.hidden) {
      this.pendingBecauseHidden = true;
      this.updatePendingTrigger(trigger);
      return;
    }

    // Custom pause (e.g., user interacting) → queue for unpause
    // Bypassed for manual refresh (user explicitly requested)
    if (!bypassPause && this.isPaused?.()) {
      this.pendingBecausePaused = true;
      this.updatePendingTrigger(trigger);
      return;
    }

    // In-flight → queue for completion
    if (this.inFlight) {
      this.pendingBecauseInFlight = true;
      this.updatePendingTrigger(trigger);
      return;
    }

    // Hard guard: enforce minimum interval between refresh starts.
    // Rather than dropping the request, schedule it for the earliest allowed time.
    // Bypassed for manual refresh (user/component explicitly requested).
    if (!bypassMinInterval && this.lastRefreshStartMs > 0) {
      const now = Date.now();
      const elapsed = now - this.lastRefreshStartMs;
      if (elapsed < MIN_REFRESH_INTERVAL_MS) {
        this.updatePendingTrigger(trigger);

        if (this.cooldownTimer) {
          this.debug("cooldown timer running, coalescing");
          return;
        }

        const delayMs = MIN_REFRESH_INTERVAL_MS - elapsed;
        const t = this.pendingTrigger ?? trigger;
        this.debug(`cooldown: delaying ${delayMs}ms (${t})`);

        this.cooldownTimer = setTimeout(() => {
          this.cooldownTimer = null;
          const cooldownTrigger = this.pendingTrigger ?? t;
          this.pendingTrigger = null;
          this.tryRefresh({ trigger: cooldownTrigger });
        }, delayMs);

        return;
      }
    }

    this.executeRefresh(trigger);
  }

  /**
   * Execute the refresh, tracking in-flight state.
   */
  private executeRefresh(trigger: RefreshTrigger): void {
    if (this.disposed) return;

    this.lastRefreshStartMs = Date.now();

    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }

    this.inFlight = true;
    this.pendingTrigger = null;

    // Capture generation at start so dispose() can fence stale continuations.
    const runGeneration = this.lifecycleGeneration;
    const isRunStale = () => this.disposed || runGeneration !== this.lifecycleGeneration;

    // Shared cleanup: clear in-flight state and process any queued follow-up.
    const finalizeInFlight = () => {
      this.inFlight = false;
      if (this.pendingBecauseInFlight) {
        this.pendingBecauseInFlight = false;
        const followupTrigger = this.pendingTrigger ?? "in-flight-followup";
        this.pendingTrigger = null;
        this.scheduleWithDelay(this.debounceMs, followupTrigger);
      }
    };

    const handleSuccess = () => {
      const info: LastRefreshInfo = { timestamp: Date.now(), trigger };
      this._lastRefreshInfo = info;

      finalizeInFlight();

      try {
        this.onRefreshComplete?.(info);
      } catch (error) {
        console.error("[RefreshController] onRefreshComplete callback threw", error);
      }
    };

    const handleFailure = (error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.debug(`onRefresh failed: ${errorMessage}`);
      // Do NOT mutate _lastRefreshInfo — failure must not look like success.
      const failureInfo: RefreshFailureInfo = { timestamp: Date.now(), trigger, errorMessage };

      finalizeInFlight();

      try {
        this.onRefreshError?.(failureInfo);
      } catch (callbackError) {
        console.error("[RefreshController] onRefreshError callback threw", callbackError);
      }
    };

    // Unified promise pipeline: normalizes sync throws and async rejections
    // into a single failure path so all errors are handled identically.
    // Each stage checks isRunStale() so dispose() mid-flight stops the pipeline
    // from invoking onRefresh or external callbacks for a dead owner.
    void Promise.resolve()
      .then(() => {
        if (isRunStale()) return;
        return this.onRefresh();
      })
      .then(
        () => {
          if (isRunStale()) {
            finalizeInFlight();
            return;
          }
          handleSuccess();
        },
        (error) => {
          if (isRunStale()) {
            finalizeInFlight();
            return;
          }
          handleFailure(error);
        }
      );
  }

  /**
   * Handle focus/visibility return. Call from visibility/focus listeners.
   */
  private handleReturn(trigger: "focus" | "visibility"): void {
    if (this.disposed) return;
    if (typeof document !== "undefined" && document.hidden) return;

    // Flush pending hidden refresh
    if (this.pendingBecauseHidden) {
      this.pendingBecauseHidden = false;
      const pendingTrigger = this.pendingTrigger ?? trigger;
      this.pendingTrigger = null;
      this.tryRefresh({ trigger: pendingTrigger });
      return; // Don't double-refresh with proactive
    }

    // Proactive refresh on focus (with debounce)
    if (this.refreshOnFocus) {
      const now = Date.now();
      if (now - this.lastFocusRefreshMs >= this.focusDebounceMs) {
        this.lastFocusRefreshMs = now;
        this.tryRefresh({ trigger });
      }
    }
  }

  /**
   * Notify that a pause condition has cleared (e.g., user stopped interacting).
   * Flushes any pending refresh that was deferred due to isPaused().
   */
  notifyUnpaused(): void {
    if (this.disposed) return;
    if (this.pendingBecausePaused) {
      this.pendingBecausePaused = false;
      const pendingTrigger = this.pendingTrigger ?? "unpaused";
      this.pendingTrigger = null;
      this.tryRefresh({ trigger: pendingTrigger });
    }
  }

  /**
   * Bind focus/visibility listeners. Call once after construction.
   * Safe to call in non-browser environments (no-op).
   */
  bindListeners(): void {
    if (this.listenersBound) return;
    if (typeof document === "undefined" || typeof window === "undefined") return;
    if (
      typeof document.addEventListener !== "function" ||
      typeof document.removeEventListener !== "function" ||
      typeof window.addEventListener !== "function" ||
      typeof window.removeEventListener !== "function"
    ) {
      return;
    }

    this.boundHandleVisibility = () => {
      if (document.visibilityState === "visible") {
        this.handleReturn("visibility");
      }
    };

    this.boundHandleFocus = () => {
      this.handleReturn("focus");
    };

    document.addEventListener("visibilitychange", this.boundHandleVisibility);
    window.addEventListener("focus", this.boundHandleFocus);
    this.listenersBound = true;
  }

  /**
   * Whether a refresh is currently in-flight.
   */
  get isRefreshing(): boolean {
    return this.inFlight;
  }

  /**
   * Whether manual refresh is currently blocked (e.g., user composing review note).
   * UI can use this to disable the refresh button.
   */
  get isManualBlocked(): boolean {
    return this.isManualBlockedFn?.() ?? false;
  }

  /**
   * Info about the last completed refresh (timestamp and trigger reason).
   * Useful for debugging refresh behavior.
   */
  get lastRefreshInfo(): LastRefreshInfo | null {
    return this._lastRefreshInfo;
  }

  /**
   * Clean up timers and listeners.
   */
  dispose(): void {
    this.disposed = true;

    // Bump generation to fence any in-flight async pipeline continuations.
    this.lifecycleGeneration += 1;

    // Collapse active refresh state so observability is coherent immediately.
    this.inFlight = false;
    this.pendingBecauseInFlight = false;
    this.pendingBecauseHidden = false;
    this.pendingBecausePaused = false;
    this.pendingTrigger = null;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }

    if (this.listenersBound) {
      if (
        this.boundHandleVisibility &&
        typeof document !== "undefined" &&
        typeof document.removeEventListener === "function"
      ) {
        document.removeEventListener("visibilitychange", this.boundHandleVisibility);
      }
      if (
        this.boundHandleFocus &&
        typeof window !== "undefined" &&
        typeof window.removeEventListener === "function"
      ) {
        window.removeEventListener("focus", this.boundHandleFocus);
      }
      this.listenersBound = false;
    }
  }
}
