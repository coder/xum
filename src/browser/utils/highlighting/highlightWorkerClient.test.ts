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
  highlightWithBudget,
  enqueueHighlightWithBudget,
  __resetForTests,
} from "./highlightWorkerClient";

function neverResolves<T = string>(): Promise<T> {
  return new Promise<T>((resolve) => {
    void resolve;
  });
}

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
