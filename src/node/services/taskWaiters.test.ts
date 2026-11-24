import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { log } from "@/node/services/log";

import {
  COMPLETED_REPORT_CACHE_MAX_ENTRIES,
  ForegroundWaitBackgroundedError,
  TaskWaiters,
  type CompletedAgentReportCacheEntry,
  type PendingTaskStartWaiter,
  type PendingTaskWaiter,
} from "@/node/services/taskWaiters";

function createHarness(options: { queued?: boolean } = {}) {
  const calls: string[] = [];
  const scheduleNotifyOnTerminalPersist = mock((taskId: string, owner: string | undefined) => {
    calls.push(`persist:${taskId}:${owner ?? "-"}`);
  });
  const hasQueuedMessages = mock(() => options.queued ?? false);
  const waiters = new TaskWaiters({ scheduleNotifyOnTerminalPersist, hasQueuedMessages });
  return { waiters, calls, scheduleNotifyOnTerminalPersist, hasQueuedMessages };
}

function createWaiter(
  taskId: string,
  calls: string[],
  options: { requestingWorkspaceId?: string; throwOnReject?: boolean } = {}
): PendingTaskWaiter {
  return {
    taskId,
    requestingWorkspaceId: options.requestingWorkspaceId,
    backgroundOnMessageQueued: options.requestingWorkspaceId != null,
    resolve: (report) => calls.push(`resolve:${taskId}:${report.reportMarkdown}`),
    reject: (error) => {
      calls.push(`reject:${taskId}:${error.name}`);
      if (options.throwOnReject) throw new Error("already settled");
    },
    cleanup: () => calls.push(`cleanup:${taskId}`),
  };
}

function cacheEntry(reportMarkdown: string): CompletedAgentReportCacheEntry {
  return { reportMarkdown, ancestorWorkspaceIds: [] };
}

