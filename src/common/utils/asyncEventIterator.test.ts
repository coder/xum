import { describe, expect, test } from "bun:test";

import { createLatestValueQueue } from "./asyncEventIterator";

describe("createLatestValueQueue", () => {
  test("an unconsumed value is replaced, not queued", async () => {
    const queue = createLatestValueQueue<number>();
    // A consumer slower than the producer must never accumulate a backlog: pushes
    // while nothing is waiting coalesce into the single latest value.
    queue.push(1);
    queue.push(2);
    queue.push(3);
    const iterator = queue.iterate();
    expect((await iterator.next()).value).toBe(3);
    queue.push(4);
    expect((await iterator.next()).value).toBe(4);
    queue.end();
    expect((await iterator.next()).done).toBe(true);
  });

  test("a waiting consumer receives the next pushed value immediately", async () => {
    const queue = createLatestValueQueue<string>();
    const iterator = queue.iterate();
    const next = iterator.next();
    queue.push("a");
    expect((await next).value).toBe("a");
    queue.end();
  });

  test("end wakes a waiting consumer without yielding a value", async () => {
    const queue = createLatestValueQueue<string>();
    const iterator = queue.iterate();
    const next = iterator.next();
    queue.end();
    expect((await next).done).toBe(true);
    // Pushes after end are ignored.
    queue.push("late");
    expect((await iterator.next()).done).toBe(true);
  });
});
