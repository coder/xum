// Unit tests for the live-provider capacity rule (#4925). No provider API is called.
import {
  ProviderCapacityError,
  isProviderCapacityError,
  retryOnProviderCapacity,
} from "./liveProviderCapacity";

const XAI_CAPACITY =
  "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing";

describe("isProviderCapacityError", () => {
  test.each([
    { error: XAI_CAPACITY, errorType: "unknown", capacity: true },
    { error: XAI_CAPACITY, errorType: "api", capacity: true },
    { error: "Too many requests", errorType: "rate_limit", capacity: true },
    { error: "Service Unavailable", errorType: "server_error", capacity: true },
    {
      error: "Anthropic is temporarily overloaded (HTTP 529). Please try again later.",
      errorType: "server_error",
      capacity: true,
    },
    // A billing 429 is classified as quota and must fail, not skip.
    { error: "You exceeded your current quota", errorType: "quota", capacity: false },
    { error: "Internal Server Error", errorType: "server_error", capacity: false },
    // The 503/529 wording counts only when the backend classified a 5xx.
    { error: "Service Unavailable", errorType: "api", capacity: false },
    { error: "terminated", errorType: "network", capacity: false },
    { error: "Invalid reasoning replay", errorType: "reasoning_rejected", capacity: false },
  ])("$errorType: $error -> $capacity", ({ error, errorType, capacity }) => {
    expect(isProviderCapacityError({ error, errorType })).toBe(capacity);
  });
});

describe("retryOnProviderCapacity", () => {
  function harness() {
    const sleeps: number[] = [];
    const reports: string[] = [];
    return {
      sleeps,
      reports,
      options: {
        backoffMs: [20_000, 40_000],
        sleep: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        report: (line: string) => reports.push(line),
      },
    };
  }

  test("retries capacity errors with backoff and runs the check once capacity returns", async () => {
    const h = harness();
    let attempts = 0;
    const outcome = await retryOnProviderCapacity(
      "Grok check",
      () => {
        attempts += 1;
        if (attempts < 3) throw new ProviderCapacityError(XAI_CAPACITY);
        return Promise.resolve();
      },
      h.options
    );

    expect(outcome).toBe("ran");
    expect(attempts).toBe(3);
    expect(h.sleeps).toEqual([20_000, 40_000]);
    expect(h.reports).toEqual([]);
  });

  test("reports a visible skip when every attempt hits capacity", async () => {
    const h = harness();
    let attempts = 0;
    const outcome = await retryOnProviderCapacity(
      "Grok check",
      () => {
        attempts += 1;
        throw new ProviderCapacityError(`${XAI_CAPACITY}\nsecond line`);
      },
      h.options
    );

    expect(outcome).toBe("skipped");
    expect(attempts).toBe(3);
    expect(h.sleeps).toEqual([20_000, 40_000]);
    expect(h.reports).toHaveLength(1);
    // One GitHub annotation line: a raw newline would end the annotation early.
    expect(h.reports[0]).toMatch(/^::warning /);
    expect(h.reports[0]).not.toContain("\n");
    expect(h.reports[0]).toContain("Grok check");
    expect(h.reports[0]).toContain("currently at capacity");
  });

  test("fails at once on any other error, including a missing terminal event", async () => {
    const h = harness();
    let attempts = 0;
    await expect(
      retryOnProviderCapacity(
        "Grok check",
        () => {
          attempts += 1;
          throw new Error("Expected terminal stream event from Grok 4.7");
        },
        h.options
      )
    ).rejects.toThrow("Expected terminal stream event from Grok 4.7");

    expect(attempts).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  test("a regression after a capacity retry still fails", async () => {
    const h = harness();
    let attempts = 0;
    await expect(
      retryOnProviderCapacity(
        "Grok check",
        () => {
          attempts += 1;
          if (attempts === 1) throw new ProviderCapacityError(XAI_CAPACITY);
          throw new Error("expected costInUsdTicks to be a number");
        },
        h.options
      )
    ).rejects.toThrow("costInUsdTicks");

    expect(attempts).toBe(2);
    expect(h.reports).toEqual([]);
  });
});
