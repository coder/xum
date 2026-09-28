import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import {
  readPersistedState,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import { isAbortError } from "@/browser/utils/isAbortError";
import {
  getHunkFirstSeenKey,
  getReviewExpandStateKey,
  getReviewReadMoreKey,
  getReviewStateKey,
  getReviewsKey,
} from "@/common/constants/storage";
import {
  REVIEW_STATE_SECTIONS,
  type ReviewStateDelta,
  type ReviewStateSection,
  type ReviewStateSectionDelta,
  type ReviewStateSections,
  type ReviewStateSectionValue,
} from "@/common/orpc/schemas/reviewState";
import type { Review } from "@/common/types/review";
import {
  applyReviewStateDelta,
  assignSection,
  mergeReviewStateDeltas,
  sanitizeReviewStateSnapshot,
  sectionDelta,
} from "@/common/utils/reviewState";

/**
 * Frontend cache for per-workspace code-review state persisted by the backend in
 * `<sessionDir>/review-state.json` (it used to live in localStorage and exhausted the quota).
 *
 * Model: `base` is the last server snapshot; `pending` holds local deltas not yet acknowledged.
 * The rendered view is base with pending layered on top using the shared merge helper, so
 * server pushes can replace `base` at any time (echoes are idempotent) without versions or
 * dirty/echo bookkeeping.
 */

export interface ReviewStateView {
  sections: ReviewStateSections;
  /**
   * True once the review UI may leave its loading state: the first server snapshot (plus the
   * legacy import) was applied, or the subscription failed before one arrived (self-heal).
   */
  isReady: boolean;
}

type SectionUpdater<S extends ReviewStateSection> = (
  previous: ReviewStateSectionValue<S>
) => ReviewStateSectionDelta<S> | null;

type QueuedUpdater = (view: ReviewStateSections) => ReviewStateDelta | null;

interface Entry {
  base: ReviewStateSections;
  pending: ReviewStateDelta[];
  /** Updaters issued before hydration; replayed onto the hydrated view. */
  queued: QueuedUpdater[];
  /** UI unblocked (see ReviewStateView.isReady); `ready` resolves at the same moment. */
  isReady: boolean;
  /**
   * A real server snapshot was applied. Distinct from isReady: a failed first subscription
   * unblocks the UI but must not replay queued updaters onto an empty base (they would then
   * be computed from missing data), and flush must not claim durability without it.
   */
  hydrated: boolean;
  /**
   * Backend revision of `base` (see ReviewStateRevisionSchema). Reset by each subscription's
   * first snapshot, so a restarted backend is never ignored.
   */
  baseRevision: number;
  ready: Promise<void>;
  resolveReady: () => void;
  refCount: number;
  view: ReviewStateView;
  listeners: Set<() => void>;
  subscription: AbortController | null;
  resubscribeTimer: ReturnType<typeof setTimeout> | null;
  resubscribeAttempt: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushAttempt: number;
  inFlight: Promise<void> | null;
}

const FLUSH_DEBOUNCE_MS = 300;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5_000;
const EMPTY_SECTIONS: ReviewStateSections = {};
const LOADING_VIEW: ReviewStateView = { sections: EMPTY_SECTIONS, isReady: false };
/** Workspace-less callers (e.g. a plan tool call without a workspace) are ready and empty. */
const EMPTY_READY_VIEW: ReviewStateView = { sections: EMPTY_SECTIONS, isReady: true };

function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
}

function isEmptyDelta(delta: { set?: Record<string, unknown>; delete?: string[] }): boolean {
  return Object.keys(delta.set ?? {}).length === 0 && (delta.delete ?? []).length === 0;
}

/**
 * Legacy localStorage keys and value shapes, read once during hydration and imported
 * into the backend (non-clobbering), then removed.
 */
const LEGACY_SECTIONS: Record<
  ReviewStateSection,
  { key: (workspaceId: string) => string; extract: (stored: unknown) => unknown }
> = {
  reviews: { key: getReviewsKey, extract: (stored) => pickField(stored, "reviews") },
  readState: { key: getReviewStateKey, extract: (stored) => pickField(stored, "readState") },
  firstSeen: { key: getHunkFirstSeenKey, extract: (stored) => pickField(stored, "firstSeen") },
  hunkExpand: { key: getReviewExpandStateKey, extract: (stored) => stored },
  readMore: { key: getReviewReadMoreKey, extract: (stored) => stored },
};

