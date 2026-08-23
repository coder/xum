import { describe, test, expect } from "@jest/globals";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import modelsJson from "./models.json";
import {
  findMissingKnownModels,
  pruneModelData,
  sanitizePricing,
  validateModelData,
} from "./updateModelsData";

function chatEntries(count: number): Record<string, Record<string, unknown>> {
  const entries: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < count; i++) {
    entries[`provider/model-${i}`] = {
      mode: "chat",
      max_input_tokens: 128000,
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
    };
  }
  return entries;
}

describe("pruneModelData", () => {
  test("rejects non-object payloads", () => {
    expect(() => pruneModelData(null)).toThrow("Expected LiteLLM model metadata object");
    expect(() => pruneModelData([1, 2])).toThrow("Expected LiteLLM model metadata object");
  });

  test("keeps only retained fields and drops non-object entries", () => {
    const pruned = pruneModelData({
      "provider/model-a": {
        max_input_tokens: 1000,
        input_cost_per_token: 0.001,
        litellm_provider: "provider",
        source: "https://example.com",
        deprecation_date: "2027-01-01",
      },
      bogus: "not-an-object",
    });

    expect(pruned["provider/model-a"]).toEqual({
      max_input_tokens: 1000,
      input_cost_per_token: 0.001,
      litellm_provider: "provider",
    });
    expect(pruned.bogus).toBeUndefined();
  });
});

describe("sanitizePricing", () => {
  test("drops entries whose present cost fields are unusable", () => {
    const { catalog, droppedModelIds } = sanitizePricing({
      good: { input_cost_per_token: 0.001, output_cost_per_token: 0 },
      // Subscription providers legitimately omit costs entirely.
      "no-costs": { max_input_tokens: 1000 },
      negative: { input_cost_per_token: -0.001 },
      "not-a-number": { output_cost_per_token: "0.001" },
      infinite: { cache_read_input_token_cost: Number.POSITIVE_INFINITY },
    });

    expect(Object.keys(catalog).sort()).toEqual(["good", "no-costs"]);
    expect(droppedModelIds.sort()).toEqual(["infinite", "negative", "not-a-number"]);
  });
});

describe("findMissingKnownModels", () => {
  test("reports all curated models against an empty catalog and no overrides", () => {
    const missing = findMissingKnownModels({}, {});
    expect(missing.sort()).toEqual(
      Object.values(KNOWN_MODELS)
        .map((model) => model.id)
        .sort()
    );
  });

  test("provider-prefixed lookups satisfy xai models while bare keys do not", () => {
    const grok = Object.values(KNOWN_MODELS).find((model) => model.provider === "xai");
    if (!grok) throw new Error("expected a curated xai model");

    const bareKey = { [grok.providerModelId]: {} };
    expect(findMissingKnownModels(bareKey, {})).toContain(grok.id);

    const prefixedKey = { [`xai/${grok.providerModelId}`]: {} };
    expect(findMissingKnownModels(prefixedKey, {})).not.toContain(grok.id);
  });

  test("models-extra overrides satisfy models absent upstream", () => {
    const anthropic = Object.values(KNOWN_MODELS).find((model) => model.provider === "anthropic");
    if (!anthropic) throw new Error("expected a curated anthropic model");

    expect(findMissingKnownModels({}, { [anthropic.providerModelId]: {} })).not.toContain(
      anthropic.id
    );
  });
});

describe("validateModelData", () => {
  test("accepts the current vendored models.json", () => {
    const sanitized = sanitizePricing(modelsJson as Record<string, Record<string, unknown>>);
    expect(sanitized.droppedModelIds).toEqual([]);
    expect(() => validateModelData(sanitized)).not.toThrow();
  });

  test("rejects truncated upstream data", () => {
    expect(() => validateModelData({ catalog: chatEntries(10), droppedModelIds: [] })).toThrow(
      /only 10 chat models found/
    );
  });

  test("rejects data where too many entries had invalid pricing", () => {
    // 100 dropped out of 700 total (14%) exceeds the 5% abort threshold.
    const dropped = Array.from({ length: 100 }, (_, i) => `dropped-${i}`);
    expect(() =>
      validateModelData({ catalog: chatEntries(600), droppedModelIds: dropped })
    ).toThrow(/entries have invalid pricing/);
  });

  test("rejects data missing curated known models", () => {
    // A large catalog that satisfies the size floor but carries none of the
    // curated model keys that models-extra does not already cover.
    expect(() => validateModelData({ catalog: chatEntries(600), droppedModelIds: [] })).toThrow(
      /curated known models missing from upstream/
    );
  });
});
