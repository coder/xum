/**
 * Integrated versioned cache store with reactive subscriptions.
 *
 * Combines versioning, lazy caching, and change notifications into one tool:
 * - Explicit invalidation keeps only the current snapshot per key
 * - Lazy computation via get(key, compute) for derived state
 * - Global and per-key subscriptions for selective re-renders
 * - Explicit change signaling via bump() - no hidden equality checks
 *
 * Used by WorkspaceStore and GitStatusStore for state management.
 *
 * Design:
 * - bump(key) increments version and notifies subscribers
 * - get(key, compute) returns cached value for current version
 * - Cache entries use logical keys and are removed on bump
 * - Old snapshots are released immediately rather than retained across versions
 */

type Listener = () => void;

export class MapStore<K, V> {
  private versions = new Map<K, number>();
  private cache = new Map<K, V>();
  private global = new Set<Listener>();
  private perKey = new Map<K, Set<Listener>>();
  // DEV-mode guard: track render depth to catch bump() during render
  private renderDepth = 0;

  /**
   * Get value for a key with lazy computation.
   * Computation only runs if:
   * - Version changed since last get() for this key
   * - Value was never computed for this version
   *
   * Returns cached value for current version.
   *
   * IMPORTANT: This is a pure getter - no side effects.
   * Does not modify versions map (only bump() does that).
   * Safe to call during React render.
   */
  get(key: K, compute: () => V): V {
    // DEV-mode: Track render depth to detect bump() during render
    // eslint-disable-next-line no-restricted-globals, no-restricted-syntax
    if (process.env.NODE_ENV !== "production") {
      this.renderDepth++;
      try {
        return this.getImpl(key, compute);
      } finally {
        this.renderDepth--;
      }
    }

    return this.getImpl(key, compute);
  }

  private getImpl(key: K, compute: () => V): V {
    if (!this.cache.has(key)) {
      this.cache.set(key, compute());
    }

    return this.cache.get(key)!;
  }

  /**
   * Check if key has been bumped (has versioned state).
   * Returns false for keys that were only get() without bump().
   */
  has(key: K): boolean {
    return this.versions.has(key);
  }

  /**
   * Bump version for a key, invalidating cache and notifying subscribers.
   *
   * ⚠️ **IMPORTANT**: Only call outside React render phase!
   *
   * Safe contexts:
   * - IPC message handlers (queueMicrotask ensures async)
   * - setTimeout/setInterval callbacks
   * - User event handlers (onClick, etc.)
   *
   * Unsafe contexts:
   * - Constructor
   * - Component render
   * - useEffect/useLayoutEffect (during setup phase)
   * - Synchronous initialization code
   *
   * Why? bump() triggers subscriptions, which can cause React to detect
   * nested state updates and throw "Maximum update depth exceeded".
   *
   * @example
   * ```typescript
   * // ❌ BAD - During initialization
   * addWorkspace(id: string) {
   *   this.aggregators.set(id, new Aggregator());
   *   this.states.bump(id);  // INFINITE LOOP!
   * }
   *
   * // ✅ GOOD - In IPC handler
   * handleMessage(id: string, data: Message) {
   *   this.aggregator.get(id).addMessage(data);
   *   this.states.bump(id);  // Safe - async context
   * }
   * ```
   */
  bump(key: K): void {
    // DEV-mode guard: detect bump() during render
    // eslint-disable-next-line no-restricted-globals, no-restricted-syntax
    if (process.env.NODE_ENV !== "production" && this.renderDepth > 0) {
      const error = new Error(
        `[MapStore] bump() called during render! This will cause infinite loops.\n` +
          `Key: ${String(key)}\n` +
          `This usually means you're calling bump() in a constructor, useEffect, or other ` +
          `synchronous initialization code. Move bump() calls to async contexts like IPC handlers.`
      );
      console.error(error);
      throw error;
    }

    const current = this.versions.get(key) ?? 0;
    this.versions.set(key, current + 1);
    // Release old snapshots even if nobody reads again; retaining every streaming
    // version grows memory for the lifetime of a workspace. Invalidate before notifying.
    this.cache.delete(key);
    // Notify subscribers
    for (const l of this.global) l();
    const ks = this.perKey.get(key);
    if (ks) {
      for (const l of ks) l();
    }
  }

  /**
   * Delete a key (clears version and all cached values).
   */
  delete(key: K): void {
    const hadCache = this.cache.delete(key);
    const hadVersion = this.versions.delete(key);
    // A render may have cached a snapshot before the first bump.
    if (!hadCache && !hadVersion) return;

    // Notify
    for (const l of this.global) l();
    const ks = this.perKey.get(key);
    if (ks) {
      for (const l of ks) l();
    }
  }

  /**
   * Clear all data.
   */
  clear(): void {
    this.versions.clear();
    this.cache.clear();
    for (const l of this.global) l();
  }

  /**
   * Subscribe to any change (global).
   * Cheap with useSyncExternalStore due to snapshot comparison.
   */
  subscribeAny = (l: Listener): (() => void) => {
    this.global.add(l);
    return () => this.global.delete(l);
  };

  /**
   * Subscribe to changes for a specific key (precise).
   * Saves snapshot calls - only notified when this key changes.
   */
  subscribeKey(key: K, l: Listener): () => void {
    let set = this.perKey.get(key);
    if (!set) this.perKey.set(key, (set = new Set()));
    set.add(l);
    return () => {
      set.delete(l);
      if (!set.size) this.perKey.delete(key);
    };
  }

  /**
   * Check if there are subscribers for a specific key.
   */
  hasKeySubscribers(key: K): boolean {
    return this.perKey.has(key);
  }
}