function pickField(stored: unknown, field: string): unknown {
  if (typeof stored !== "object" || stored === null) return undefined;
  return (stored as Record<string, unknown>)[field];
}

let warnedLegacyStorageUnavailable = false;

/**
 * The legacy sections still in localStorage. An unparseable key is removed (nothing to
 * migrate). When localStorage itself cannot be read (e.g. storage access denied), there is
 * nothing to migrate either: hydration continues as if no key existed.
 */
function readLegacySections(
  workspaceId: string
): Array<{ section: ReviewStateSection; value: unknown }> {
  try {
    const legacy: Array<{ section: ReviewStateSection; value: unknown }> = [];
    for (const section of REVIEW_STATE_SECTIONS) {
      const key = LEGACY_SECTIONS[section].key(workspaceId);
      if (readPersistedString(key) === undefined) continue;
      const stored = readPersistedState<unknown>(key, undefined);
      if (stored === undefined || stored === null) {
        updatePersistedState(key, undefined);
        continue;
      }
      legacy.push({ section, value: LEGACY_SECTIONS[section].extract(stored) });
    }
    return legacy;
  } catch (error) {
    if (!warnedLegacyStorageUnavailable) {
      warnedLegacyStorageUnavailable = true;
      console.warn("localStorage is unavailable; skipping the legacy review-state import:", error);
    }
    return [];
  }
}

export class ReviewStateStore {
  private client: APIClient | null = null;
  private readonly entries = new Map<string, Entry>();

