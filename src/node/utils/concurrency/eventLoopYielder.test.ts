import { expect, test } from "bun:test";
import { EventLoopYielder } from "./eventLoopYielder";

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
  expect(yielder.isDue()).toBe(false);
});
