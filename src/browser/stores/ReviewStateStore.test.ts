import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getReviewStateKey, getReviewsKey } from "@/common/constants/storage";
import type {
  ReviewStateDelta,
  ReviewStateEvent,
  ReviewStateSections,
} from "@/common/orpc/schemas/reviewState";
import { REVIEW_STATE_SECTIONS } from "@/common/orpc/schemas/reviewState";
import type { Review } from "@/common/types/review";
import { applyReviewStateDelta, withReviewStateSection } from "@/common/utils/reviewState";
import { installDom } from "../../../tests/ui/dom";
import { ReviewStateStore } from "./ReviewStateStore";

const WS = "ws-review-store";

function makeReview(id: string, status: Review["status"]): Review {
  return {
    id,
    data: { filePath: "a.ts", lineRange: "+1", selectedCode: "x", userNote: id },
    status,
    createdAt: 1,
  };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * In-memory stand-in for the backend reviewState API. It only stores and echoes (using the
 * shared merge helper); the queueing/layering/retry behavior under test lives in the store.
 */
function createBackend(initial: ReviewStateSections = {}) {
  let sections = initial;
  // Like the service: bumped on every persisted change, carried by pushes and replies.
  let revision = 1_000;
  const streams = new Set<(event: ReviewStateEvent) => void>();
  const backend = {
    updates: 0,
    importCalls: 0,
    inFlight: 0,
    maxInFlight: 0,
    failNextUpdate: false,
    failNextSubscribe: false,
    failImport: false,
    /** Events the store has finished handling (counted when it pulls the next one). */
    consumed: 0,
    lastImport: null as ReviewStateSections | null,
    /** When set, the initial snapshot waits for it (keeps the store un-hydrated). */
    hydrationGate: null as Promise<void> | null,
    updateGate: null as Promise<void> | null,
    /** When set, an update is persisted at once but its reply waits for it (a slow reply). */
    replyGate: null as Promise<void> | null,
    get sections() {
      return sections;
    },
    get openStreams() {
      return streams.size;
    },
    /** A write from another client: persisted and pushed to every subscriber. */
    externalWrite(delta: ReviewStateDelta) {
      sections = applyReviewStateDelta(sections, delta);
      revision++;
      for (const push of streams) push({ type: "snapshot", snapshot: { sections }, revision });
    },
  };
  const reviewState = {
    subscribe: async (_input: { workspaceId: string }, opts?: { signal?: AbortSignal }) => {
      await backend.hydrationGate;
      if (backend.failNextSubscribe) {
        backend.failNextSubscribe = false;
        throw new Error("subscribe failed");
      }
      const queue: ReviewStateEvent[] = [{ type: "snapshot", snapshot: { sections }, revision }];
      let wake: (() => void) | null = null;
      const push = (event: ReviewStateEvent) => {
        queue.push(event);
        wake?.();
      };
      streams.add(push);
      return (async function* () {
        try {
          while (!opts?.signal?.aborted) {
            const next = queue.shift();
            if (next) {
              yield next;
              backend.consumed++;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        } finally {
          streams.delete(push);
        }
      })();
    },
    update: async (input: { workspaceId: string; delta: ReviewStateDelta }) => {
      backend.updates++;
      backend.inFlight++;
      backend.maxInFlight = Math.max(backend.maxInFlight, backend.inFlight);
      try {
        await backend.updateGate;
        if (backend.failNextUpdate) {
          backend.failNextUpdate = false;
          throw new Error("update failed");
        }
        sections = applyReviewStateDelta(sections, input.delta);
        const reply = { sections, revision: ++revision };
        await backend.replyGate;
        return reply;
      } finally {
        backend.inFlight--;
      }
    },
    importLegacy: (input: { workspaceId: string; sections: ReviewStateSections }) => {
      backend.importCalls++;
      backend.lastImport = input.sections;
      if (backend.failImport) return Promise.reject(new Error("import failed"));
      const results: Record<string, "applied" | "present"> = {};
      for (const section of REVIEW_STATE_SECTIONS) {
        const incoming = input.sections[section];
        if (incoming === undefined) continue;
        if (sections[section] !== undefined) {
          results[section] = "present";
        } else {
          sections = withReviewStateSection(sections, section, incoming);
          results[section] = "applied";
        }
      }
      // Present sections are only reported: what the service merges is its own contract.
      if (Object.values(results).includes("applied")) revision++;
      return Promise.resolve({ snapshot: { sections }, revision, results });
    },
  };
  const client = createTestApiClient({ workspace: { reviewState } });
  return { backend, client };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let cleanupDom: (() => void) | undefined;
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  cleanupDom?.();
});

function connect(client: APIClient) {
  const store = new ReviewStateStore();
  store.setClient(client);
  unsubscribe = store.subscribe(WS, () => undefined);
  return store;
}

describe("ReviewStateStore", () => {
  test("replays pre-hydration updaters onto the server data instead of overwriting it", async () => {
    const { backend, client } = createBackend({
      reviews: { r1: makeReview("r1", "attached"), r2: makeReview("r2", "pending") },
    });
    const gate = deferred();
    backend.hydrationGate = gate.promise;
    const store = connect(client);

    // Issued before the server data arrived; the updater depends on that data.
    store.mutate(WS, "reviews", (prev) => ({
      set: Object.fromEntries(
        Object.values(prev)
          .filter((review) => review.status === "attached")
          .map((review) => [review.id, { ...review, status: "checked" as const }])
      ),
    }));
    expect(store.isReady(WS)).toBe(false);

    gate.resolve();
    await store.flush(WS);

    expect(backend.sections.reviews).toEqual({
      r1: makeReview("r1", "checked"),
      r2: makeReview("r2", "pending"),
    });
    expect(store.getView(WS).sections.reviews).toEqual(backend.sections.reviews);
  });

  test("keeps unsent local changes layered over a newer server snapshot", async () => {
    const { backend, client } = createBackend();
    const store = connect(client);
    await store.whenReady(WS);

    store.mutate(WS, "hunkExpand", () => ({ set: { local: true } }));
    backend.externalWrite({ hunkExpand: { set: { remote: false } } });
    await waitUntil(() => store.getView(WS).sections.hunkExpand?.remote === false);

    expect(store.getView(WS).sections.hunkExpand).toEqual({ remote: false, local: true });
    await store.flush(WS);
    expect(backend.sections.hunkExpand).toEqual({ remote: false, local: true });
  });

  test("a failed flush keeps the change and retries it", async () => {
    const { backend, client } = createBackend();
    const store = connect(client);
    await store.whenReady(WS);

    backend.failNextUpdate = true;
    store.mutate(WS, "hunkExpand", () => ({ set: { h1: true } }));
    let flushError: unknown = null;
    await store.flush(WS).catch((error: unknown) => {
      flushError = error;
    });

    expect(flushError).not.toBeNull();
    expect(store.getView(WS).sections.hunkExpand).toEqual({ h1: true });
    // The backoff retry sends it without any further user action.
    await waitUntil(() => backend.sections.hunkExpand?.h1 === true);
    expect(backend.updates).toBe(2);
  });

  test("sends at most one update at a time and delivers every change", async () => {
    const { backend, client } = createBackend();
    const store = connect(client);
    await store.whenReady(WS);

    const gate = deferred();
    backend.updateGate = gate.promise;
    store.mutate(WS, "hunkExpand", () => ({ set: { a: true } }));
    const first = store.flush(WS);
    await waitUntil(() => backend.inFlight === 1);
    store.mutate(WS, "hunkExpand", () => ({ delete: ["a"], set: { b: true } }));
    const second = store.flush(WS);
    gate.resolve();
    await Promise.all([first, second]);

    expect(backend.maxInFlight).toBe(1);
    expect(backend.sections.hunkExpand).toEqual({ b: true });
  });

  test("a slow update reply does not roll back a newer server push", async () => {
    const { backend, client } = createBackend();
    const store = connect(client);
    await store.whenReady(WS);

    const reply = deferred();
    backend.replyGate = reply.promise;
    store.mutate(WS, "hunkExpand", () => ({ set: { h1: true } }));
    const flushed = store.flush(WS);
    await waitUntil(() => backend.sections.hunkExpand?.h1 === true);
    // Another renderer changes the SAME entry after our update was persisted but before its
    // reply arrives; the push reaches the store first.
    const consumed = backend.consumed;
    backend.externalWrite({ hunkExpand: { set: { h1: false } } });
    await waitUntil(() => backend.consumed > consumed);

    reply.resolve();
    await flushed;
    expect(store.getView(WS).sections.hunkExpand).toEqual({ h1: false });
  });

  test("a failed first subscription unblocks the UI but replays queued updaters only onto real data", async () => {
    const { backend, client } = createBackend({
      reviews: { r1: makeReview("r1", "attached"), r2: makeReview("r2", "pending") },
    });
    backend.failNextSubscribe = true;
    const store = connect(client);
    store.mutate(WS, "reviews", (prev) => ({
      set: Object.fromEntries(
        Object.values(prev)
          .filter((review) => review.status === "attached")
          .map((review) => [review.id, { ...review, status: "checked" as const }])
      ),
    }));

    await store.whenReady(WS);
    expect(store.isReady(WS)).toBe(true);
    // Nothing was hydrated, so nothing may be reported as persisted.
    expect(await store.areReviewsDurable(WS, [])).toBe(false);

    // The mounted selector resubscribes; the queued updater then runs against the real reviews.
    await waitUntil(() => backend.sections.reviews?.r1?.status === "checked");
    expect(backend.sections.reviews?.r2?.status).toBe("pending");
  });

  test("imperative whenReady and flush hydrate a workspace with no mounted selector", async () => {
    const { backend, client } = createBackend({ hunkExpand: { h0: true } });
    const store = new ReviewStateStore();
    store.setClient(client);
    store.mutate(WS, "hunkExpand", () => ({ set: { h1: true } }));

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("flush never settled")), 2_000)
    );
    await Promise.race([store.flush(WS), timeout]);

    expect(backend.sections.hunkExpand).toEqual({ h0: true, h1: true });
    // The temporary subscription is released once the operation settled.
    expect(backend.openStreams).toBe(0);
  });

  test("a change made with no mounted selector and no flush call is still persisted", async () => {
    const { backend, client } = createBackend();
    const store = new ReviewStateStore();
    store.setClient(client);

    store.mutate(WS, "hunkExpand", () => ({ set: { h1: true } }));

    await waitUntil(() => backend.sections.hunkExpand?.h1 === true);
    await waitUntil(() => backend.openStreams === 0);
  });

  test("hydrates and persists changes when localStorage cannot be read", async () => {
    const { backend, client } = createBackend({ hunkExpand: { h0: true } });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage access denied");
      },
    });
    const store = connect(client);
    store.mutate(WS, "hunkExpand", () => ({ set: { h1: true } }));

    await store.flush(WS);
    expect(backend.sections.hunkExpand).toEqual({ h0: true, h1: true });
  });

  test("reports restored notes durable only once the backend acknowledged them (#4448)", async () => {
    const { backend, client } = createBackend();
    const store = connect(client);
    await store.whenReady(WS);

    backend.failNextUpdate = true;
    store.mutate(WS, "reviews", () => ({ set: { r1: makeReview("r1", "attached") } }));
    // The local view already shows the note, but the backend never stored it: fail closed so
    // the composer keeps the held copy instead of acking a note that could be lost.
    expect(store.getView(WS).sections.reviews?.r1).toBeDefined();
    expect(await store.areReviewsDurable(WS, ["r1"])).toBe(false);

    expect(await store.areReviewsDurable(WS, ["r1"])).toBe(true);
    expect(await store.areReviewsDurable(WS, ["r1", "never-written"])).toBe(false);
  });
});

