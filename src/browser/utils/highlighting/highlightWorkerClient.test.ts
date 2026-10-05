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

import {
  highlightCode,
  highlightWithBudget,
  enqueueHighlightWithBudget,
  __resetForTests,
} from "./highlightWorkerClient";

// Only the main-thread fallback test below uses Shiki. The fake lets it hold the highlighter's
// initialization open and observe whether the actual highlight call runs.
const mockShiki = {
  releaseInit: (): void => undefined,
  codeToHtml: jest.fn(
    (code: string) => `<pre><code><span class="line">${code}</span></code></pre>`
  ),
};
jest.mock("shiki", () => ({
  createHighlighter: () =>
    new Promise((resolve) => {
      mockShiki.releaseInit = () =>
        resolve({
          getLoadedLanguages: () => ["typescript"],
          loadLanguage: () => Promise.resolve(),
          codeToHtml: mockShiki.codeToHtml,
        });
    }),
}));

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
  beforeEach(() => {
    __resetForTests();
    mockShiki.codeToHtml.mockClear();
  });

  it("skips the highlight when the caller aborts during initialization, without warning", async () => {
    // Jest has no Worker, so highlightCode uses the main-thread fallback, whose Shiki
    // initialization is the await that the caller aborts during.
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const controller = new AbortController();
      const aborted = highlightCode("const a = 1;", "typescript", "dark", controller.signal);
      await flushQueue();
      controller.abort();
      mockShiki.releaseInit();
      await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
      expect(mockShiki.codeToHtml).not.toHaveBeenCalled();

      // The next request still runs after the aborted one.
      await expect(highlightCode("const b = 2;", "typescript", "dark")).resolves.toContain(
        "const b = 2;"
      );
      expect(mockShiki.codeToHtml).toHaveBeenCalledTimes(1);
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

    await Promise.resolve();
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
