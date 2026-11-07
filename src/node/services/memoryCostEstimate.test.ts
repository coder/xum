import { describe, expect, it } from "bun:test";

import { defaultModel } from "@/common/utils/ai/models";
import {
  checkCostCeiling,
  estimateAnalyzerUpperBoundUsd,
  estimateOrganizerUpperBoundUsd,
} from "./memoryCostEstimate";

const UNPRICED_MODEL = "ollama:no-such-model";

describe("estimateAnalyzerUpperBoundUsd", () => {
  const priced = (chunkInputChars: number[], memoryChars = 0) =>
    estimateAnalyzerUpperBoundUsd({ pricingModel: defaultModel, chunkInputChars, memoryChars });

  it("costs a job of two chunks as the two chunks run apart", () => {
    expect(priced([8_000, 20_000])).toBeCloseTo((priced([8_000]) ?? 0) + (priced([20_000]) ?? 0));
  });

  it("grows with the memory a step may read and with the size of the chunk", () => {
    const base = priced([8_000]) ?? 0;
    expect(base).toBeGreaterThan(0);
    expect(priced([8_000], 100_000) ?? 0).toBeGreaterThan(base);
    expect(priced([40_000]) ?? 0).toBeGreaterThan(base);
  });

  it("has no estimate for a model with no known price", () => {
    expect(
      estimateAnalyzerUpperBoundUsd({
        pricingModel: UNPRICED_MODEL,
        chunkInputChars: [8_000],
        memoryChars: 0,
      })
    ).toBeUndefined();
  });
});

describe("estimateOrganizerUpperBoundUsd", () => {
  it("grows with the memory the run may read", () => {
    const estimate = (memoryChars: number) =>
      estimateOrganizerUpperBoundUsd({
        pricingModel: defaultModel,
        systemPromptChars: 5_000,
        memoryChars,
      }) ?? 0;
    expect(estimate(0)).toBeGreaterThan(0);
    expect(estimate(100_000)).toBeGreaterThan(estimate(0));
  });
});

describe("checkCostCeiling", () => {
  it("allows every run when no ceiling is set, even one with no estimate", () => {
    for (const estimatedUsd of [0.5, 1_000, undefined]) {
      expect(
        checkCostCeiling({ ceilingUsd: undefined, estimatedUsd, pricingModel: UNPRICED_MODEL })
      ).toEqual({ allowed: true });
    }
  });

  it("allows an estimate at or under the ceiling", () => {
    for (const estimatedUsd of [0.4, 1]) {
      expect(checkCostCeiling({ ceilingUsd: 1, estimatedUsd, pricingModel: defaultModel })).toEqual(
        {
          allowed: true,
        }
      );
    }
  });

  it("refuses an estimate over the ceiling with both amounts in the reason", () => {
    const check = checkCostCeiling({
      ceilingUsd: 1,
      estimatedUsd: 3.199,
      pricingModel: defaultModel,
    });
    expect(check.allowed).toBe(false);
    // Rounded up, so a refusal never prints the estimate as equal to the ceiling.
    if (!check.allowed) expect(check.reason).toContain("estimate 3.20 USD");
    if (!check.allowed) expect(check.reason).toContain("over the 1.00 USD ceiling");
  });

  it("refuses a model with no known price once a ceiling is set, and names the model", () => {
    const check = checkCostCeiling({
      ceilingUsd: 1,
      estimatedUsd: undefined,
      pricingModel: UNPRICED_MODEL,
    });
    expect(check.allowed).toBe(false);
    if (!check.allowed) expect(check.reason).toContain(UNPRICED_MODEL);
  });
});
