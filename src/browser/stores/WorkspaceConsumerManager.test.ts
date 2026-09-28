import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import type { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import type { ChatStats } from "@/common/types/chatStats";
import { createMuxMessage } from "@/common/types/message";
import { WorkspaceConsumerManager } from "./WorkspaceConsumerManager";
import { createTestApiClient } from "@/browser/testUtils";

const STATS: ChatStats = {
  consumers: [{ name: "User", tokens: 5, percentage: 100 }],
  totalTokens: 5,
  model: "gpt-4",
  tokenizerName: "cl100k",
  usageHistory: [],
};

// bun-types (^1.2.23) lags the pinned runtime (bun@1.3.12), which implements this.
const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };

// The manager treats a calculation as slow after this long (WorkspaceConsumerManager.ts).
const SLOW_CALCULATION_MS = 60_000;
const DEBOUNCE_MS = 150;

type DeferredStats = ReturnType<typeof Promise.withResolvers<ChatStats>>;

function statsWithTotal(totalTokens: number): ChatStats {
  return {
    ...STATS,
    consumers: [{ name: "User", tokens: totalTokens, percentage: 100 }],
    totalTokens,
  };
}

function toCachedState(stats: ChatStats) {
  return {
    consumers: stats.consumers,
    tokenizerName: stats.tokenizerName,
    totalTokens: stats.totalTokens,
    isCalculating: false,
    topFilePaths: stats.topFilePaths,
  };
}

const EMPTY_STATE = { consumers: [], tokenizerName: "", totalTokens: 0, isCalculating: false };

