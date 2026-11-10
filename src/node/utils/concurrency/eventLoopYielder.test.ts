import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { EventLoopYielder } from "./eventLoopYielder";

// Restores performance.now after the fake-clock test.
afterEach(() => {
  mock.restore();
});

// The contract long replay loops rely on (#4506): once a synchronous stretch uses its budget,
// yield() lets already-due timers (onChat heartbeats) run before the loop continues.
test("yield lets due timers run once the budget is used", async () => {
  const yielder = new EventLoopYielder(5);
  let timerRan = false;
  setTimeout(() => (timerRan = true), 0);

  const start = performance.now();
  while (!yielder.isDue()) {
    expect(performance.now() - start).toBeLessThan(1_000);
  }
  expect(timerRan).toBe(false);

  await yielder.yield();
  expect(timerRan).toBe(true);
});

// #6822: a fake clock checks that yield() starts a new stretch. With the real clock, a runner
// stall of one budget between yield() and the check made isDue() true again.
test("yield starts a new budget stretch", async () => {
  let now = 1_000;
  spyOn(performance, "now").mockImplementation(() => now);
  const yielder = new EventLoopYielder(5);

  now = 1_005;
  expect(yielder.isDue()).toBe(true);

  await yielder.yield();
  expect(yielder.isDue()).toBe(false);
  now = 1_009;
  expect(yielder.isDue()).toBe(false);
  now = 1_010;
  expect(yielder.isDue()).toBe(true);
});
