import { describe, expect, spyOn, test } from "bun:test";
import { log } from "@/node/services/log";
import {
  ONCHAT_REPLAY_SLOW_LOG_THRESHOLD_MS,
  createOnChatReplayTimer,
  logOnChatReplayTiming,
} from "./onChatReplayTiming";

/** Manual clock: each test advances it explicitly so phase math is exact. */
function createClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("createOnChatReplayTimer", () => {
  test("sums repeated phases across sync and async calls and reports the total", async () => {
    const clock = createClock();
    const timer = createOnChatReplayTimer(clock.now);

    timer.timeSync("fingerprint", () => clock.advance(3));
    await timer.time("streamReplay", () => {
      clock.advance(20);
      return Promise.resolve();
    });
    timer.timeSync("fingerprint", () => clock.advance(4));
    clock.advance(5); // unmeasured work still counts toward the total

    expect(timer.finish()).toEqual({
      totalMs: 32,
      phasesMs: { fingerprint: 7, streamReplay: 20 },
    });
  });

  test("records the elapsed time when the timed work throws", async () => {
    const clock = createClock();
    const timer = createOnChatReplayTimer(clock.now);

    expect(() =>
      timer.timeSync("emitRows", () => {
        clock.advance(2);
        throw new Error("listener failed");
      })
    ).toThrow("listener failed");
    const failure = await timer
      .time<void>("initReplay", async () => {
        clock.advance(6);
        await Promise.resolve();
        throw new Error("init failed");
      })
      .catch((error: unknown) => error);
    expect(failure).toEqual(new Error("init failed"));

    expect(timer.finish().phasesMs).toEqual({ emitRows: 2, initReplay: 6 });
  });

  test("splits a locked read into wait and work at the lock-acquired callback", async () => {
    const clock = createClock();
    const timer = createOnChatReplayTimer(clock.now);

    await timer.timeLocked("historyLockWait", "historyRead", async (onLockAcquired) => {
      clock.advance(40);
      onLockAcquired();
      clock.advance(15);
      await Promise.resolve();
    });

    expect(timer.finish().phasesMs).toEqual({ historyLockWait: 40, historyRead: 15 });
  });
});

describe("logOnChatReplayTiming", () => {
  test.each([
    { totalMs: ONCHAT_REPLAY_SLOW_LOG_THRESHOLD_MS - 0.1, level: "debug" },
    { totalMs: ONCHAT_REPLAY_SLOW_LOG_THRESHOLD_MS, level: "info" },
  ] as const)("logs a $totalMs ms replay at $level", ({ totalMs, level }) => {
    const infoSpy = spyOn(log, "info").mockImplementation(() => undefined);
    const debugSpy = spyOn(log, "debug").mockImplementation(() => undefined);
    try {
      const fields = { workspaceId: "ws-1", totalMs, phasesMs: { historyRead: 1 } };

      logOnChatReplayTiming(fields);

      const [used, unused] = level === "info" ? [infoSpy, debugSpy] : [debugSpy, infoSpy];
      expect(used).toHaveBeenCalledTimes(1);
      expect(used.mock.calls[0]?.[1]).toEqual(fields);
      expect(unused).not.toHaveBeenCalled();
    } finally {
      // bun:test spies persist across tests unless restored.
      infoSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });
});
