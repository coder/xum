import { describe, expect, test } from "bun:test";

import { asyncIterableFromSubscription } from "./asyncEventIterator";

describe("asyncIterableFromSubscription", () => {
  test("subscribes before reading the initial snapshot", async () => {
    let push: ((value: number) => void) | undefined;
    const iterable = asyncIterableFromSubscription({
      subscribe: (next) => {
        push = next;
        return () => undefined;
      },
      initial: () => {
        push?.(2);
        return 1;
      },
    });
    const iterator = iterable[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: false, value: 1 });
    expect(await iterator.next()).toEqual({ done: false, value: 2 });
    await iterator.return?.(undefined);
  });

  test("aborting wakes a waiting iterator and unsubscribes", async () => {
    const controller = new AbortController();
    let unsubscribed = false;
    const iterable = asyncIterableFromSubscription<number>({
      signal: controller.signal,
      subscribe: () => () => {
        unsubscribed = true;
      },
    });
    const iterator = iterable[Symbol.asyncIterator]();
    const next = iterator.next();

    controller.abort();

    expect(await next).toEqual({ done: true, value: undefined });
    expect(unsubscribed).toBe(true);
  });

  test("a pre-aborted signal never subscribes", async () => {
    const controller = new AbortController();
    controller.abort();
    let subscribed = false;
    const iterator = asyncIterableFromSubscription<number>({
      signal: controller.signal,
      subscribe: () => {
        subscribed = true;
        return () => undefined;
      },
    })[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(subscribed).toBe(false);
  });
});
