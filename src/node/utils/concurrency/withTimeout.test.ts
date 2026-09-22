import { afterEach, describe, expect, it, vi } from "bun:test";

import { raceWithAbortAndTimeout } from "./withTimeout";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("raceWithAbortAndTimeout", () => {
  it("returns a resolved value and clears the timeout", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const result = await raceWithAbortAndTimeout(Promise.resolve("done"), { timeoutMs: 1000 });

    expect(result).toEqual({ kind: "ok", value: "done" });
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("returns timeout when the deadline expires", async () => {
    const result = await raceWithAbortAndTimeout(new Promise<never>(() => undefined), {
      timeoutMs: 1,
    });

    expect(result).toEqual({ kind: "timeout" });
  });

  it.each(["pre-abort", "abort", "timeout"] as const)(
    "observes a late rejection after %s",
    async (mode) => {
      const controller = new AbortController();
      const read = Promise.withResolvers<string>();
      if (mode === "pre-abort") controller.abort();

      const result = raceWithAbortAndTimeout(read.promise, {
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 1 : undefined,
      });
      if (mode === "abort") controller.abort();
      expect(await result).toEqual({ kind: mode === "timeout" ? "timeout" : "aborted" });
      read.reject(new Error("Read failed after cancellation"));
      // Let the runtime report any unhandled rejection before this test completes.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  );

  it.each(["resolved", "rejected"] as const)(
    "keeps pre-abort precedence over an already %s read without arming resources",
    async (state) => {
      const controller = new AbortController();
      controller.abort();
      const listenerSpy = vi.spyOn(controller.signal, "addEventListener");
      const timerSpy = vi.spyOn(globalThis, "setTimeout");
      const read =
        state === "resolved" ? Promise.resolve("done") : Promise.reject(new Error("read"));

      expect(
        await raceWithAbortAndTimeout(read, { signal: controller.signal, timeoutMs: 1000 })
      ).toEqual({ kind: "aborted" });
      expect(listenerSpy).not.toHaveBeenCalled();
      expect(timerSpy).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  );

  it.each([new Error("read failed"), "read failed"])(
    "propagates an ordinary rejection (%s)",
    async (reason) => {
      const read = Promise.withResolvers<never>();
      const result = raceWithAbortAndTimeout(read.promise, {});
      read.reject(reason);
      const error = await result.catch((error: unknown) => error);
      expect(error).toEqual(new Error("read failed"));
    }
  );

  it("returns aborted when the signal aborts", async () => {
    const controller = new AbortController();
    const resultPromise = raceWithAbortAndTimeout(new Promise<never>(() => undefined), {
      signal: controller.signal,
      timeoutMs: 1000,
    });

    controller.abort();

    expect(await resultPromise).toEqual({ kind: "aborted" });
  });
});
