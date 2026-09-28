import { describe, expect, test } from "bun:test";
import { BackgroundBashStore } from "./BackgroundBashStore";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import { createTestApiClient } from "@/browser/testUtils";

interface BashSubscriptionState {
  processes: BackgroundProcessInfo[];
  foregroundToolCallIds: string[];
}

const RUNNING_PROCESS: BackgroundProcessInfo = {
  id: "proc-1",
  pid: 4242,
  script: "bun run dev",
  displayName: "Dev Server",
  startTime: 1_000,
  status: "running",
};

/**
 * A push-controlled stand-in for the oRPC backgroundBashes.subscribe iterator
 * so tests can deliver snapshots deterministically.
 */
function createControlledBashClient() {
  let push: ((state: BashSubscriptionState) => void) | null = null;
  const pending: BashSubscriptionState[] = [];

  const iterator: AsyncIterableIterator<BashSubscriptionState> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next(): Promise<IteratorResult<BashSubscriptionState>> {
      const queued = pending.shift();
      if (queued) {
        return Promise.resolve({ value: queued, done: false });
      }
      return new Promise((resolve) => {
        push = (state) => {
          push = null;
          resolve({ value: state, done: false });
        };
      });
    },
    return(): Promise<IteratorResult<BashSubscriptionState>> {
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  const client = createTestApiClient({
    workspace: {
      backgroundBashes: {
        subscribe: () => Promise.resolve(iterator),
      },
    },
  });

  return {
    client,
    pushState: (state: BashSubscriptionState): void => {
      if (push) {
        push(state);
      } else {
        pending.push(state);
      }
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("BackgroundBashStore state-known signal", () => {
  test("unknown until the first snapshot; known and cached after, even across unsubscribe", async () => {
    const { client, pushState } = createControlledBashClient();
    const store = new BackgroundBashStore();
    store.setClient(client);

    // Before any subscriber the state is simply unknown.
    expect(store.isStateKnown("ws-1")).toBe(false);

    let notifications = 0;
    const unsubscribe = store.subscribeStateKnown("ws-1", () => {
      notifications++;
    });

    // Subscribing starts the backend subscription but the state stays unknown
    // until the first snapshot actually arrives — "unknown is not empty".
    expect(store.isStateKnown("ws-1")).toBe(false);
    expect(store.getProcesses("ws-1")).toEqual([]);

    pushState({ processes: [RUNNING_PROCESS], foregroundToolCallIds: [] });
    await waitUntil(() => store.isStateKnown("ws-1"));
    expect(notifications).toBeGreaterThan(0);
    // The known-flip must observe fully applied caches.
    expect(store.getProcesses("ws-1")).toEqual([RUNNING_PROCESS]);

    // Last-known state survives unsubscribe so revisiting a workspace renders
    // synchronously instead of re-learning the state after first paint.
    unsubscribe();
    expect(store.isStateKnown("ws-1")).toBe(true);
    expect(store.getProcesses("ws-1")).toEqual([RUNNING_PROCESS]);
  });

  test("a failing subscription self-heals to known so it cannot block first paint", async () => {
    const store = new BackgroundBashStore();
    store.setClient(
      createTestApiClient({
        workspace: {
          backgroundBashes: {
            subscribe: () => Promise.reject(new Error("backend down")),
          },
        },
      })
    );

    // The retrying self-heal path should be cleaned up like a real component
    // unmount; otherwise the test leaves a retry timer logging failures into
    // unrelated files for the rest of the unit suite.
    const unsubscribe = store.subscribeStateKnown("ws-1", () => undefined);
    try {
      await waitUntil(() => store.isStateKnown("ws-1"));
      expect(store.getProcesses("ws-1")).toEqual([]);
    } finally {
      unsubscribe();
      store.setClient(null);
    }
  });
});