describe("ReviewStateStore legacy localStorage migration", () => {
  test("sends a legacy section the backend already has (another origin's data), then removes the key", async () => {
    const { backend, client } = createBackend({ reviews: {} });
    const legacyReviews = { other: makeReview("other", "attached") };
    updatePersistedState(getReviewsKey(WS), {
      workspaceId: WS,
      reviews: legacyReviews,
      lastUpdated: 1,
    });

    const store = connect(client);
    await store.whenReady(WS);

    // The backend merges the entries it lacks; the client must not drop them unsent.
    expect(backend.lastImport?.reviews).toEqual(legacyReviews);
    expect(readPersistedState(getReviewsKey(WS), null)).toBeNull();
  });

  test("imports a legacy section the backend never wrote, then removes the key", async () => {
    const { backend, client } = createBackend();
    const readState = { h1: { hunkId: "h1", isRead: true, timestamp: 5 } };
    updatePersistedState(getReviewStateKey(WS), { workspaceId: WS, readState, lastUpdated: 1 });

    const store = connect(client);
    await store.whenReady(WS);

    expect(backend.sections.readState).toEqual(readState);
    expect(store.getView(WS).sections.readState).toEqual(readState);
    expect(readPersistedState(getReviewStateKey(WS), null)).toBeNull();
  });

  test("removes an unparseable legacy key instead of retrying it forever", async () => {
    const { backend, client } = createBackend();
    window.localStorage.setItem(getReviewsKey(WS), "{not json");

    const store = connect(client);
    await store.whenReady(WS);

    expect(backend.importCalls).toBe(0);
    expect(window.localStorage.getItem(getReviewsKey(WS))).toBeNull();
  });

  test("keeps the legacy key when the import fails", async () => {
    const { backend, client } = createBackend();
    backend.failImport = true;
    const legacy = {
      workspaceId: WS,
      readState: { h1: { hunkId: "h1", isRead: true, timestamp: 5 } },
      lastUpdated: 1,
    };
    updatePersistedState(getReviewStateKey(WS), legacy);

    const store = connect(client);
    await store.whenReady(WS);

    expect(backend.importCalls).toBe(1);
    expect(readPersistedState<unknown>(getReviewStateKey(WS), null)).toEqual(legacy);
  });
});
