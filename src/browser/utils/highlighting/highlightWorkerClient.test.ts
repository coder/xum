/**
 * Unit tests for the time-budget helper that protects highlightCode against
 * catastrophic-backtracking inputs.
 *
 * We test `highlightWithBudget` directly with injected fakes — no real Worker
 * required — because the production callers (`highlightCode`) just compose
 * this helper with `Comlink`. The end-to-end worker path is exercised by the
 * existing `highlightDiffChunk.test.ts` suite (which falls through to
 * main-thread Shiki because JSDOM has no Worker).
 */

import * as Comlink from "comlink";
import { groupDiffLines } from "./diffChunking";
import { highlightDiffChunks } from "./highlightDiffChunk";
import {
  highlightCode,
  highlightWithBudget,
  enqueueHighlightWithBudget,
  __resetForTests,
} from "./highlightWorkerClient";

function neverResolves<T = string>(): Promise<T> {
  return new Promise<T>((resolve) => {
    void resolve;
  });
}

function deferred(): { promise: Promise<string>; resolve: (html: string) => void } {
  let resolve!: (html: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushQueue(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("enqueueHighlightWithBudget caller cancellation", () => {
  beforeEach(() => {
    __resetForTests();
  });

  it("skips superseded requests whose callers aborted while queued", async () => {
    const started: string[] = [];
    const inFlight = deferred();
    const onTimeout = jest.fn();
    const enqueue = (code: string, signal?: AbortSignal) =>
      enqueueHighlightWithBudget(
        code,
        "typescript",
        "dark",
        () => {
          started.push(code);
          return code === "v1" ? inFlight.promise : Promise.resolve(`<pre>${code}</pre>`);
        },
        onTimeout,
        1000,
        signal
      );

    const first = enqueue("v1");
    await flushQueue();
    expect(started).toEqual(["v1"]);

    // A streaming code block re-highlights on every commit and aborts the request it supersedes.
    const superseded = ["v2", "v3", "v4"].map((code) => {
      const controller = new AbortController();
      return { controller, result: enqueue(code, controller.signal) };
    });
    const latest = enqueue("v5", new AbortController().signal);
    for (const request of superseded) request.controller.abort();

    inFlight.resolve("<pre>v1</pre>");
    await expect(first).resolves.toBe("<pre>v1</pre>");
    for (const request of superseded) {
      await expect(request.result).rejects.toMatchObject({ name: "AbortError" });
    }
    // The queue keeps going after the aborted rejections.
    await expect(latest).resolves.toBe("<pre>v5</pre>");
    expect(started).toEqual(["v1", "v5"]);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("keeps each interleaved consumer's latest request", async () => {
    const started: string[] = [];
    const inFlight = deferred();
    const controllers = new Map<string, AbortController>();
    const results: Array<Promise<string>> = [];
    // Each consumer aborts only its own previous request, like one CodeBlock effect per block.
    const request = (consumer: string, code: string) => {
      controllers.get(consumer)?.abort();
      const controller = new AbortController();
      controllers.set(consumer, controller);
      const result = enqueueHighlightWithBudget(
        code,
        "typescript",
        "dark",
        () => {
          started.push(code);
          return code === "hold" ? inFlight.promise : Promise.resolve(code);
        },
        jest.fn(),
        1000,
        controller.signal
      );
      // Superseded requests reject; only the outcome of the run list matters here.
      results.push(result.catch(() => "aborted"));
      return result;
    };

    void request("holder", "hold");
    await flushQueue();
    void request("a", "a1");
    void request("b", "b1");
    void request("a", "a2");
    void request("b", "b2");
    const latestA = request("a", "a3");
    const latestB = request("b", "b3");

    inFlight.resolve("hold");
    await expect(latestA).resolves.toBe("a3");
    await expect(latestB).resolves.toBe("b3");
    await Promise.all(results);
    expect(started).toEqual(["hold", "a3", "b3"]);
  });

  it("lets a running request keep its slot after its caller aborts", async () => {
    const started: string[] = [];
    const inFlight = deferred();
    const controller = new AbortController();
    const first = enqueueHighlightWithBudget(
      "running",
      "typescript",
      "dark",
      () => {
        started.push("running");
        return inFlight.promise;
      },
      jest.fn(),
      1000,
      controller.signal
    );
    const second = enqueueHighlightWithBudget(
      "next",
      "typescript",
      "dark",
      () => {
        started.push("next");
        return Promise.resolve("<pre>next</pre>");
      },
      jest.fn(),
      1000
    );

    await flushQueue();
    controller.abort();
    await flushQueue();
    // The worker is still busy with the first payload, so the next one must wait for it.
    expect(started).toEqual(["running"]);

    inFlight.resolve("<pre>running</pre>");
    await expect(first).resolves.toBe("<pre>running</pre>");
    await expect(second).resolves.toBe("<pre>next</pre>");
    expect(started).toEqual(["running", "next"]);
  });

  it("never starts a timeout, terminates the worker, or marks the input for aborted work", async () => {
    const onTimeout = jest.fn();
    const call = jest.fn(() => neverResolves());
    const setTimeoutSpy = jest.spyOn(globalThis, "setTimeout");
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        enqueueHighlightWithBudget(
          "aborted",
          "typescript",
          "dark",
          call,
          onTimeout,
          20,
          controller.signal
        )
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(setTimeoutSpy.mock.calls.filter((args) => args[1] === 20)).toHaveLength(0);
    } finally {
      setTimeoutSpy.mockRestore();
    }
    expect(call).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();

    // The same input is not remembered as timed out, so a live caller still reaches the worker.
    const liveCall = jest.fn(() => Promise.resolve("<pre>ok</pre>"));
    await expect(
      enqueueHighlightWithBudget("aborted", "typescript", "dark", liveCall, onTimeout, 20)
    ).resolves.toBe("<pre>ok</pre>");
    expect(liveCall).toHaveBeenCalledTimes(1);
  });
});

describe("highlightCode caller cancellation", () => {
  const originalWorker = globalThis.Worker;

  beforeEach(() => {
    // Without a Worker, highlightCode uses the main-thread fallback. __resetForTests also drops
    // its Shiki highlighter, so the request below starts a real (asynchronous) Shiki
    // initialization, which is the await that the caller aborts during.
    Reflect.deleteProperty(globalThis, "Worker");
    __resetForTests();
  });

  afterEach(() => {
    if (originalWorker !== undefined) globalThis.Worker = originalWorker;
    __resetForTests();
  });

  it("skips the highlight when the caller aborts during initialization, without warning", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const controller = new AbortController();
      const aborted = highlightCode("const a = 1;", "typescript", "dark", controller.signal);
      // Shiki loads its regex engine asynchronously, so a few microtasks cannot finish it.
      await flushQueue();
      controller.abort();
      // Rejecting (instead of resolving with HTML) means the check after initialization
      // skipped the highlight call.
      await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

      // The next request still runs after the aborted one.
      await expect(highlightCode("const b = 2;", "typescript", "dark")).resolves.toContain("<pre");
      const failureWarnings = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes("failed")
      );
      expect(failureWarnings).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("highlightWithBudget", () => {
  beforeEach(() => {
    __resetForTests();
  });

  it("returns the call's resolved HTML when it finishes within the budget", async () => {
    const onTimeout = jest.fn();
    const result = await highlightWithBudget(
      "const x = 1;",
      "typescript",
      "dark",
      () => Promise.resolve("<pre>resolved</pre>"),
      onTimeout,
      1000
    );

    expect(result).toBe("<pre>resolved</pre>");
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("throws and invokes onTimeout when the call exceeds the budget", async () => {
    const onTimeout = jest.fn();
    const pendingHighlight = neverResolves();

    await expect(
      highlightWithBudget("hang me", "typescript", "dark", () => pendingHighlight, onTimeout, 20)
    ).rejects.toThrow("HIGHLIGHT_TIMEOUT");

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("starts the time budget only when a queued call reaches the front", async () => {
    const onTimeout = jest.fn();
    let firstStarted = false;
    let secondStarted = false;

    const first = enqueueHighlightWithBudget(
      "bad",
      "typescript",
      "dark",
      () => {
        firstStarted = true;
        return neverResolves();
      },
      onTimeout,
      20
    );
    const second = enqueueHighlightWithBudget(
      "good",
      "typescript",
      "dark",
      () => {
        secondStarted = true;
        return Promise.resolve("<pre>good</pre>");
      },
      onTimeout,
      20
    );

    await flushQueue();
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(false);

    await expect(first).rejects.toThrow("HIGHLIGHT_TIMEOUT");
    await expect(second).resolves.toBe("<pre>good</pre>");
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("remembers timed-out inputs and short-circuits subsequent calls", async () => {
    const onTimeout = jest.fn();
    const callFn = jest.fn(() => neverResolves());

    // First call: hangs, times out, populates the cache.
    await expect(
      highlightWithBudget("pathological", "typescript", "dark", callFn, onTimeout, 20)
    ).rejects.toThrow("HIGHLIGHT_TIMEOUT");
    expect(callFn).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    // Same input again — must NOT call the underlying worker or fire another
    // terminate. This is the bug-prevention guarantee: replaying the same
    // pathological payload on every re-render must not chew through workers.
    await expect(
      highlightWithBudget("pathological", "typescript", "dark", callFn, onTimeout, 20)
    ).rejects.toThrow("HIGHLIGHT_TIMEOUT");
    expect(callFn).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not treat different inputs as previously timed out", async () => {
    const onTimeout = jest.fn();

    // First input blows the budget…
    await expect(
      highlightWithBudget("input-A", "typescript", "dark", () => neverResolves(), onTimeout, 20)
    ).rejects.toThrow("HIGHLIGHT_TIMEOUT");

    // …but a different input is still attempted (and can succeed).
    const result = await highlightWithBudget(
      "input-B",
      "typescript",
      "dark",
      () => Promise.resolve("<pre>B</pre>"),
      onTimeout,
      1000
    );
    expect(result).toBe("<pre>B</pre>");
    expect(onTimeout).toHaveBeenCalledTimes(1); // still just the one from input-A
  });

  it("keys the timed-out cache by language and theme", async () => {
    const onTimeout = jest.fn();
    const hang = () => neverResolves();

    await expect(
      highlightWithBudget("same code", "typescript", "dark", hang, onTimeout, 20)
    ).rejects.toThrow("HIGHLIGHT_TIMEOUT");

    // Same code, different language: must NOT be considered previously bad.
    // We expect the worker to be invoked again.
    const callFn = jest.fn(() => Promise.resolve("<pre>ok</pre>"));
    const result = await highlightWithBudget(
      "same code",
      "python",
      "dark",
      callFn,
      onTimeout,
      1000
    );
    expect(result).toBe("<pre>ok</pre>");
    expect(callFn).toHaveBeenCalledTimes(1);
  });

  it("propagates non-timeout errors without poisoning the cache", async () => {
    const onTimeout = jest.fn();

    await expect(
      highlightWithBudget(
        "crashy",
        "typescript",
        "dark",
        () => Promise.reject(new Error("boom")),
        onTimeout,
        100
      )
    ).rejects.toThrow("boom");

    // Non-timeout errors must NOT count as exceeding the budget — the input
    // itself might be fine and a fresh worker may succeed next time.
    expect(onTimeout).not.toHaveBeenCalled();

    const callFn = jest.fn(() => Promise.resolve("<pre>retry</pre>"));
    const result = await highlightWithBudget(
      "crashy",
      "typescript",
      "dark",
      callFn,
      onTimeout,
      100
    );
    expect(result).toBe("<pre>retry</pre>");
    expect(callFn).toHaveBeenCalledTimes(1);
  });

  it("populates the cache before invoking onTimeout (so synchronous follow-ups bail fast)", async () => {
    // The recycle callback in production tears down the worker. If a queued
    // re-render fires the same input synchronously from inside that callback,
    // it must see the cache hit immediately rather than triggering another
    // terminate.
    let cacheHitObservedInsideOnTimeout: boolean | null = null;

    const cacheProbes: Array<Promise<void>> = [];
    const onTimeout = jest.fn(() => {
      const cachedCall = jest.fn(() => neverResolves());
      cacheProbes.push(
        highlightWithBudget(
          "race",
          "typescript",
          "dark",
          cachedCall,
          () => {
            throw new Error("cache probe should short-circuit before timing out");
          },
          50
        ).then(
          () => {
            cacheHitObservedInsideOnTimeout = false;
          },
          () => {
            // Should reject quickly via cache hit without calling cachedCall.
            cacheHitObservedInsideOnTimeout = cachedCall.mock.calls.length === 0;
          }
        )
      );
    });

    await expect(
      highlightWithBudget("race", "typescript", "dark", () => neverResolves(), onTimeout, 20)
    ).rejects.toThrow("HIGHLIGHT_TIMEOUT");

    expect(cacheProbes).toHaveLength(1);
    await Promise.all(cacheProbes);
    expect(cacheHitObservedInsideOnTimeout).toBe(true);
  });
});

// #6292: the first job of a worker also waited for the worker to start (script load, Shiki's
// engine and the language's grammar). On a cold load that used up the 5 s budget, the input was
// marked as wedged, and it stayed plain text for the rest of the session.
describe("highlightCode worker start-up", () => {
  const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };
  const originalWorker = globalThis.Worker;
  /** This input never finishes highlighting (catastrophic backtracking). */
  const WEDGED = "wedged input";

  /** When the next fake worker starts: ms until it answers messages, or null for never. */
  let startDelays: Array<number | null> = [];
  let created: FakeWorker[] = [];

  /** A Worker that speaks Comlink over a real MessageChannel and starts after a delay. */
  class FakeWorker {
    readonly port: MessagePort;
    terminated = false;
    readonly highlighted: string[] = [];
    onerror: ((event: unknown) => void) | null = null;
    constructor() {
      const startDelay = startDelays.shift();
      if (startDelay === undefined) throw new Error("No start delay for this fake worker");
      const channel = new MessageChannel();
      this.port = channel.port1;
      created.push(this);
      const api = {
        prepare: () => Promise.resolve(),
        highlight: (code: string) => {
          this.highlighted.push(code);
          return new Promise<string>((resolve) => {
            if (code !== WEDGED) setTimeout(() => resolve(`<pre>${code}</pre>`), 10);
          });
        },
      };
      // Messages posted before the worker starts wait in the port, as they do for a real worker.
      if (startDelay !== null) setTimeout(() => Comlink.expose(api, channel.port2), startDelay);
    }
    postMessage(message: unknown, transfer: Transferable[] = []) {
      this.port.postMessage(message, transfer);
    }
    addEventListener(type: string, listener: EventListener) {
      this.port.addEventListener(type, listener);
    }
    removeEventListener(type: string, listener: EventListener) {
      this.port.removeEventListener(type, listener);
    }
    start() {
      this.port.start();
    }
    terminate() {
      this.terminated = true;
      this.port.close();
    }
  }

  /** Lets real MessageChannel deliveries (macrotasks) and their promise chains run. */
  async function deliverMessages(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /**
   * How `promise` settles while fake time advances by up to `ms`, in steps that each deliver the
   * messages they release. "pending" when it has not settled by then (never a hung test).
   */
  async function settleWithin<T>(promise: Promise<T>, ms: number) {
    let outcome: { value: T } | { error: string } | "pending" = "pending";
    promise.then(
      (value) => (outcome = { value }),
      (error: unknown) => (outcome = { error: String(error) })
    );
    await deliverMessages();
    for (let elapsed = 0; elapsed < ms && outcome === "pending"; elapsed += 50) {
      fakeTimers.advanceTimersByTime(Math.min(50, ms - elapsed));
      await deliverMessages();
    }
    return outcome;
  }

  let warnSpy: { mockRestore: () => void } | undefined;
  beforeEach(() => {
    startDelays = [];
    created = [];
    __resetForTests();
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    warnSpy?.mockRestore();
    __resetForTests();
    if (originalWorker === undefined) Reflect.deleteProperty(globalThis, "Worker");
    else globalThis.Worker = originalWorker;
  });

  it("a worker that starts slower than the budget still highlights the input", async () => {
    startDelays = [6_000];
    const outcome = await settleWithin(highlightCode("const a = 1;", "typescript", "dark"), 6_500);
    expect(outcome).toEqual({ value: "<pre>const a = 1;</pre>" });
    expect(created.map((w) => w.terminated)).toEqual([false]);

    // Not marked as wedged: the next render of the same input reaches the worker again.
    const again = await settleWithin(highlightCode("const a = 1;", "typescript", "dark"), 250);
    expect(again).toEqual({ value: "<pre>const a = 1;</pre>" });
    expect(created[0].highlighted).toEqual(["const a = 1;", "const a = 1;"]);
  });

  it("an input that wedges a warm worker ends it in 5 s and is skipped afterwards", async () => {
    startDelays = [0, 0];
    expect(await settleWithin(highlightCode("ok", "typescript", "dark"), 250)).toEqual({
      value: "<pre>ok</pre>",
    });

    const outcome = await settleWithin(highlightCode(WEDGED, "typescript", "dark"), 5_000);
    expect(outcome).toEqual({ error: "Error: HIGHLIGHT_TIMEOUT" });
    expect(created.map((w) => w.terminated)).toEqual([true]);

    // Marked: the next render fails fast, without a new worker.
    const again = await settleWithin(highlightCode(WEDGED, "typescript", "dark"), 250);
    expect(again).toEqual({ error: "Error: HIGHLIGHT_TIMEOUT" });
    expect(created).toHaveLength(1);
  });

  it("a worker that never starts is ended, and the next request gets a new worker", async () => {
    startDelays = [null, 0];
    const first = highlightCode("const a = 1;", "typescript", "dark");
    const queued = highlightCode("const b = 2;", "typescript", "dark");
    const outcome = await settleWithin(first, 30_000);
    expect(outcome).toEqual({ error: "Error: HIGHLIGHT_WORKER_START_TIMEOUT" });
    expect(created[0].terminated).toBe(true);

    // The queue moved on to a new worker.
    expect(await settleWithin(queued, 250)).toEqual({ value: "<pre>const b = 2;</pre>" });
    // The input was not marked: it highlights on the new worker.
    expect(await settleWithin(highlightCode("const a = 1;", "typescript", "dark"), 250)).toEqual({
      value: "<pre>const a = 1;</pre>",
    });
    expect(created).toHaveLength(2);
  });

  // DiffRenderer caches what highlightDiffChunks returns: a plain-text fallback would stay for
  // the session, so a worker that did not start must reject instead.
  it("a diff whose worker did not start rejects instead of returning a plain-text fallback", async () => {
    startDelays = [null];
    const chunks = groupDiffLines(["+const a = 1;"], 1, 1);
    const outcome = await settleWithin(highlightDiffChunks(chunks, "typescript", "dark"), 30_000);
    expect(outcome).toEqual({ error: "Error: HIGHLIGHT_WORKER_START_TIMEOUT" });
  });
});
