import { describe, expect, test } from "bun:test";
import { hostQuiet, InfraError, pairedDiffs, usefulPairs, withInfraRetry } from "./bootTimeline";

describe("hostQuiet", () => {
  test("needs load below 3/4 of the CPUs and CPU pressure below 10", () => {
    expect(hostQuiet(23.9, 9.9, 32)).toBe(true);
    expect(hostQuiet(24, 0, 32)).toBe(false);
    expect(hostQuiet(1, 10, 32)).toBe(false);
    expect(hostQuiet(1, Number.NaN, 32)).toBe(false); // unreadable PSI never counts as quiet
  });
});

describe("pairedDiffs", () => {
  test("pairs head with base by index and reports the extremes the gates read", () => {
    const r = pairedDiffs([1000, 2000, 3000], [1100, 1950, 3000]);
    expect(r.d).toEqual([100, -50, 0]);
    expect([r.minD, r.maxD, r.maxAbsD]).toEqual([-50, 100, 100]);
  });

  test("rejects unequal arms, single pairs and missing values", () => {
    expect(() => pairedDiffs([1, 2], [1])).toThrow();
    expect(() => pairedDiffs([1], [1])).toThrow();
    expect(() => pairedDiffs([1, 2], [1, Number.NaN])).toThrow();
  });
});

describe("usefulPairs", () => {
  test("uses LCP only for pairs where both arms have it, else DOM for both arms", () => {
    const r = usefulPairs(
      [
        { lcpMs: 110, domMs: 100 },
        { lcpMs: 210, domMs: 200 },
      ],
      [
        { lcpMs: 120, domMs: 105 },
        { lcpMs: null, domMs: 190 },
      ]
    );
    expect(r).toEqual({ source: ["lcp", "dom"], base: [110, 200], head: [120, 190] });
  });
});

describe("withInfraRetry", () => {
  const failing = (errors: Error[]) => {
    let calls = 0;
    const run = () => {
      const error = errors[calls++];
      return error ? Promise.reject(error) : Promise.resolve({ ok: true });
    };
    return { run, calls: () => calls };
  };

  test("retries an infrastructure failure once and reports the attempt count", async () => {
    const block = failing([new InfraError("server exited")]);
    expect(await withInfraRetry(block.run, () => {})).toEqual({ attempts: 2, ok: true });
    expect(block.calls()).toBe(2);
  });

  test("fails at once on an assertion, and after a second infrastructure failure", async () => {
    const assertion = failing([new Error("service worker active")]);
    await expect(withInfraRetry(assertion.run, () => {})).rejects.toThrow("service worker active");
    const twice = failing([new InfraError("busy"), new InfraError("busy again")]);
    await expect(withInfraRetry(twice.run, () => {})).rejects.toThrow("busy again");
    expect([assertion.calls(), twice.calls()]).toEqual([1, 2]);
  });
});