  constructor() {
    if (typeof document !== "undefined") {
      // The debounce window is the only unload risk; flush as soon as the page is hidden.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden") return;
        for (const workspaceId of this.entries.keys()) {
          this.flushInBackground(workspaceId);
        }
      });
    }
  }

  setClient(client: APIClient | null): void {
    if (client === this.client) return;
    this.client = client;
    for (const [workspaceId, entry] of this.entries) {
      this.stopSubscription(entry);
      if (!client) continue;
      if (entry.refCount > 0) this.ensureSubscribed(workspaceId);
      if (entry.pending.length > 0) this.flushInBackground(workspaceId);
    }
  }

  subscribe = (workspaceId: string, listener: () => void): (() => void) => {
    if (workspaceId.length === 0) return () => undefined;
    const entry = this.getOrCreateEntry(workspaceId);
    entry.listeners.add(listener);
    entry.refCount++;
    if (entry.refCount === 1) this.ensureSubscribed(workspaceId);
    return () => {
      entry.listeners.delete(listener);
      this.release(workspaceId, entry);
    };
  };

  private release(workspaceId: string, entry: Entry): void {
    entry.refCount--;
    if (entry.refCount > 0 || this.entries.get(workspaceId) !== entry) return;
    // Keep base/view in memory so switching back does not flash empty; the next
    // subscription refreshes it.
    this.stopSubscription(entry);
    this.flushInBackground(workspaceId);
  }

  /** Hold the workspace subscription open (hydrating it if needed) while `run` settles. */
  private async withRetained<T>(
    workspaceId: string,
    run: (entry: Entry) => Promise<T>
  ): Promise<T> {
    const entry = this.getOrCreateEntry(workspaceId);
    entry.refCount++;
    if (entry.refCount === 1) this.ensureSubscribed(workspaceId);
    try {
      return await run(entry);
    } finally {
      this.release(workspaceId, entry);
    }
  }

  getView = (workspaceId: string): ReviewStateView => {
    if (workspaceId.length === 0) return EMPTY_READY_VIEW;
    return this.entries.get(workspaceId)?.view ?? LOADING_VIEW;
  };

  isReady(workspaceId: string): boolean {
    return this.getView(workspaceId).isReady;
  }

  /**
   * Resolves once the workspace's state is ready (immediately for an empty ID). Starts the
   * subscription itself when no selector is mounted, so imperative callers never hang.
   */
  whenReady(workspaceId: string): Promise<void> {
    if (workspaceId.length === 0) return Promise.resolve();
    return this.withRetained(workspaceId, (entry) => entry.ready);
  }

  getAttachedReviews(workspaceId: string): Review[] {
    return Object.values(this.getView(workspaceId).sections.reviews ?? {})
      .filter((review) => review.status === "attached")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Record a change as a pure updater over the section's current view. Before hydration the
   * updater is queued and replayed onto the server data, so defaults never overwrite it.
   */
  mutate<S extends ReviewStateSection>(
    workspaceId: string,
    section: S,
    updater: SectionUpdater<S>
  ): void {
    if (workspaceId.length === 0) return;
    const entry = this.getOrCreateEntry(workspaceId);
    const queued: QueuedUpdater = (view) => {
      const delta = updater(sectionOf(view, section));
      return delta && !isEmptyDelta(delta) ? sectionDelta(section, delta) : null;
    };
    if (!entry.hydrated) {
      entry.queued.push(queued);
      // A mutate-only caller (no mounted selector) would otherwise never hydrate, so the
      // change would never be sent. flush retains the workspace, hydrates, then drains.
      if (entry.refCount === 0) {
        this.flush(workspaceId).catch((error: unknown) => {
          console.warn("Failed to persist review state; it stays queued:", error);
        });
      }
      return;
    }
    const delta = queued(entry.view.sections);
    if (!delta) return;
    entry.pending.push(delta);
    this.recompute(entry);
    this.scheduleFlush(workspaceId, entry);
  }

  /**
   * Wait for hydration, then send every pending change. Rejects when a request fails or the
   * state could not be hydrated (queued changes are then still unsent).
   */
  async flush(workspaceId: string): Promise<void> {
    if (workspaceId.length === 0) return;
    await this.withRetained(workspaceId, async (entry) => {
      await entry.ready;
      if (!entry.hydrated) throw new Error("Review state flush failed: not hydrated");
      await this.drain(workspaceId, entry);
    });
  }

  /**
   * #4448 durability: flush, then confirm the server-acknowledged base holds every id.
   * Never rejects; a failed flush reports "not durable" so the caller fails closed.
   */
  async areReviewsDurable(workspaceId: string, reviewIds: readonly string[]): Promise<boolean> {
    try {
      await this.flush(workspaceId);
    } catch {
      return false;
    }
    const acknowledged = this.entries.get(workspaceId)?.base.reviews;
    return reviewIds.every((id) => acknowledged?.[id] != null);
  }

  /** Drop all local state for a deleted workspace (its session dir is gone on the backend). */
  removeWorkspace(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    this.stopSubscription(entry);
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.pending = [];
    entry.queued = [];
    this.entries.delete(workspaceId);
  }

  private getOrCreateEntry(workspaceId: string): Entry {
    const existing = this.entries.get(workspaceId);
    if (existing) return existing;
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const entry: Entry = {
      base: EMPTY_SECTIONS,
      pending: [],
      queued: [],
      isReady: false,
      hydrated: false,
      baseRevision: Number.NEGATIVE_INFINITY,
      ready,
      resolveReady,
      refCount: 0,
      view: LOADING_VIEW,
      listeners: new Set(),
      subscription: null,
      resubscribeTimer: null,
      resubscribeAttempt: 0,
      flushTimer: null,
      flushAttempt: 0,
      inFlight: null,
    };
    this.entries.set(workspaceId, entry);
    return entry;
  }

  /** Recompose the view only when base or pending changed, keeping snapshots stable. */
  private recompute(entry: Entry): void {
    const sections = entry.pending.reduce(applyReviewStateDelta, entry.base);
    entry.view = { sections, isReady: entry.isReady };
    for (const listener of entry.listeners) listener();
  }

  private setBase(entry: Entry, sections: ReviewStateSections): void {
    // Server snapshots arrive as fresh JSON; keep unchanged sections' identity so selector
    // consumers of other sections (e.g. the chat pane's review notes) do not re-render.
    const shared: ReviewStateSections = { ...sections };
    for (const section of REVIEW_STATE_SECTIONS) {
      const previous = entry.base[section];
      if (
        previous !== undefined &&
        sections[section] !== undefined &&
        JSON.stringify(previous) === JSON.stringify(sections[section])
      ) {
        assignSection(shared, section, previous);
      }
    }
    entry.base = shared;
    this.recompute(entry);
  }

  /** Unblock the UI (and `ready`) without replaying queued updaters. */
  private markReady(entry: Entry): void {
    if (entry.isReady) return;
    entry.isReady = true;
    this.recompute(entry);
    entry.resolveReady();
  }

  /** A real snapshot arrived: replay the queued updaters onto it, then unblock. */
  private markHydrated(workspaceId: string, entry: Entry): void {
    if (entry.hydrated) return;
    entry.hydrated = true;
    for (const queued of entry.queued) {
      const delta = queued(entry.pending.reduce(applyReviewStateDelta, entry.base));
      if (delta) entry.pending.push(delta);
    }
    entry.queued = [];
    this.recompute(entry);
    this.markReady(entry);
    if (entry.pending.length > 0) this.scheduleFlush(workspaceId, entry);
  }

  private ensureSubscribed(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    const client = this.client;
    if (!entry || !client || entry.subscription) return;
    if (entry.resubscribeTimer) {
      clearTimeout(entry.resubscribeTimer);
      entry.resubscribeTimer = null;
    }
    const controller = new AbortController();
    entry.subscription = controller;
    const { signal } = controller;

    const run = async () => {
      let iterator: AsyncIterator<unknown> | null = null;
      try {
        const events = await client.workspace.reviewState.subscribe({ workspaceId }, { signal });
        iterator = events;
        let first = true;
        for await (const event of events) {
          if (signal.aborted) break;
          entry.resubscribeAttempt = 0;
          if (first) {
            first = false;
            entry.baseRevision = event.revision;
            this.setBase(entry, event.snapshot.sections);
            await this.importLegacy(workspaceId, entry, client);
            this.markHydrated(workspaceId, entry);
          } else if (event.revision >= entry.baseRevision) {
            // Older pushes can trail a write reply that already moved base forward.
            entry.baseRevision = event.revision;
            this.setBase(entry, event.snapshot.sections);
          }
        }
      } catch (error) {
        if (!signal.aborted && !isAbortError(error)) {
          console.error("Failed to subscribe to review state:", error);
          // Self-heal: never hold the review pane (or a send) on a broken subscription. Queued
          // updaters stay queued until a resubscription delivers real data.
          this.markReady(entry);
        }
      } finally {
        if (entry.subscription === controller) entry.subscription = null;
        if (
          !signal.aborted &&
          this.client === client &&
          entry.refCount > 0 &&
          this.entries.get(workspaceId) === entry
        ) {
          const delay = retryDelayMs(entry.resubscribeAttempt++);
          entry.resubscribeTimer = setTimeout(() => {
            entry.resubscribeTimer = null;
            this.ensureSubscribed(workspaceId);
          }, delay);
        }
        try {
          // Close the iterator so the backend drops its listener.
          await iterator?.return?.();
        } catch {
          // Already closed.
        }
      }
    };
    run().catch((error: unknown) => console.error("Review state subscription failed:", error));
  }

  private stopSubscription(entry: Entry): void {
    entry.subscription?.abort();
    entry.subscription = null;
    if (entry.resubscribeTimer) {
      clearTimeout(entry.resubscribeTimer);
      entry.resubscribeTimer = null;
    }
  }

  /**
   * One-way migration of the legacy localStorage keys. Every legacy section is sent, even one
   * the backend already has, and the backend decides: it never overwrites its own entries,
   * adds the review notes it lacks, and leaves a present hunk-keyed section untouched.
   * localStorage is per origin (desktop app vs browser tab) while the backend is shared, and a
   * key that still exists means this origin was never imported (keys are removed on import),
   * so its notes are new data, not stale leftovers. A key is removed only after the server
   * reports its section (applied or present); on error it stays and the next hydration retries.
   */
  private async importLegacy(workspaceId: string, entry: Entry, client: APIClient): Promise<void> {
    const legacy = readLegacySections(workspaceId);
    if (legacy.length === 0) return;

    // Drop malformed legacy entries up front: one bad entry must not fail request validation
    // and pin the legacy key forever.
    const toImport = Object.fromEntries(legacy.map(({ section, value }) => [section, value]));
    const sections = sanitizeReviewStateSnapshot({ sections: toImport }).snapshot.sections;
    for (const { section } of legacy) {
      if (sections[section] === undefined) {
        // Unusable legacy value (wrong shape): nothing to migrate.
        updatePersistedState(LEGACY_SECTIONS[section].key(workspaceId), undefined);
      }
    }
    if (REVIEW_STATE_SECTIONS.every((section) => sections[section] === undefined)) return;

    try {
      const result = await client.workspace.reviewState.importLegacy({ workspaceId, sections });
      this.applyWriteReply(entry, result.snapshot.sections, result.revision);
      for (const section of REVIEW_STATE_SECTIONS) {
        if (result.results[section] !== undefined) {
          updatePersistedState(LEGACY_SECTIONS[section].key(workspaceId), undefined);
        }
      }
    } catch (error) {
      console.warn("Failed to import legacy review state; will retry on next load:", error);
    }
  }

  /**
   * Apply a write's reply. When base already holds a snapshot at or after that write's
   * revision (a subscription push overtook the reply), base already contains the write and is
   * newer than the reply, so keep it; otherwise the reply is the newest known state.
   */
  private applyWriteReply(entry: Entry, sections: ReviewStateSections, revision: number): void {
    if (entry.baseRevision >= revision) {
      this.recompute(entry);
      return;
    }
    entry.baseRevision = revision;
    this.setBase(entry, sections);
  }

  private scheduleFlush(workspaceId: string, entry: Entry): void {
    if (entry.flushTimer) return;
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null;
      this.flushInBackground(workspaceId);
    }, FLUSH_DEBOUNCE_MS);
  }

  private flushInBackground(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    if (!entry?.hydrated || entry.pending.length === 0) return;
    // Failures already scheduled a retry inside drain(); nothing else to do here.
    this.drain(workspaceId, entry).catch(() => undefined);
  }

  /** Send pending deltas, at most one request in flight per workspace. */
  private async drain(workspaceId: string, entry: Entry): Promise<void> {
    while (entry.pending.length > 0 && this.entries.get(workspaceId) === entry) {
      if (entry.inFlight) {
        await entry.inFlight;
        continue;
      }
      const client = this.client;
      if (!client) throw new Error("Review state flush failed: API not available");
      let settle: () => void = () => undefined;
      entry.inFlight = new Promise<void>((resolve) => {
        settle = resolve;
      });
      try {
        const batch = entry.pending.slice();
        const reply = await client.workspace.reviewState.update({
          workspaceId,
          delta: mergeReviewStateDeltas(batch),
        });
        entry.flushAttempt = 0;
        // Only local deltas are removed here and new ones are appended, so the sent ones
        // are exactly the first batch.length entries.
        entry.pending = entry.pending.slice(batch.length);
        this.applyWriteReply(entry, reply.sections, reply.revision);
      } catch (error) {
        // Keep pending (never silently drop a change) and retry with backoff.
        const delay = retryDelayMs(entry.flushAttempt++);
        if (entry.flushTimer) clearTimeout(entry.flushTimer);
        entry.flushTimer = setTimeout(() => {
          entry.flushTimer = null;
          this.flushInBackground(workspaceId);
        }, delay);
        throw error;
      } finally {
        entry.inFlight = null;
        settle();
      }
    }
  }
}

function sectionOf<S extends ReviewStateSection>(
  sections: ReviewStateSections,
  section: S
): ReviewStateSectionValue<S> {
  const value: ReviewStateSections[S] = sections[section];
  // An absent section reads as empty; `{}` is a valid (empty) record for every section.
  const empty: ReviewStateSectionValue<S> = {};
  return value ?? empty;
}

let storeInstance: ReviewStateStore | null = null;

export function getReviewStateStore(): ReviewStateStore {
  storeInstance ??= new ReviewStateStore();
  return storeInstance;
}

/**
 * Subscribe to one slice of a workspace's review state, so an unrelated change (e.g. marking a
 * hunk read) does not re-render every consumer: useSyncExternalStore skips the render when the
 * selected value is unchanged (Object.is). The selector must return a primitive or an object
 * already held by the view (sections keep their identity until they change).
 */
export function useReviewStateSelector<T>(
  workspaceId: string,
  selector: (view: ReviewStateView) => T
): T {
  const store = getReviewStateStore();
  return useSyncExternalStore(
    (listener) => store.subscribe(workspaceId, listener),
    () => selector(store.getView(workspaceId))
  );
}