// Under fake timers the setTimeout-based waitForCalculation never advances, so settle
// promise chains (RPC client wrappers, async handlers, queueMicrotask notifications) instead.
async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function createAggregator(messageCount: number): StreamingMessageAggregator {
  const messages = Array.from({ length: messageCount }, (_, i) =>
    createMuxMessage(`msg-${i}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(2_000), {
      historySequence: i + 1,
    })
  );
  return {
    getAllMessages: () => messages,
    getCurrentModel: () => "gpt-4",
  } as unknown as StreamingMessageAggregator;
}

function waitForCalculation(manager: WorkspaceConsumerManager, workspaceId: string) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const poll = () => {
      if (manager.getCachedState(workspaceId)) return resolve();
      if (Date.now() > deadline) return reject(new Error("calculation did not complete"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe("WorkspaceConsumerManager", () => {
  let cleanupDom: (() => void) | null = null;
  let calculateStats: ReturnType<typeof mock<(input: unknown) => Promise<ChatStats>>>;
  let onCalculationComplete: ReturnType<typeof mock<(workspaceId: string) => void>>;
  let manager: WorkspaceConsumerManager;

  beforeEach(() => {
    cleanupDom = installDom();
    calculateStats = mock((_input: unknown) => Promise.resolve(STATS));
    window.__ORPC_CLIENT__ = createTestApiClient({
      tokenizer: { calculateStats },
    });
    onCalculationComplete = mock((_workspaceId: string) => undefined);
    manager = new WorkspaceConsumerManager(onCalculationComplete, () => 1);
  });

  afterEach(() => {
    manager.dispose();
    delete window.__ORPC_CLIENT__;
    cleanupDom?.();
    cleanupDom = null;
  });

  test("asks the backend for stats by workspaceId instead of uploading the message history", async () => {
    const aggregator = createAggregator(200);

    // Simulate a burst of tool-call-end events during one stream; only the
    // debounced trailing request should reach the backend.
    manager.scheduleCalculation("ws-1", aggregator);
    manager.scheduleCalculation("ws-1", aggregator);
    manager.scheduleCalculation("ws-1", aggregator);
    await waitForCalculation(manager, "ws-1");

    expect(calculateStats).toHaveBeenCalledTimes(1);
    // Regression guard for the ~36 KB/s upstream leak: only identifiers cross the wire,
    // regardless of how large the renderer's copy of the transcript is.
    expect(calculateStats.mock.calls[0][0]).toEqual({ workspaceId: "ws-1", model: "gpt-4" });

    expect(manager.getCachedState("ws-1")).toEqual({
      consumers: STATS.consumers,
      tokenizerName: STATS.tokenizerName,
      totalTokens: STATS.totalTokens,
      isCalculating: false,
      topFilePaths: undefined,
    });
  });

  // #4815: the backend keeps computing (and persists the result) after the renderer's
  // slow-calculation point, so the renderer must keep waiting and show the late result.
  describe("calculations slower than the warning threshold", () => {
    let requests: Array<{ workspaceId: string; deferred: DeferredStats }>;

    beforeEach(() => {
      fakeTimers.useFakeTimers();
      requests = [];
      calculateStats.mockImplementation((input: unknown) => {
        const deferred = Promise.withResolvers<ChatStats>();
        requests.push({ workspaceId: (input as { workspaceId: string }).workspaceId, deferred });
        return deferred.promise;
      });
      spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
      fakeTimers.useRealTimers();
      mock.restore();
    });

    async function startCalculation(workspaceId: string) {
      manager.scheduleCalculation(workspaceId, createAggregator(2));
      fakeTimers.advanceTimersByTime(DEBOUNCE_MS);
      await flushMicrotasks();
    }

    async function passSlowThreshold() {
      fakeTimers.advanceTimersByTime(SLOW_CALCULATION_MS + 1);
      await flushMicrotasks();
    }

    test("keeps calculating past the threshold and shows the late result", async () => {
      await startCalculation("ws-1");
      await passSlowThreshold();

      expect(manager.getCachedState("ws-1")).toBeNull();
      expect(manager.isPending("ws-1")).toBe(true);
      expect(manager.getStateSync("ws-1").isCalculating).toBe(true);

      onCalculationComplete.mockClear();
      requests[0].deferred.resolve(STATS);
      await flushMicrotasks();

      expect(manager.getCachedState("ws-1")).toEqual(toCachedState(STATS));
      expect(manager.isPending("ws-1")).toBe(false);
      expect(onCalculationComplete).toHaveBeenCalledWith("ws-1");
    });

    test("ignores a superseded late result after the workspace was removed and recalculated", async () => {
      const oldStats = statsWithTotal(1);
      const newStats = statsWithTotal(2);

      await startCalculation("ws-1");
      manager.removeWorkspace("ws-1");
      await startCalculation("ws-1");
      expect(calculateStats).toHaveBeenCalledTimes(2);

      // The first run's threshold passes while the second run is still in flight.
      await passSlowThreshold();
      expect(manager.getCachedState("ws-1")).toBeNull();
      expect(manager.getStateSync("ws-1").isCalculating).toBe(true);

      requests[0].deferred.resolve(oldStats);
      await flushMicrotasks();
      expect(manager.getCachedState("ws-1")).toBeNull();
      expect(manager.getStateSync("ws-1").isCalculating).toBe(true);

      requests[1].deferred.resolve(newStats);
      await flushMicrotasks();
      expect(manager.getCachedState("ws-1")).toEqual(toCachedState(newStats));
    });

    // bun's runner fails the test if the rejection goes unhandled, so no listener is needed.
    test("a late failure ends the calculation with the empty state", async () => {
      const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
      await startCalculation("ws-1");
      await passSlowThreshold();
      expect(manager.getStateSync("ws-1").isCalculating).toBe(true);
      expect(consoleError).not.toHaveBeenCalled();

      const error = new Error("boom");
      requests[0].deferred.reject(error);
      await flushMicrotasks();

      expect(manager.isPending("ws-1")).toBe(false);
      expect(manager.getCachedState("ws-1")).toEqual(EMPTY_STATE);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]).toContain(error);
    });

    // A request can stay in flight indefinitely, so it must not repopulate a deleted workspace.
    test.each([
      ["result", (deferred: DeferredStats) => deferred.resolve(STATS)],
      ["failure", (deferred: DeferredStats) => deferred.reject(new Error("boom"))],
    ])("drops a late %s after the workspace was removed", async (_outcome, settle) => {
      spyOn(console, "error").mockImplementation(() => undefined);
      await startCalculation("ws-1");
      manager.removeWorkspace("ws-1");
      onCalculationComplete.mockClear();

      settle(requests[0].deferred);
      await flushMicrotasks();

      expect(manager.getCachedState("ws-1")).toBeNull();
      expect(onCalculationComplete).not.toHaveBeenCalled();
    });

    test("applies a late result to its own workspace after switching to another one", async () => {
      const statsA = statsWithTotal(10);
      const statsB = statsWithTotal(20);

      await startCalculation("ws-1");
      await passSlowThreshold();

      await startCalculation("ws-2");
      expect(requests.map((request) => request.workspaceId)).toEqual(["ws-1", "ws-2"]);
      requests[1].deferred.resolve(statsB);
      await flushMicrotasks();

      onCalculationComplete.mockClear();
      requests[0].deferred.resolve(statsA);
      await flushMicrotasks();

      expect(manager.getCachedState("ws-1")).toEqual(toCachedState(statsA));
      expect(manager.getCachedState("ws-2")).toEqual(toCachedState(statsB));
      expect(onCalculationComplete.mock.calls).toEqual([["ws-1"]]);
    });
  });
});
