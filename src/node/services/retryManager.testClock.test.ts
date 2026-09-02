import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Duration } from "effect";
import { calculateBackoffDelay } from "@/common/utils/messages/retryState";
import { makeTestEffectRunner, type TestEffectRunner } from "./di/testEffectRunner";
import { RetryManager, type RetryStatusEvent } from "./retryManager";

/**
 * Backoff timing on virtual time (the real-timer suite in
 * `retryManager.test.ts` keeps covering the default runner, which today's
 * streamManager call site still uses).
 */
describe("RetryManager on a TestClock", () => {
  let clock: TestEffectRunner;
  let manager: RetryManager;
  let onRetry: ReturnType<typeof mock<() => Promise<void>>>;
  let events: RetryStatusEvent[];

  beforeEach(() => {
    clock = makeTestEffectRunner();
    onRetry = mock(() => Promise.resolve());
    events = [];
    manager = new RetryManager(
      "workspace-1",
      onRetry,
      (event) => {
        events.push(event);
      },
      clock.runner
    );
  });

  afterEach(async () => {
    manager.dispose();
    await clock.dispose();
  });

  it("fires exactly at the backoff delay", async () => {
    manager.handleStreamFailure({ type: "unknown", message: "transient" });
    const delayMs = calculateBackoffDelay(1);
    expect(events.map((event) => event.type)).toEqual(["auto-retry-scheduled"]);
    expect(manager.isRetryPending).toBe(true);

    await clock.adjust(Duration.millis(delayMs - 1));
    expect(onRetry).not.toHaveBeenCalled();
    expect(manager.isRetryPending).toBe(true);

    await clock.adjust(Duration.millis(1));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(manager.isRetryPending).toBe(false);
    expect(events.map((event) => event.type)).toEqual([
      "auto-retry-scheduled",
      "auto-retry-starting",
    ]);
  });

  it("cancel() before the delay elapses means the retry never fires", async () => {
    manager.handleStreamFailure({ type: "unknown", message: "transient" });
    manager.cancel();
    expect(manager.isRetryPending).toBe(false);

    await clock.adjust(Duration.millis(calculateBackoffDelay(1) * 10));

    expect(onRetry).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["auto-retry-scheduled"]);
  });

  it("a second failure before the delay reschedules with the next backoff", async () => {
    manager.handleStreamFailure({ type: "unknown" });
    await clock.adjust(Duration.millis(calculateBackoffDelay(1) - 1));
    manager.handleStreamFailure({ type: "unknown" });
    const secondDelayMs = calculateBackoffDelay(2);

    // The superseded timer is gone: only the new one can fire.
    await clock.adjust(Duration.millis(secondDelayMs - 1));
    expect(onRetry).not.toHaveBeenCalled();
    await clock.adjust(Duration.millis(1));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
