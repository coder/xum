import { describe, expect, test } from "bun:test";
import {
  evaluateStepBudget,
  getContextBudgetHandoffPoint,
  getContextBudgetHardCeiling,
} from "@/common/utils/compaction/contextBudget";
import {
  getAutoCompactionLabel,
  getEffectiveThreshold,
  type AutoCompactionConfig,
} from "./ThresholdSlider";

function rolloverConfig(threshold: number): AutoCompactionConfig {
  return { threshold, rolloverEnabled: true, setThreshold: () => undefined };
}

function displayedThreshold(config: AutoCompactionConfig): number {
  const percentage = /(\d+)%/.exec(getAutoCompactionLabel(config))?.[1];
  expect(percentage).toBeDefined();
  return Number(percentage);
}

function evaluateAt(
  contextTokens: number,
  config: AutoCompactionConfig,
  options: { modelContextLimit?: number; handoffRequested?: boolean } = {}
) {
  return evaluateStepBudget({
    contextTokens,
    outputTokens: 0,
    toolResultChars: 0,
    imageParts: 0,
    modelContextLimit: options.modelContextLimit ?? 1_000_000,
    // Both backend callers clamp the stored slider value the same way before syncing it.
    threshold: getEffectiveThreshold(config) / 100,
    warningEmitted: true,
    handoffRequested: options.handoffRequested ?? false,
  });
}

describe("automatic context threshold labels", () => {
  test("the advertised percentage is the evaluator's handoff target, not a forced point", () => {
    for (const threshold of [50, 70, 90]) {
      const config = rolloverConfig(threshold);
      const handoffTokens = (displayedThreshold(config) / 100) * 1_000_000;
      expect(evaluateAt(handoffTokens - 1, config).decision).toBe("continue");
      expect(evaluateAt(handoffTokens, config).decision).toBe("handoff");
      // Ignoring the request never forces anything below the usable hard ceiling.
      const hardCeiling = getContextBudgetHardCeiling(1_000_000);
      expect(evaluateAt(hardCeiling - 1, config, { handoffRequested: true }).decision).toBe(
        "continue"
      );
      expect(evaluateAt(hardCeiling, config, { handoffRequested: true }).decision).toBe("rollover");
    }
  });

  test("a stored value below the effective minimum is shown and evaluated as that minimum", () => {
    const modelContextLimit = 128_000;
    for (const stored of [0, 5]) {
      const config = rolloverConfig(stored);
      expect(displayedThreshold(config)).toBe(10);
      expect(
        getContextBudgetHandoffPoint(modelContextLimit, getEffectiveThreshold(config) / 100)
      ).toBe(12_800);
      expect(evaluateAt(12_799, config, { modelContextLimit }).decision).toBe("continue");
      expect(evaluateAt(12_800, config, { modelContextLimit }).decision).toBe("handoff");
    }
    // Values at or above the minimum are displayed unchanged.
    expect(displayedThreshold(rolloverConfig(10))).toBe(10);
    expect(displayedThreshold(rolloverConfig(15))).toBe(15);
  });

  test("a smaller model's hard ceiling can precede the advertised target", () => {
    const config = rolloverConfig(90);
    const modelContextLimit = 16_384;
    const evaluation = evaluateAt(getContextBudgetHardCeiling(modelContextLimit), config, {
      modelContextLimit,
    });
    expect(evaluation.decision).toBe("rollover");
    expect((evaluation.projected / modelContextLimit) * 100).toBeLessThan(
      displayedThreshold(config)
    );
  });

  test.each([false, undefined])(
    "legacy compaction keeps the configured threshold (%s)",
    (rolloverEnabled) => {
      for (const threshold of [5, 50, 70, 90]) {
        const config = { threshold, rolloverEnabled, setThreshold: () => undefined };
        expect(displayedThreshold(config)).toBe(threshold);
        expect(getEffectiveThreshold(config)).toBe(threshold);
      }
    }
  );

  test.each([true, false])("off has no advertised threshold (%s)", (rolloverEnabled) => {
    const config = { threshold: 100, rolloverEnabled, setThreshold: () => undefined };
    expect(getAutoCompactionLabel(config)).not.toMatch(/\d+%/);
    // Off disables automatic rollover, not the token-budget hard ceiling.
    const hardCeiling = getContextBudgetHardCeiling(1_000_000);
    expect(evaluateAt(hardCeiling - 1, config).decision).toBe("continue");
    expect(evaluateAt(hardCeiling, config).decision).toBe("block");
  });
});
