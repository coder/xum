import { describe, expect, it } from "bun:test";

import { KeyedTurnQueue } from "./keyedTurnQueue";

function deferred() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Lets every reaction already queued on a promise run. Nothing here waits for elapsed time. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("KeyedTurnQueue", () => {
  it("runs the jobs of one key one at a time, in the order they were queued", async () => {
    const queue = new KeyedTurnQueue();
    const events: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const run = (id: number) =>
      queue.run("owner", new AbortController().signal, async () => {
        events.push(`start-${id}`);
        await gates[id].opened;
        events.push(`end-${id}`);
        return id;
      });

    const results = [run(0), run(1), run(2)];
    await settle();
    expect(events).toEqual(["start-0"]);

    gates[0].open();
    await settle();
    expect(events).toEqual(["start-0", "end-0", "start-1"]);

    gates[1].open();
    gates[2].open();
    expect(await Promise.all(results)).toEqual([0, 1, 2]);
    expect(events).toEqual(["start-0", "end-0", "start-1", "end-1", "start-2", "end-2"]);
  });

  it("does not make one key wait for another", async () => {
    const queue = new KeyedTurnQueue();
    const held = deferred();
    const first = queue.run("a", new AbortController().signal, () => held.opened);

    // Completes while the job of key "a" is still held.
    expect(await queue.run("b", new AbortController().signal, () => Promise.resolve("done"))).toBe(
      "done"
    );

    held.open();
    await first;
  });

  it("never starts a job cancelled while it waited, and holds the jobs behind it for the running one", async () => {
    const queue = new KeyedTurnQueue();
    const events: string[] = [];
    const running = deferred();
    const cancelledWaiter = new AbortController();
    const first = queue.run("owner", new AbortController().signal, async () => {
      events.push("start-first");
      await running.opened;
      events.push("end-first");
    });
    const cancelled = queue.run("owner", cancelledWaiter.signal, () => {
      events.push("start-cancelled");
      return Promise.resolve();
    });
    const last = queue.run("owner", new AbortController().signal, () => {
      events.push("start-last");
      return Promise.resolve();
    });

    cancelledWaiter.abort();
    expect(await cancelled).toBeNull();
    // The cancelled waiter released its link, but the job ahead of it still holds the key.
    await settle();
    expect(events).toEqual(["start-first"]);

    running.open();
    await Promise.all([first, last]);
    expect(events).toEqual(["start-first", "end-first", "start-last"]);
  });

  it("does not start a job whose signal had already aborted, even on an idle key", async () => {
    const queue = new KeyedTurnQueue();
    const aborted = AbortSignal.abort();
    let started = false;

    const result = await queue.run("owner", aborted, () => {
      started = true;
      return Promise.resolve(1);
    });

    expect(result).toBeNull();
    expect(started).toBe(false);
  });

  it("passes the turn on when a job throws", async () => {
    const queue = new KeyedTurnQueue();
    const failing = queue.run("owner", new AbortController().signal, () =>
      Promise.reject(new Error("job failed"))
    );
    const next = queue.run("owner", new AbortController().signal, () => Promise.resolve("next"));

    expect(await failing.catch((error: Error) => error.message)).toBe("job failed");
    expect(await next).toBe("next");
  });
});
