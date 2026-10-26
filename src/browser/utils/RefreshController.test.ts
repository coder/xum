import { afterEach, beforeEach, describe, it, expect, mock, vi } from "bun:test";

import { advanceClock, fakeTimers } from "@/browser/testFakeClock";
import { RefreshController } from "./RefreshController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

// The controller runs on timers (debounce, cooldown) and a promise pipeline: a fake clock makes
// every wait exact.
describe("RefreshController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedule() rate-limits and does not reset to the last call", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 200 });

    controller.schedule();
    await advanceClock(100);
    controller.schedule();

    // After 230ms total: >200ms since the first call, but only 130ms since the second call.
    // If schedule() reset the timer, we would not have refreshed yet.
    await advanceClock(130);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Ensure the second call didn't schedule another refresh.
    await advanceClock(250);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(fakeTimers.getTimerCount()).toBe(0);

    controller.dispose();
  });

  it("schedule() coalesces many calls into a single refresh", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.schedule();
    controller.schedule();
    controller.schedule();

    expect(onRefresh).not.toHaveBeenCalled();

    await advanceClock(80);

    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("requestImmediate() triggers immediately and clears a pending debounce", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 60 });

    controller.schedule();
    expect(onRefresh).not.toHaveBeenCalled();

    controller.requestImmediate();
    await advanceClock(10);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Original timer should be cleared.
    expect(fakeTimers.getTimerCount()).toBe(0);
    await advanceClock(120);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("requestImmediate() during an in-flight refresh queues exactly one follow-up", async () => {
    const refreshes: Array<ReturnType<typeof deferred<void>>> = [];
    const onRefresh = mock(() => {
      const d = deferred<void>();
      refreshes.push(d);
      return d.promise;
    });

    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.requestImmediate();
    // Wait for the promise pipeline to invoke onRefresh
    await advanceClock(10);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(controller.isRefreshing).toBe(true);

    // Multiple immediate requests while in-flight should coalesce into a single follow-up.
    controller.requestImmediate();
    controller.requestImmediate();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    expect(refreshes).toHaveLength(1);
    refreshes[0].resolve();

    // Allow the success handler + the queued trailing debounce refresh.
    await advanceClock(80);

    expect(onRefresh).toHaveBeenCalledTimes(2);

    expect(refreshes).toHaveLength(2);
    refreshes[1].resolve();
    await advanceClock(10);

    expect(controller.isRefreshing).toBe(false);

    controller.dispose();
  });

  it("isRefreshing reflects in-flight state", async () => {
    const refresh = deferred<void>();

    const onRefresh = mock(() => refresh.promise);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    expect(controller.isRefreshing).toBe(false);

    controller.requestImmediate();
    // inFlight is set synchronously before the promise pipeline runs
    expect(controller.isRefreshing).toBe(true);

    refresh.resolve();
    await advanceClock(10);

    expect(controller.isRefreshing).toBe(false);

    controller.dispose();
  });

  it("dispose() cancels a pending debounce timer", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.schedule();
    expect(fakeTimers.getTimerCount()).toBe(1);
    controller.dispose();
    expect(fakeTimers.getTimerCount()).toBe(0);

    await advanceClock(80);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not refresh after dispose", async () => {
    const onRefresh = mock<() => void>(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.dispose();
    controller.schedule();
    controller.requestImmediate();
    expect(fakeTimers.getTimerCount()).toBe(0);

    await advanceClock(80);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("recovers if onRefresh throws synchronously", async () => {
    let shouldThrow = true;
    const onRefresh = mock(() => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("boom");
      }
    });
    const onComplete = mock<(info: { timestamp: number; trigger: string }) => void>(
      () => undefined
    );
    const onError = mock<
      (info: { timestamp: number; trigger: string; errorMessage: string }) => void
    >(() => undefined);

    const controller = new RefreshController({
      onRefresh,
      onRefreshComplete: onComplete,
      onRefreshError: onError,
      debounceMs: 20,
    });

    // First call throws — controller must still clear inFlight
    controller.requestImmediate();
    await advanceClock(10);
    expect(controller.isRefreshing).toBe(false);
    expect(controller.lastRefreshInfo).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].errorMessage).toBe("boom");

    // Second call succeeds — must not be blocked by stale inFlight
    controller.requestImmediate();
    await advanceClock(10);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(1);

    expect(onError).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("recovers if async onRefresh rejects", async () => {
    const refresh = deferred<void>();
    const onRefresh = mock(() => refresh.promise);
    const onComplete = mock<(info: { timestamp: number; trigger: string }) => void>(
      () => undefined
    );
    const onError = mock<
      (info: { timestamp: number; trigger: string; errorMessage: string }) => void
    >(() => undefined);

    const controller = new RefreshController({
      onRefresh,
      onRefreshComplete: onComplete,
      onRefreshError: onError,
      debounceMs: 20,
    });

    controller.requestImmediate();
    expect(controller.isRefreshing).toBe(true);

    refresh.reject(new Error("async boom"));
    await advanceClock(10);

    expect(controller.isRefreshing).toBe(false);
    expect(controller.lastRefreshInfo).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].errorMessage).toBe("async boom");

    controller.dispose();
  });

  it("onRefreshComplete callback throw does not wedge controller", async () => {
    const onRefresh = vi.fn(() => undefined);
    const onRefreshComplete = vi.fn(() => {
      throw new Error("callback boom");
    });

    const controller = new RefreshController({
      onRefresh,
      onRefreshComplete,
      debounceMs: 20,
    });

    controller.requestImmediate();
    await advanceClock(10);

    expect(controller.isRefreshing).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefreshComplete).toHaveBeenCalledTimes(1);

    controller.requestImmediate();
    await advanceClock(10);

    expect(controller.isRefreshing).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onRefreshComplete).toHaveBeenCalledTimes(2);

    controller.dispose();
  });

  it("onRefreshError callback throw does not wedge controller", async () => {
    const onRefresh = vi.fn(() => {
      throw new Error("refresh fail");
    });
    const onRefreshError = vi.fn(() => {
      throw new Error("callback boom");
    });

    const controller = new RefreshController({
      onRefresh,
      onRefreshError,
      debounceMs: 20,
    });

    controller.requestImmediate();
    await advanceClock(10);

    expect(controller.isRefreshing).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefreshError).toHaveBeenCalledTimes(1);

    controller.requestImmediate();
    await advanceClock(10);

    expect(controller.isRefreshing).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onRefreshError).toHaveBeenCalledTimes(2);

    controller.dispose();
  });

  it("does not run deferred onRefresh after immediate dispose", async () => {
    const onRefresh = vi.fn(() => undefined);
    const controller = new RefreshController({ onRefresh, debounceMs: 20 });

    controller.requestImmediate();
    controller.dispose();
    await advanceClock(10);

    // onRefresh should never have been called — dispose fenced the deferred pipeline.
    expect(onRefresh).toHaveBeenCalledTimes(0);
    expect(controller.isRefreshing).toBe(false);
  });

  it("does not fire onRefreshComplete when disposed during in-flight async refresh", async () => {
    const d = deferred<void>();
    const onRefresh = vi.fn(() => d.promise);
    const onRefreshComplete = vi.fn(() => undefined);

    const controller = new RefreshController({
      onRefresh,
      onRefreshComplete,
      debounceMs: 20,
    });

    controller.requestImmediate();
    await advanceClock(10);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(controller.isRefreshing).toBe(true);

    // Dispose while the async onRefresh is still in-flight.
    controller.dispose();
    expect(controller.isRefreshing).toBe(false);

    // Let the deferred promise resolve — callbacks should be suppressed.
    d.resolve();
    await advanceClock(10);

    expect(onRefreshComplete).toHaveBeenCalledTimes(0);
  });

  it("does not fire onRefreshError when disposed during in-flight async refresh failure", async () => {
    const d = deferred<void>();
    const onRefresh = vi.fn(() => d.promise);
    const onRefreshError = vi.fn(() => undefined);

    const controller = new RefreshController({
      onRefresh,
      onRefreshError,
      debounceMs: 20,
    });

    controller.requestImmediate();
    await advanceClock(10);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    controller.dispose();

    d.reject(new Error("too late"));
    await advanceClock(10);

    expect(onRefreshError).toHaveBeenCalledTimes(0);
    expect(controller.isRefreshing).toBe(false);
  });
});
