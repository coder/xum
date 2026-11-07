import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getTotalCost } from "@/common/utils/tokens/usageAggregator";
import type { AiSdkUsageLike } from "@/common/utils/tokens/usageHelpers";
import { createSpendMeter, stepCostUsd } from "./memoryDreamSpend";
import { SessionUsageService } from "./sessionUsageService";
import { createTestHistoryService } from "./testHistoryService";

// $2 per million input tokens and $10 per million output tokens, with a Fast (priority) tier that
// bills at twice the Standard rates.
const OPENAI_MODEL = "openai:gpt-6.1-sol";
const ANTHROPIC_MODEL = "anthropic:claude-sonnet-5-5";

const usage = (input: number, output: number, cacheWrite = 0): AiSdkUsageLike => ({
  inputTokens: input,
  outputTokens: output,
  inputTokenDetails: {
    noCacheTokens: input - cacheWrite,
    cacheReadTokens: 0,
    cacheWriteTokens: cacheWrite,
  },
  outputTokenDetails: { textTokens: output, reasoningTokens: 0 },
});

describe("stepCostUsd", () => {
  let service: SessionUsageService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const history = await createTestHistoryService();
    service = new SessionUsageService(history.config, history.historyService);
    cleanup = history.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  /** What the app records, and so shows as the cost, for the same usage. */
  async function recordedCostUsd(
    model: string,
    stepUsage: AiSdkUsageLike,
    providerMetadata?: Record<string, unknown>
  ): Promise<number | undefined> {
    const recorded = await service.recordHeadlessUsage(
      "ws-spend",
      model,
      stepUsage,
      providerMetadata,
      {
        metadataModel: model,
      }
    );
    return getTotalCost(recorded?.usage);
  }

  it("prices a step at the standard rates", () => {
    // 250k input tokens at $2/M and 10k output tokens at $10/M.
    expect(stepCostUsd({ usage: usage(250_000, 10_000) }, OPENAI_MODEL)).toBeCloseTo(0.6, 9);
  });

  it.each([
    ["a standard step", OPENAI_MODEL, usage(250_000, 10_000), undefined],
    [
      "a step the provider billed at the priority tier",
      OPENAI_MODEL,
      usage(250_000, 10_000),
      { openai: { serviceTier: "priority" } },
    ],
    [
      "a step that wrote its prompt to Anthropic's cache",
      ANTHROPIC_MODEL,
      usage(120_000, 3_000, 100_000),
      undefined,
    ],
    [
      "an Anthropic step the provider ran in fast mode",
      ANTHROPIC_MODEL,
      usage(120_000, 3_000, 100_000),
      { anthropic: { usage: { speed: "fast" } } },
    ],
    [
      "an xAI step with the exact amount xAI billed",
      "xai:grok-4.7",
      usage(100_000, 2_000),
      { xai: { costInUsdTicks: 123_000_000 } },
    ],
  ])(
    "prices %s as the app prices its recorded usage",
    async (_label, model, stepUsage, metadata) => {
      const recorded = await recordedCostUsd(model, stepUsage, metadata);

      expect(recorded).toBeGreaterThan(0);
      expect(stepCostUsd({ usage: stepUsage, providerMetadata: metadata }, model)).toBeCloseTo(
        recorded ?? NaN,
        12
      );
    }
  );

  it("bills the priority tier at twice the standard rates, the tier the provider reports", () => {
    const standard = stepCostUsd({ usage: usage(250_000, 10_000) }, OPENAI_MODEL);
    const priority = stepCostUsd(
      { usage: usage(250_000, 10_000), providerMetadata: { openai: { serviceTier: "priority" } } },
      OPENAI_MODEL
    );

    // NaN if the standard step had no price: the comparison then fails, as it should.
    expect(priority).toBeCloseTo(2 * (standard ?? Number.NaN), 9);
  });

  it("has no cost for a model with no known price, and a cost of zero for a priced step with no tokens", () => {
    expect(stepCostUsd({ usage: usage(250_000, 10_000) }, "ollama:no-such-model")).toBeUndefined();
    expect(stepCostUsd({ usage: usage(250_000, 10_000) }, undefined)).toBeUndefined();
    expect(stepCostUsd({ usage: usage(0, 0) }, OPENAI_MODEL)).toBe(0);
  });
});

describe("createSpendMeter", () => {
  const stepOf = (input: number) => ({ usage: usage(input, 0) });

  it("measures without a ceiling and never stops", () => {
    const meter = createSpendMeter({ pricingModel: OPENAI_MODEL });
    for (let step = 0; step < 100; step++) meter.recordStep(stepOf(250_000));

    expect(meter.spentUsd()).toBeCloseTo(50, 9);
    expect(meter.stopIfCeilingReached()).toBe(false);
    expect(meter.note()).toBeUndefined();
  });

  it("stops once spend reaches the ceiling, not before, and says where", () => {
    const meter = createSpendMeter({ pricingModel: OPENAI_MODEL, ceilingUsd: 1 });
    meter.recordStep(stepOf(250_000));
    expect(meter.stopIfCeilingReached()).toBe(false);
    expect(meter.note()).toBeUndefined();

    meter.recordStep(stepOf(250_000));

    // $0.50 + $0.50: reaching the ceiling exactly stops.
    expect(meter.stopIfCeilingReached()).toBe(true);
    expect(meter.note()).toBe("stopped at the cost ceiling after $1.00");
  });

  it("says the ceiling is not enforced once a step of a model with no known price ran", () => {
    const meter = createSpendMeter({ pricingModel: "ollama:no-such-model", ceilingUsd: 1 });
    expect(meter.note()).toBeUndefined();

    for (let step = 0; step < 100; step++) meter.recordStep(stepOf(250_000));

    // Every step counted as $0: the ceiling can never be reached, and the note says so.
    expect(meter.stopIfCeilingReached()).toBe(false);
    expect(meter.note()).toBe("price unknown, ceiling not enforced");
  });

  it("makes no unknown-price note without a ceiling, or for a known price", () => {
    const unpriced = createSpendMeter({ pricingModel: "ollama:no-such-model" });
    unpriced.recordStep(stepOf(250_000));
    const priced = createSpendMeter({ pricingModel: OPENAI_MODEL, ceilingUsd: 1 });
    priced.recordStep(stepOf(0));

    expect(unpriced.note()).toBeUndefined();
    expect(priced.note()).toBeUndefined();
  });

  it("carries the spend of earlier attempts", () => {
    const meter = createSpendMeter({ pricingModel: OPENAI_MODEL, ceilingUsd: 1, spentUsd: 0.75 });
    expect(meter.stopIfCeilingReached()).toBe(false);

    meter.recordStep(stepOf(125_000));

    expect(meter.spentUsd()).toBeCloseTo(1, 9);
    expect(meter.stopIfCeilingReached()).toBe(true);
  });
});