describe("TaskWaiters", () => {
  const logError = spyOn(log, "error").mockImplementation(() => undefined);
  afterEach(() => logError.mockClear());
  afterAll(() => logError.mockRestore());

  test("foreground await counts nest and each release decrements once", () => {
    const { waiters } = createHarness();
    expect(waiters.isForegroundAwaiting("parent")).toBe(false);

    const releaseA = waiters.startForegroundAwait("parent");
    const releaseB = waiters.startForegroundAwait("parent");
    releaseA();
    expect(waiters.isForegroundAwaiting("parent")).toBe(true);
    releaseB();
    expect(waiters.isForegroundAwaiting("parent")).toBe(false);
    // A release past zero is an impossible state and must crash, not go negative.
    expect(() => releaseB()).toThrow();
  });

  test("backgrounding marks, schedules persistence, then rejects each registered waiter", () => {
    const { waiters, calls } = createHarness();
    const first = createWaiter("t1", calls, { requestingWorkspaceId: "parent" });
    // A waiter that already settled throws on reject: it is skipped and not counted.
    const settled = createWaiter("t2", calls, {
      requestingWorkspaceId: "parent",
      throwOnReject: true,
    });
    waiters.registerBackgroundableForegroundWaiter("parent", first);
    waiters.registerBackgroundableForegroundWaiter("parent", settled);

    expect(waiters.backgroundForegroundWaitsForWorkspace("parent")).toBe(1);
    expect(calls).toEqual([
      "persist:t1:parent",
      `reject:t1:${new ForegroundWaitBackgroundedError().name}`,
      "persist:t2:parent",
      `reject:t2:${new ForegroundWaitBackgroundedError().name}`,
    ]);
    expect(waiters.isTaskQueueBackgrounded("t1")).toBe(true);
    expect(waiters.isTaskQueueBackgrounded("t2")).toBe(true);
    expect(waiters.backgroundForegroundWaitsForWorkspace("other")).toBe(0);
  });

  test("backgrounding iterates a copy so waiters may unregister while being rejected", () => {
    const { waiters, calls } = createHarness();
    const register = (taskId: string) => {
      const waiter = createWaiter(taskId, calls, { requestingWorkspaceId: "parent" });
      waiter.reject = () => {
        calls.push(`reject:${taskId}`);
        waiters.unregisterBackgroundableForegroundWaiter("parent", waiter);
      };
      waiters.registerBackgroundableForegroundWaiter("parent", waiter);
    };
    register("t1");
    register("t2");

    expect(waiters.backgroundForegroundWaitsForWorkspace("parent")).toBe(2);
    expect(calls.filter((call) => call.startsWith("reject:"))).toEqual(["reject:t1", "reject:t2"]);
    expect(waiters.backgroundableForegroundWaitersByWorkspaceId.has("parent")).toBe(false);
    expect(waiters.backgroundForegroundWaitsForWorkspace("parent")).toBe(0);
  });

  test("backgroundForegroundWaitIfQueued only backgrounds when enabled, targeted and queued", () => {
    const queued = createHarness({ queued: true });
    queued.waiters.registerBackgroundableForegroundWaiter(
      "parent",
      createWaiter("t1", queued.calls, { requestingWorkspaceId: "parent" })
    );
    queued.waiters.backgroundForegroundWaitIfQueued(false, "parent");
    queued.waiters.backgroundForegroundWaitIfQueued(true, undefined);
    expect(queued.hasQueuedMessages).not.toHaveBeenCalled();
    expect(queued.waiters.isTaskQueueBackgrounded("t1")).toBe(false);

    queued.waiters.backgroundForegroundWaitIfQueued(true, "parent");
    expect(queued.hasQueuedMessages).toHaveBeenCalledWith("parent", "tool-end");
    expect(queued.waiters.isTaskQueueBackgrounded("t1")).toBe(true);

    const idle = createHarness({ queued: false });
    idle.waiters.registerBackgroundableForegroundWaiter(
      "parent",
      createWaiter("t1", idle.calls, { requestingWorkspaceId: "parent" })
    );
    idle.waiters.backgroundForegroundWaitIfQueued(true, "parent");
    expect(idle.scheduleNotifyOnTerminalPersist).not.toHaveBeenCalled();
  });

  test("resolvePendingWaiters drains once, cleaning up before resolving", () => {
    const { waiters, calls } = createHarness();
    const failing = createWaiter("t1", calls);
    failing.resolve = () => {
      throw new Error("resolve failed");
    };
    waiters.addPendingWaiter("t1", failing);
    waiters.addPendingWaiter("t1", createWaiter("t1", calls));
    expect(waiters.hasPendingWaiters("t1")).toBe(true);

    expect(waiters.resolvePendingWaiters("t1", { reportMarkdown: "done" })).toBe(true);
    // A throwing waiter does not stop the rest from resolving.
    expect(calls).toEqual(["cleanup:t1", "cleanup:t1", "resolve:t1:done"]);
    expect(waiters.hasPendingWaiters("t1")).toBe(false);
    expect(waiters.resolvePendingWaiters("t1", { reportMarkdown: "again" })).toBe(false);
  });

  test("a single pending waiter is resolved or rejected too", () => {
    const { waiters, calls } = createHarness();
    expect(waiters.hasPendingWaiters("t1")).toBe(false);
    waiters.addPendingWaiter("t1", createWaiter("t1", calls));
    expect(waiters.hasPendingWaiters("t1")).toBe(true);
    waiters.rejectWaiters("t1", new Error("stopped"));
    expect(calls).toEqual(["reject:t1:Error"]);

    expect(waiters.resolvePendingWaiters("t1", { reportMarkdown: "done" })).toBe(true);
    expect(calls).toEqual(["reject:t1:Error", "cleanup:t1", "resolve:t1:done"]);
  });

  test("unregistering the last backgroundable waiter drops the workspace entry", () => {
    const { waiters, calls } = createHarness();
    const a = createWaiter("t1", calls, { requestingWorkspaceId: "parent" });
    const b = createWaiter("t2", calls, { requestingWorkspaceId: "parent" });
    waiters.registerBackgroundableForegroundWaiter("parent", a);
    waiters.registerBackgroundableForegroundWaiter("parent", b);

    waiters.unregisterBackgroundableForegroundWaiter("parent", a);
    expect([...(waiters.backgroundableForegroundWaitersByWorkspaceId.get("parent") ?? [])]).toEqual(
      [b]
    );
    waiters.unregisterBackgroundableForegroundWaiter("parent", b);
    expect(waiters.backgroundableForegroundWaitersByWorkspaceId.has("parent")).toBe(false);
  });

  test("removePendingWaiter drops only that waiter", () => {
    const { waiters, calls } = createHarness();
    const a = createWaiter("t1", calls);
    const b = createWaiter("t1", calls);
    waiters.addPendingWaiter("t1", a);
    waiters.addPendingWaiter("t1", b);

    waiters.removePendingWaiter("t1", a);
    expect(waiters.pendingWaitersByTaskId.get("t1")).toEqual([b]);
    waiters.removePendingWaiter("t1", b);
    expect(waiters.pendingWaitersByTaskId.has("t1")).toBe(false);
    waiters.removePendingWaiter("t1", b);
    expect(waiters.pendingWaitersByTaskId.has("t1")).toBe(false);
  });

  test("rejectWaiters marks the task foreground-relevant and keeps waiters until they clean up", () => {
    const { waiters, calls } = createHarness();
    waiters.registerBackgroundableForegroundWaiter(
      "parent",
      createWaiter("t1", calls, { requestingWorkspaceId: "parent" })
    );
    waiters.backgroundForegroundWaitsForWorkspace("parent");
    expect(waiters.isTaskQueueBackgrounded("t1")).toBe(true);

    // No pending waiters: still clears the backgrounded mark.
    waiters.rejectWaiters("t1", new Error("stopped"));
    expect(waiters.isTaskQueueBackgrounded("t1")).toBe(false);

    calls.length = 0;
    const selfRemoving = createWaiter("t1", calls, { throwOnReject: true });
    selfRemoving.reject = (error) => {
      calls.push(`reject:self:${error.message}`);
      waiters.removePendingWaiter("t1", selfRemoving);
      throw new Error("late");
    };
    waiters.addPendingWaiter("t1", selfRemoving);
    waiters.addPendingWaiter("t1", createWaiter("t1", calls));

    waiters.rejectWaiters("t1", new Error("stopped"));
    expect(calls).toEqual(["reject:self:stopped", "reject:t1:Error"]);
    expect(logError).toHaveBeenCalledTimes(1);
    // The class never drops the entry itself: each waiter's cleanup does.
    expect(waiters.pendingWaitersByTaskId.get("t1")?.length).toBe(1);
  });

  test("start waiters run once, deleted before each start, and failures do not stop the rest", () => {
    const { waiters } = createHarness();
    const order: string[] = [];
    const add = (start: () => void) => {
      waiters.addPendingStartWaiter("t1", { start, cleanup: () => undefined });
    };
    add(() => {
      order.push(`a:${String(waiters.pendingStartWaitersByTaskId.has("t1"))}`);
      throw new Error("boom");
    });
    add(() => order.push("b"));

    waiters.startPendingStartWaiters("t1");
    waiters.startPendingStartWaiters("t1");
    expect(order).toEqual(["a:false", "b"]);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  test("removePendingStartWaiter drops only that waiter", () => {
    const { waiters } = createHarness();
    const a: PendingTaskStartWaiter = { start: () => undefined, cleanup: () => undefined };
    const b: PendingTaskStartWaiter = { start: () => undefined, cleanup: () => undefined };
    waiters.addPendingStartWaiter("t1", a);
    waiters.addPendingStartWaiter("t1", b);

    waiters.removePendingStartWaiter("t1", a);
    expect(waiters.pendingStartWaitersByTaskId.get("t1")).toEqual([b]);
    waiters.removePendingStartWaiter("t1", b);
    expect(waiters.pendingStartWaitersByTaskId.has("t1")).toBe(false);
    waiters.removePendingStartWaiter("t1", b);
    expect(waiters.pendingStartWaitersByTaskId.has("t1")).toBe(false);
  });

  test("armWaitersOfUnendedTask marks the task and starts its waiters", () => {
    const { waiters } = createHarness();
    const started: boolean[] = [];
    waiters.addPendingStartWaiter("t1", {
      start: () => started.push(waiters.isLaunchFailureUnpersisted("t1")),
      cleanup: () => undefined,
    });

    waiters.armWaitersOfUnendedTask("t1");
    // The mark is set before the waiters start, so a start observes it.
    expect(started).toEqual([true]);
    waiters.clearUnpersistedLaunchFailure("t1");
    expect(waiters.isLaunchFailureUnpersisted("t1")).toBe(false);
  });

  test("completed-report cache evicts the oldest entries past its bound", () => {
    const { waiters } = createHarness();
    for (let i = 0; i <= COMPLETED_REPORT_CACHE_MAX_ENTRIES; i++) {
      waiters.cacheCompletedReport(`t${i}`, cacheEntry(`r${i}`));
    }

    expect(waiters.completedReportsByTaskId.size).toBe(COMPLETED_REPORT_CACHE_MAX_ENTRIES);
    expect(waiters.hasCompletedReport("t0")).toBe(false);
    expect(waiters.getCompletedReport("t1")?.reportMarkdown).toBe("r1");
    expect(
      waiters.getCompletedReport(`t${COMPLETED_REPORT_CACHE_MAX_ENTRIES}`)?.reportMarkdown
    ).toBe(`r${COMPLETED_REPORT_CACHE_MAX_ENTRIES}`);

    waiters.deleteCompletedReport("t1");
    expect(waiters.hasCompletedReport("t1")).toBe(false);
  });
});
