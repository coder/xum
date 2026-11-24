// Unit tests for the live-provider capacity rule (#4925). No provider API is called.
import {
  ProviderCapacityError,
  isProviderCapacityError,
  isProviderStall,
  retryOnProviderCapacity,
} from "./liveProviderCapacity";

const XAI_CAPACITY =
  "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing";

// The stream-error text in merge-queue runs 36502073443 and 36502113315 (#5128), where the
// live OpenAI web_search test hit it on every attempt.
const OPENAI_OVERLOADED = "Our servers are currently overloaded. Please try again later.";

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
    // OpenAI's overload sentence, as the backend classifies it before any output (a 503/500
    // APICallError -> server_error) and mid-stream (an unclassified provider error -> unknown).
    { error: OPENAI_OVERLOADED, errorType: "server_error", capacity: true },
    { error: OPENAI_OVERLOADED, errorType: "unknown", capacity: true },
    // Near misses must still fail: other 5xx text, a 4xx class, and "overloaded" that is not
    // the provider's whole message (for example quoted inside other output).
    {
      error: "The server had an error while processing your request.",
      errorType: "server_error",
      capacity: false,
    },
    { error: OPENAI_OVERLOADED, errorType: "api", capacity: false },
    { error: OPENAI_OVERLOADED, errorType: "authentication", capacity: false },
    {
      error: "The model said the network is overloaded today.",
      errorType: "unknown",
      capacity: false,
    },
    { error: `Tool output: "${OPENAI_OVERLOADED}"`, errorType: "unknown", capacity: false },
  ])("$errorType: $error -> $capacity", ({ error, errorType, capacity }) => {
    expect(isProviderCapacityError({ error, errorType })).toBe(capacity);
  });
});

describe("isProviderStall", () => {
  test.each([
    // The request left Mux and the provider never answered: a stall.
    { eventTypes: ["caught-up", "stream-start"], stall: true },
    // Nothing was sent: a Mux hang before the request, not the provider.
    { eventTypes: ["caught-up"], stall: false },
    { eventTypes: [], stall: false },
    // Output arrived, so a missing terminal event is Mux failing to finish the stream.
    { eventTypes: ["stream-start", "stream-delta"], stall: false },
    { eventTypes: ["stream-start", "reasoning-delta"], stall: false },
    { eventTypes: ["stream-start", "reasoning-end"], stall: false },
    { eventTypes: ["stream-start", "tool-call-start"], stall: false },
    { eventTypes: ["stream-start", "usage-delta"], stall: false },
  ])("$eventTypes -> $stall", ({ eventTypes, stall }) => {
    expect(isProviderStall(eventTypes)).toBe(stall);
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
