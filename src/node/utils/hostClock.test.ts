import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { makeTestEffectRunner, TEST_CLOCK_START_MS } from "@/node/services/di/testEffectRunner";
import { nodeClock, type HostClock } from "./hostClock";

/**
 * One contract for both HostClock implementations: production code that moves
 * from Date.now()/setTimeout() onto HostClock must see the same timer
 * semantics on nodeClock (real timers) and on the TestClock-backed clock.
 */
interface ClockSubject {
  readonly clock: HostClock;
  /** Let `ms` of this clock's time pass; due timers have run when it resolves. */
  advance(ms: number): Promise<void>;
  dispose(): Promise<void>;
}

function realTimeSubject(): ClockSubject {
  return {
    clock: nodeClock,
    // A real timer armed after the timer under test, with an equal or longer
    // delay, fires after it (Node runs due timers in delay, then FIFO, order).
    advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    dispose: () => Promise.resolve(),
  };
}

function testClockSubject(): ClockSubject {
  const t = makeTestEffectRunner();
  return { clock: t.hostClock, advance: (ms) => t.adjust(ms), dispose: () => t.dispose() };
}

describe.each([
  ["nodeClock", realTimeSubject],
  ["the TestClock HostClock", testClockSubject],
] as const)("HostClock contract: %s", (_name, makeSubject) => {
  let subject: ClockSubject | undefined;
  afterEach(async () => {
    await subject?.dispose();
    subject = undefined;
  });

  test("a timer fires once it is due, not before", async () => {
    subject = makeSubject();
    let fired = 0;
    subject.clock.setTimer(() => fired++, 30);
    await subject.advance(10);
    expect(fired).toBe(0);
    await subject.advance(20);
    expect(fired).toBe(1);
  });

  test("cancel stops a pending timer", async () => {
    subject = makeSubject();
    let fired = 0;
    const cancel = subject.clock.setTimer(() => fired++, 10);
    cancel();
    await subject.advance(20);
    expect(fired).toBe(0);
  });

  test("a 0 ms timer never runs before setTimer returns", async () => {
    subject = makeSubject();
    let fired = 0;
    subject.clock.setTimer(() => fired++, 0);
    expect(fired).toBe(0);
    await subject.advance(1);
    expect(fired).toBe(1);
  });

  test("a 0 ms timer runs after the microtasks queued behind it", async () => {
    // setTimeout(fn, 0) is a timer task: a promise continuation queued after it
    // wins a race against it. The TestClock must not invert that order.
    subject = makeSubject();
    const order: string[] = [];
    subject.clock.setTimer(() => order.push("timer"), 0);
    void Promise.resolve().then(() => order.push("microtask"));
    await subject.advance(1);
    expect(order).toEqual(["microtask", "timer"]);
  });

  test("cancel before a 0 ms timer runs stops it", async () => {
    subject = makeSubject();
    let fired = 0;
    const cancel = subject.clock.setTimer(() => fired++, 0);
    cancel();
    await subject.advance(1);
    expect(fired).toBe(0);
  });
});

describe("nodeClock", () => {
  test("reads Date.now at each call, so unmoved Date.now fakes still apply", () => {
    const nowSpy = spyOn(Date, "now").mockReturnValue(42);
    try {
      expect(nodeClock.nowMs()).toBe(42);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("the TestClock HostClock", () => {
  test("starts at TEST_CLOCK_START_MS and moves with adjust", async () => {
    const t = makeTestEffectRunner();
    try {
      expect(t.hostClock.nowMs()).toBe(TEST_CLOCK_START_MS);
      await t.adjust(1_500);
      expect(t.hostClock.nowMs()).toBe(TEST_CLOCK_START_MS + 1_500);
      await t.setTime(TEST_CLOCK_START_MS + 60_000);
      expect(t.hostClock.nowMs()).toBe(TEST_CLOCK_START_MS + 60_000);
    } finally {
      await t.dispose();
    }
  });
});
