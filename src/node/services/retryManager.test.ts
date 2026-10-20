import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn, vi } from "bun:test";
import { Duration } from "effect";
import {
  calculateBackoffDelay,
  MAX_RETRY_AFTER_DELAY_MS,
} from "@/common/utils/messages/retryState";
import { makeTestEffectRunner, type TestEffectRunner } from "./di/testEffectRunner";
import { RetryManager, type RetryStatusEvent } from "./retryManager";

/**
 * The backoff sleep runs on the injected `EffectRunner`'s clock, so the suite
 * drives it with a `TestClock` (`clock.adjust`) instead of intercepting
 * `setTimeout`. `setSystemTime` only pins `Date.now()` for the `scheduledAt`
 * stamp; it never drove timing. One default-runner smoke at the bottom keeps
 * the production path (Effect's default clock → real `setTimeout`) covered.
 */
describe("RetryManager", () => {
  let clock: TestEffectRunner;

  beforeEach(() => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    clock = makeTestEffectRunner();
  });

  afterEach(async () => {
    setSystemTime();
    await clock.dispose();
  });

  function createRetryManager() {
    const onRetry = vi.fn(() => Promise.resolve());
    const events: RetryStatusEvent[] = [];
    const onStatusChange = vi.fn((event: RetryStatusEvent) => {
      events.push(event);
    });

    return {
      manager: new RetryManager("workspace-1", onRetry, onStatusChange, clock.runner),
      onRetry,
      onStatusChange,
      events,
    };
  }

  /** Advance far past any backoff: a retry that is still armed would fire. */
  const adjustPastAnyBackoff = () => clock.adjust(Duration.millis(calculateBackoffDelay(6) * 2));

  it("uses exponential backoff delays from common retry state utilities", () => {
    expect(calculateBackoffDelay(0)).toBe(1000);
    expect(calculateBackoffDelay(1)).toBe(2000);
    expect(calculateBackoffDelay(2)).toBe(4000);
    expect(calculateBackoffDelay(6)).toBe(60000);
  });

  it("waits for the provider's Retry-After when it is longer than the backoff", async () => {
    const { manager, onRetry, events } = createRetryManager();

    manager.handleStreamFailure({ type: "rate_limit", retryAfterMs: 30_000 });

    expect(events[0]).toMatchObject({ type: "auto-retry-scheduled", attempt: 1, delayMs: 30_000 });
    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));
    expect(onRetry).not.toHaveBeenCalled();
    await clock.adjust(Duration.millis(30_000 - calculateBackoffDelay(1)));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps the backoff when Retry-After is shorter, and bounds a very long Retry-After", () => {
    const short = createRetryManager();
    short.manager.handleStreamFailure({ type: "rate_limit", retryAfterMs: 10 });
    expect(short.events[0]).toMatchObject({ delayMs: calculateBackoffDelay(1) });

    const long = createRetryManager();
    long.manager.handleStreamFailure({ type: "rate_limit", retryAfterMs: 24 * 60 * 60 * 1000 });
    expect(long.events[0]).toMatchObject({ delayMs: MAX_RETRY_AFTER_DELAY_MS });
  });

  // reasoning_rejected: StreamManager already spent its one in-stream repair, so
  // an outer retry would resend the same rejected reasoning replay forever.
  for (const type of ["api_key_not_found", "reasoning_rejected"]) {
    it(`abandons non-retryable ${type} errors`, async () => {
      const { manager, onRetry, onStatusChange, events } = createRetryManager();

      manager.handleStreamFailure({ type });

      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(events).toEqual([{ type: "auto-retry-abandoned", reason: type }]);
      expect(manager.isRetryPending).toBe(false);
      await adjustPastAnyBackoff();
      expect(onRetry).not.toHaveBeenCalled();
    });
  }

  it("non-retryable error cancels pending retryable timer", async () => {
    const { manager, onRetry, events } = createRetryManager();

    // Schedule a retryable error first
    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);

    // Then a non-retryable error arrives — should cancel the pending timer
    manager.handleStreamFailure({ type: "api_key_not_found" });
    expect(manager.isRetryPending).toBe(false);
    expect(events).toContainEqual({ type: "auto-retry-abandoned", reason: "api_key_not_found" });
    await adjustPastAnyBackoff();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("schedules and runs retry exactly at the backoff delay", async () => {
    const { manager, onRetry, events } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown", message: "transient" });

    const expectedDelay = calculateBackoffDelay(1);
    expect(events).toEqual([
      {
        type: "auto-retry-scheduled",
        attempt: 1,
        delayMs: expectedDelay,
        scheduledAt: Date.now(),
      },
    ]);
    expect(manager.isRetryPending).toBe(true);

    await clock.adjust(Duration.millis(expectedDelay - 1));
    expect(onRetry).not.toHaveBeenCalled();
    expect(manager.isRetryPending).toBe(true);

    await clock.adjust(Duration.millis(1));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "auto-retry-starting", attempt: 1 });
    expect(manager.isRetryPending).toBe(false);
  });

  it("exposes pending scheduled retry for reconnect snapshots", async () => {
    const { manager } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown", message: "transient" });

    const snapshot = manager.getScheduledStatusSnapshot();
    expect(snapshot).toEqual({
      type: "auto-retry-scheduled",
      attempt: 1,
      delayMs: calculateBackoffDelay(1),
      scheduledAt: Date.now(),
    });

    // Snapshot should be defensive-copied.
    if (!snapshot) {
      throw new Error("Expected a pending retry snapshot");
    }
    snapshot.attempt = 99;

    expect(manager.getScheduledStatusSnapshot()).toEqual({
      type: "auto-retry-scheduled",
      attempt: 1,
      delayMs: calculateBackoffDelay(1),
      scheduledAt: Date.now(),
    });

    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));
    expect(manager.getScheduledStatusSnapshot()).toBeNull();
  });

  it("clears pending scheduled snapshot when retry is canceled", () => {
    const { manager } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.getScheduledStatusSnapshot()).not.toBeNull();

    manager.cancel();
    expect(manager.getScheduledStatusSnapshot()).toBeNull();
  });

  it("cancel clears pending retry timer", async () => {
    const { manager, onRetry } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);

    manager.cancel();
    expect(manager.isRetryPending).toBe(false);
    await adjustPastAnyBackoff();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("scheduled observers can cancel before the retry fiber is installed", async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    const manager = new RetryManager(
      "workspace-1",
      onRetry,
      (event) => {
        if (event.type === "auto-retry-scheduled") manager.cancel();
      },
      clock.runner
    );

    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(false);
    expect(manager.getScheduledStatusSnapshot()).toBeNull();
    await adjustPastAnyBackoff();
    expect(onRetry).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("a reentrant replacement owns its fiber and status through the retired wake time", async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    const events: RetryStatusEvent[] = [];
    const manager = new RetryManager(
      "workspace-1",
      onRetry,
      (event) => {
        events.push(event);
        if (event.type === "auto-retry-scheduled" && event.attempt === 1) {
          manager.handleStreamFailure({ type: "unknown", message: "replacement" });
        }
      },
      clock.runner
    );

    manager.handleStreamFailure({ type: "unknown", message: "retired" });
    const replacement = manager.getScheduledStatusSnapshot();
    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));
    expect(onRetry).not.toHaveBeenCalled();
    expect(manager.isRetryPending).toBe(true);
    expect(manager.getScheduledStatusSnapshot()).toEqual(replacement);
    manager.cancel();
    await adjustPastAnyBackoff();
    expect(events.filter((event) => event.type === "auto-retry-starting")).toHaveLength(0);
    expect(onRetry).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("setEnabled(false) prevents scheduling", async () => {
    const { manager, onRetry, onStatusChange } = createRetryManager();

    manager.setEnabled(false);
    manager.handleStreamFailure({ type: "unknown" });

    expect(onStatusChange).not.toHaveBeenCalled();
    expect(manager.isRetryPending).toBe(false);
    await adjustPastAnyBackoff();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("setEnabled(false) cancels pending retry and emits abandoned event", async () => {
    const { manager, onRetry, events } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);

    manager.setEnabled(false);
    expect(manager.isRetryPending).toBe(false);
    expect(events).toContainEqual({
      type: "auto-retry-abandoned",
      reason: "disabled_by_user",
    });
    await adjustPastAnyBackoff();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("setEnabled(false) emits abandoned even after timer has fired (in-flight retry)", async () => {
    const { manager, events } = createRetryManager();

    // Schedule a retry, then let the backoff elapse so the fiber is past its
    // sleep but state.attempt > 0 (retry callback is in-flight).
    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);
    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));
    expect(manager.isRetryPending).toBe(false);

    // Disable while the retry callback is executing. Even though the timer
    // is gone, the UI should still be cleared via abandoned event.
    manager.setEnabled(false);
    expect(events).toContainEqual({
      type: "auto-retry-abandoned",
      reason: "disabled_by_user",
    });
  });

  it("setEnabled(false) during auto-retry-starting prevents queued resume", async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    const events: RetryStatusEvent[] = [];

    const managerRef: { current?: RetryManager } = {};
    const onStatusChange = vi.fn((event: RetryStatusEvent) => {
      events.push(event);
      if (event.type === "auto-retry-starting") {
        managerRef.current?.setEnabled(false);
      }
    });

    const manager = new RetryManager("workspace-1", onRetry, onStatusChange, clock.runner);
    managerRef.current = manager;

    manager.handleStreamFailure({ type: "unknown" });
    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));

    expect(onRetry).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "auto-retry-abandoned",
      reason: "disabled_by_user",
    });
  });

  it("starting publication owns exactly one claim even when its observer cancels synchronously", async () => {
    let owned = false;
    const released = vi.fn(() => {
      owned = false;
    });
    const onRetry = vi.fn(() => Promise.resolve());
    const begin = vi.fn(() => {
      owned = true;
      return { [Symbol.dispose]: released };
    });
    const manager = new RetryManager(
      "workspace-1",
      onRetry,
      (event) => {
        if (event.type !== "auto-retry-starting") return;
        expect(owned).toBe(true);
        manager.cancel();
        expect(owned).toBe(false);
      },
      clock.runner,
      begin
    );
    manager.handleStreamFailure({ type: "unknown" });
    await clock.adjust(calculateBackoffDelay(1));
    expect(begin).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("an observer throwing after rescheduling cannot retire its replacement", async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    const manager = new RetryManager(
      "workspace-1",
      onRetry,
      (event) => {
        if (event.type === "auto-retry-scheduled" && event.attempt === 1) {
          manager.handleStreamFailure({ type: "unknown" });
          throw new Error("observer failed after replacement");
        }
      },
      clock.runner
    );
    expect(() => manager.handleStreamFailure({ type: "unknown" })).toThrow();
    expect(manager.getScheduledStatusSnapshot()?.attempt).toBe(2);
    await clock.adjust(calculateBackoffDelay(2));
    expect(onRetry).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it.each([false, true])(
    "a throwing starting observer releases only its own claim (replacement=%s)",
    async (replace) => {
      let owned = 0;
      const onRetry = vi.fn(() => Promise.resolve());
      const events: RetryStatusEvent[] = [];
      const manager = new RetryManager(
        "workspace-1",
        onRetry,
        (event) => {
          events.push(event);
          if (event.type === "auto-retry-starting" && event.attempt === 1) {
            if (replace) manager.handleStreamFailure({ type: "unknown" });
            throw new Error("starting observer failed");
          }
        },
        clock.runner,
        () => {
          owned += 1;
          return {
            [Symbol.dispose]: () => {
              owned -= 1;
            },
          };
        }
      );
      manager.handleStreamFailure({ type: "unknown" });
      await clock.adjust(calculateBackoffDelay(1));
      expect(owned).toBe(0);
      expect(onRetry).not.toHaveBeenCalled();
      if (replace) {
        expect(manager.getScheduledStatusSnapshot()?.attempt).toBe(2);
        await clock.adjust(calculateBackoffDelay(2));
        expect(onRetry).toHaveBeenCalledTimes(1);
      } else {
        expect(events).toContainEqual({
          type: "auto-retry-abandoned",
          reason: "starting observer failed",
        });
      }
      manager.dispose();
      expect(owned).toBe(0);
    }
  );

  it("ignores stale onRetry rejection after disable", async () => {
    let rejectRetry: ((reason?: unknown) => void) | undefined;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRetry = reject;
        })
    );

    const events: RetryStatusEvent[] = [];
    const onStatusChange = vi.fn((event: RetryStatusEvent) => {
      events.push(event);
    });

    const manager = new RetryManager("workspace-1", onRetry, onStatusChange, clock.runner);

    manager.handleStreamFailure({ type: "unknown" });
    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));
    expect(onRetry).toHaveBeenCalledTimes(1);

    manager.setEnabled(false);
    rejectRetry?.(new Error("late_retry_failure"));
    await Promise.resolve();
    await Promise.resolve();

    const abandonedReasons = events
      .filter(
        (event): event is Extract<RetryStatusEvent, { type: "auto-retry-abandoned" }> =>
          event.type === "auto-retry-abandoned"
      )
      .map((event) => event.reason);

    expect(abandonedReasons).toContain("disabled_by_user");
    expect(abandonedReasons).not.toContain("late_retry_failure");
  });

  it("reschedules when a second failure arrives while retry is pending", async () => {
    const { manager, onRetry, events } = createRetryManager();

    // First failure schedules a retry
    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);
    await clock.adjust(Duration.millis(calculateBackoffDelay(1) - 1));

    // Second failure should cancel the first and reschedule with higher backoff
    manager.handleStreamFailure({ type: "network" });
    expect(manager.isRetryPending).toBe(true);

    const scheduleEvents = events.filter(
      (event): event is Extract<RetryStatusEvent, { type: "auto-retry-scheduled" }> =>
        event.type === "auto-retry-scheduled"
    );
    expect(scheduleEvents).toHaveLength(2);
    // Second attempt should have higher backoff than first
    expect(scheduleEvents[1].attempt).toBeGreaterThan(scheduleEvents[0].attempt);

    // The superseded timer is gone: only the new one can fire, and only once.
    const secondDelayMs = calculateBackoffDelay(2);
    await clock.adjust(Duration.millis(secondDelayMs - 1));
    expect(onRetry).not.toHaveBeenCalled();
    await clock.adjust(Duration.millis(1));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // #4228: a provider error part with no HTTP status (marked capIdenticalRepeats) that repeats
  // with the same text is deterministic, so retrying it forever only resends the failing request.
  it("stops retrying after 10 consecutive identical capped provider errors", async () => {
    const { manager, onRetry, events } = createRetryManager();
    const message = "processing error: accumulate event: error converting content block to JSON";

    for (let failure = 1; failure <= 10; failure++) {
      manager.handleStreamFailure({ type: "api", message, capIdenticalRepeats: true });
      await adjustPastAnyBackoff();
    }

    expect(onRetry).toHaveBeenCalledTimes(9);
    expect(manager.isRetryPending).toBe(false);
    const last = events.at(-1);
    expect(last?.type).toBe("auto-retry-abandoned");
    expect(last?.type === "auto-retry-abandoned" ? last.reason : "").toContain(message);
  });

  // Only the capped path stops. Every other failure keeps retrying with the same text, because
  // an outage repeats its text too (HTTP statuses and transport errors carry no cap marker).
  it.each([
    ["server_error", false, () => "503 Service Unavailable"],
    ["rate_limit", false, () => "429 Too Many Requests"],
    ["network", false, () => "socket hang up"],
    ["api", false, () => "processing error: accumulate event"],
    ["api", true, (failure: number) => `gateway error ${failure % 2}`],
  ] as const)(
    "keeps retrying %s failures (capped=%p) past 10 attempts",
    async (type, capIdenticalRepeats, messageFor) => {
      const { manager, onRetry, events } = createRetryManager();

      for (let failure = 1; failure <= 12; failure++) {
        manager.handleStreamFailure({ type, message: messageFor(failure), capIdenticalRepeats });
        await adjustPastAnyBackoff();
      }

      expect(onRetry).toHaveBeenCalledTimes(12);
      expect(events.some((event) => event.type === "auto-retry-abandoned")).toBe(false);
    }
  );

  it("a non-retryable failure in between restarts the count of identical unrecognized errors", async () => {
    const { manager, events } = createRetryManager();

    for (let failure = 1; failure <= 9; failure++) {
      manager.handleStreamFailure({ type: "api", message: "same text", capIdenticalRepeats: true });
      await adjustPastAnyBackoff();
    }
    manager.handleStreamFailure({ type: "authentication", message: "bad key" });
    manager.handleStreamFailure({ type: "api", message: "same text", capIdenticalRepeats: true });

    expect(events.at(-1)?.type).toBe("auto-retry-scheduled");
  });

  it("the force-all-retryable debug flag lifts the identical-error cap", async () => {
    const runtime = globalThis as { __MUX_FORCE_ALL_RETRYABLE?: boolean };
    runtime.__MUX_FORCE_ALL_RETRYABLE = true;
    try {
      const { manager, onRetry, events } = createRetryManager();
      for (let failure = 1; failure <= 12; failure++) {
        manager.handleStreamFailure({
          type: "api",
          message: "same text",
          capIdenticalRepeats: true,
        });
        await adjustPastAnyBackoff();
      }
      expect(onRetry).toHaveBeenCalledTimes(12);
      expect(events.some((event) => event.type === "auto-retry-abandoned")).toBe(false);
    } finally {
      delete runtime.__MUX_FORCE_ALL_RETRYABLE;
    }
  });

  it("a successful stream restarts the count of identical unrecognized errors", async () => {
    const { manager, onRetry, events } = createRetryManager();

    for (let failure = 1; failure <= 15; failure++) {
      if (failure === 8) manager.handleStreamSuccess();
      manager.handleStreamFailure({ type: "api", message: "same text", capIdenticalRepeats: true });
      await adjustPastAnyBackoff();
    }

    expect(onRetry).toHaveBeenCalledTimes(15);
    expect(events.some((event) => event.type === "auto-retry-abandoned")).toBe(false);
  });

  it("handleStreamSuccess resets retry attempt progression", async () => {
    const { manager, events } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));

    manager.handleStreamSuccess();
    manager.handleStreamFailure({ type: "unknown" });

    const scheduleEvents = events.filter(
      (event): event is Extract<RetryStatusEvent, { type: "auto-retry-scheduled" }> =>
        event.type === "auto-retry-scheduled"
    );

    expect(scheduleEvents).toHaveLength(2);
    expect(scheduleEvents[0]?.attempt).toBe(1);
    expect(scheduleEvents[1]?.attempt).toBe(1);
  });
});

/**
 * Default-runner smoke: with no runner injected (direct construction, the
 * aiService fallback) the backoff sleeps on Effect's default clock, i.e. a
 * real `setTimeout`. Intercepting the timer registration proves that path
 * without a two-second wall-clock wait.
 */
describe("RetryManager on the default runner", () => {
  it("arms the backoff as a real setTimeout and runs onRetry when it fires", async () => {
    const timers: Array<{ delayMs: number; fire: () => void }> = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number
    ) => {
      if (typeof handler !== "function") {
        throw new Error("RetryManager smoke only supports function timer handlers");
      }
      timers.push({ delayMs: timeout ?? 0, fire: handler as () => void });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    try {
      const onRetry = vi.fn(() => Promise.resolve());
      const manager = new RetryManager("workspace-1", onRetry, () => undefined);

      manager.handleStreamFailure({ type: "unknown" });
      expect(manager.isRetryPending).toBe(true);
      expect(timers.map((timer) => timer.delayMs)).toEqual([calculateBackoffDelay(1)]);

      timers[0].fire();
      await Promise.resolve();
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(manager.isRetryPending).toBe(false);
      manager.dispose();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
