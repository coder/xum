import { describe, expect, spyOn, test } from "bun:test";
import { createControllableAsyncIterable } from "@/browser/testUtils";
import {
  SUBSCRIPTION_RETRY_MAX_MS,
  calculateSubscriptionBackoffMs,
  runSubscriptionLoop,
} from "./subscriptionTransport";

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const getClient = () => Promise.resolve({});
const noSleep = () => Promise.resolve();

function closeOnAbort<T>(signal: AbortSignal) {
  const stream = createControllableAsyncIterable<T>();
  signal.addEventListener("abort", () => stream.close(), { once: true });
  return stream;
}

describe("runSubscriptionLoop", () => {
  test.each([
    {
      name: "progresses exponential backoff to the cap",
      eventsByAttempt: [[], [], [], [], [], []],
      expectedSleeps: [250, 500, 1000, 2000, 4000, SUBSCRIPTION_RETRY_MAX_MS],
    },
    {
      name: "resets backoff after an event",
      eventsByAttempt: [[], [1], []],
      expectedSleeps: [250, 250, 500],
    },
    {
      name: "with isSuccessEvent, non-success events keep backing off",
      eventsByAttempt: [[0], [0], [0], [1], [0]],
      expectedSleeps: [250, 500, 1000, 250, 500],
      isSuccessEvent: (event: number) => event === 1,
    },
  ])("$name", async ({ eventsByAttempt, expectedSleeps, isSuccessEvent }) => {
    const controller = new AbortController();
    const clientChange = new AbortController();
    const sleeps: number[] = [];
    let subscription = 0;
    let activeStream: ReturnType<typeof createControllableAsyncIterable<number>> | undefined;

    await runSubscriptionLoop({
      name: "test",
      signal: controller.signal,
      getClient,
      getClientChangeSignal: () => clientChange.signal,
      subscribe: () => {
        const events = eventsByAttempt[subscription++] ?? [];
        activeStream = createControllableAsyncIterable<number>();
        for (const event of events) activeStream.push(event);
        if (events.length === 0) activeStream.close();
        return Promise.resolve({ events: activeStream.iterable, context: undefined });
      },
      onEvent: () => activeStream?.close(),
      watchdog: false,
      isSuccessEvent,
      sleep: (timeoutMs) => {
        sleeps.push(timeoutMs);
        if (sleeps.length === expectedSleeps.length) controller.abort();
        return Promise.resolve();
      },
    });

    expect(sleeps).toEqual([...expectedSleeps]);
  });

  test("retries after subscribe errors", async () => {
    const controller = new AbortController();
    const clientChange = new AbortController();
    const errors: unknown[] = [];
    let subscriptions = 0;

    await runSubscriptionLoop({
      name: "test",
      signal: controller.signal,
      getClient,
      getClientChangeSignal: () => clientChange.signal,
      subscribe: (_client, signal) => {
        subscriptions++;
        if (subscriptions === 1) return Promise.reject(new Error("subscribe failed"));
        const stream = closeOnAbort<number>(signal);
        stream.push(1);
        return Promise.resolve({ events: stream.iterable, context: undefined });
      },
      onEvent: () => controller.abort(),
      onError: (error) => {
        errors.push(error);
      },
      watchdog: false,
      sleep: noSleep,
    });

    expect(subscriptions).toBe(2);
    expect(errors).toHaveLength(1);
  });

  test("starts the watchdog only after subscribe connects", async () => {
    const controller = new AbortController();
    const clientChange = new AbortController();
    let resolveSubscription!: (stream: ReturnType<typeof closeOnAbort<number>>) => void;
    const connected = new Promise<ReturnType<typeof closeOnAbort<number>>>((resolve) => {
      resolveSubscription = resolve;
    });
    let firstAttemptSignal: AbortSignal | undefined;

    const loop = runSubscriptionLoop({
      name: "test",
      signal: controller.signal,
      getClient,
      getClientChangeSignal: () => clientChange.signal,
      subscribe: async (_client, signal) => {
        firstAttemptSignal ??= signal;
        const stream = await connected;
        return { events: stream.iterable, context: undefined };
      },
      onEvent: () => undefined,
      watchdog: { timeoutMs: 10, checkIntervalMs: 1 },
      backoffAfterAbort: false,
    });

    await Bun.sleep(20);
    expect(firstAttemptSignal?.aborted).toBe(false);
    const stream = closeOnAbort<number>(firstAttemptSignal!);
    resolveSubscription(stream);
    await Bun.sleep(20);
    expect(firstAttemptSignal?.aborted).toBe(true);
    controller.abort();
    stream.close();
    await loop;
  });

  test("events reset the watchdog deadline", async () => {
    const controller = new AbortController();
    const clientChange = new AbortController();
    let stream!: ReturnType<typeof closeOnAbort<number>>;
    let attemptSignal!: AbortSignal;
    let now = 0;
    let checkWatchdog!: () => void;
    let consumed = Promise.withResolvers<void>();
    const watchdogStarted = Promise.withResolvers<void>();
    const realSetInterval = globalThis.setInterval;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    // DOM/Bun/Node declare different handle overloads. This fixture handles the watchdog's
    // no-argument callback and delegates handle creation to the original timer API.
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((handler: unknown) => {
      if (typeof handler !== "function") throw new Error("Expected a watchdog callback");
      checkWatchdog = handler as () => void;
      watchdogStarted.resolve();
      // Own a real disposable timer, but drive its checks explicitly rather than racing the host.
      return realSetInterval(() => undefined, 2_147_483_647);
    }) as typeof globalThis.setInterval);
    const loop = runSubscriptionLoop({
      name: "test",
      signal: controller.signal,
      getClient,
      getClientChangeSignal: () => clientChange.signal,
      subscribe: (_client, signal) => {
        attemptSignal = signal;
        stream = closeOnAbort<number>(signal);
        return Promise.resolve({ events: stream.iterable, context: undefined });
      },
      onEvent: () => consumed.resolve(),
      watchdog: { timeoutMs: 30, checkIntervalMs: 2 },
    });

    try {
      await watchdogStarted.promise;
      for (let i = 1; i <= 3; i++) {
        now = i * 20;
        stream.push(i);
        await consumed.promise;
        consumed = Promise.withResolvers<void>();
        now += 15;
        checkWatchdog();
        // Beyond the original deadline, but still inside the deadline reset by this event.
        expect(attemptSignal.aborted).toBe(false);
      }
      now += 15;
      checkWatchdog();
      expect(attemptSignal.aborted).toBe(true);
    } finally {
      // An assertion failure must not leave a retry loop perturbing every later shared suite.
      controller.abort();
      stream?.close();
      try {
        await loop;
      } finally {
        interval.mockRestore();
        clock.mockRestore();
      }
    }
  });

  test("a stalled attempt is aborted and retried", async () => {
    const controller = new AbortController();
    const clientChange = new AbortController();
    const signals: AbortSignal[] = [];

    await runSubscriptionLoop({
      name: "test",
      signal: controller.signal,
      getClient,
      getClientChangeSignal: () => clientChange.signal,
      subscribe: (_client, signal) => {
        signals.push(signal);
        const stream = closeOnAbort<number>(signal);
        return Promise.resolve({ events: stream.iterable, context: undefined });
      },
      onEvent: () => undefined,
      watchdog: { timeoutMs: 10, checkIntervalMs: 1 },
      backoffAfterAbort: false,
      onAttemptFinished: () => {
        if (signals.length === 2) controller.abort();
      },
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
  });

  test("client changes abort the attempt and attach the replacement", async () => {
    const controller = new AbortController();
    let clientChange = new AbortController();
    let client = "first";
    const attached: string[] = [];

    const loop = runSubscriptionLoop({
      name: "test",
      signal: controller.signal,
      getClient: () => Promise.resolve(client),
      getClientChangeSignal: () => clientChange.signal,
      subscribe: (currentClient, signal) => {
        attached.push(currentClient);
        const stream = closeOnAbort<number>(signal);
        if (currentClient === "second") stream.push(1);
        return Promise.resolve({ events: stream.iterable, context: undefined });
      },
      onEvent: () => controller.abort(),
      watchdog: false,
      backoffAfterAbort: false,
    });

    await flush();
    client = "second";
    const previousChange = clientChange;
    clientChange = new AbortController();
    previousChange.abort();
    await loop;

    expect(attached).toEqual(["first", "second"]);
  });

  test("a client swap during getClient retries instead of binding the stale client", async () => {
    const controller = new AbortController();
    const subscribedClients: string[] = [];
    let generation = 0;
    const changeControllers = [new AbortController(), new AbortController()];

    await runSubscriptionLoop<string, number, undefined>({
      name: "test",
      signal: controller.signal,
      getClient: () => {
        if (generation === 0) {
          // Swap generations while the first attempt is awaiting the client.
          generation = 1;
          changeControllers[0].abort();
          return Promise.resolve("stale-client");
        }
        return Promise.resolve("fresh-client");
      },
      getClientChangeSignal: () => changeControllers[generation === 0 ? 0 : 1].signal,
      subscribe: (client, signal) => {
        subscribedClients.push(client);
        const stream = closeOnAbort<number>(signal);
        stream.push(1);
        return Promise.resolve({ events: stream.iterable, context: undefined });
      },
      onEvent: () => controller.abort(),
      watchdog: false,
      sleep: noSleep,
    });

    expect(subscribedClients).toEqual(["fresh-client"]);
  });

  test("clean teardown aborts the active attempt without retrying", async () => {
    const controller = new AbortController();
    const clientChange = new AbortController();
    let subscriptions = 0;

    const loop = runSubscriptionLoop({
      name: "test",
      signal: controller.signal,
      getClient,
      getClientChangeSignal: () => clientChange.signal,
      subscribe: (_client, signal) => {
        subscriptions++;
        const stream = closeOnAbort<number>(signal);
        return Promise.resolve({ events: stream.iterable, context: undefined });
      },
      onEvent: () => undefined,
      watchdog: false,
    });

    await flush();
    controller.abort();
    await loop;
    expect(subscriptions).toBe(1);
  });
});

test("calculateSubscriptionBackoffMs caps large attempts", () => {
  expect(calculateSubscriptionBackoffMs(100)).toBe(SUBSCRIPTION_RETRY_MAX_MS);
});
