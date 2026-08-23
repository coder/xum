import { describe, test, expect } from "@jest/globals";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import modelsJson from "./models.json";
import {
  findMissingKnownModels,
  pruneModelData,
  sanitizePricing,
  serializeModelData,
  summarizeCatalog,
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
  const usable = { max_input_tokens: 256000 };

  test("reports all curated models against an empty catalog and no overrides", () => {
    const missing = findMissingKnownModels({}, {});
    expect(missing.sort()).toEqual(
      Object.values(KNOWN_MODELS)
        .map((model) => model.id)
        .sort()
    );
  });

  test("any runtime-resolvable key form satisfies coverage, unrelated keys do not", () => {
    const grok = Object.values(KNOWN_MODELS).find((model) => model.provider === "xai");
    if (!grok) throw new Error("expected a curated xai model");

    // Coverage mirrors getModelStats' lookup keys: both the provider-prefixed
    // form LiteLLM uses for xAI and the bare fallback resolve at runtime.
    expect(findMissingKnownModels({ [`xai/${grok.providerModelId}`]: usable }, {})).not.toContain(
      grok.id
    );
    expect(findMissingKnownModels({ [grok.providerModelId]: usable }, {})).not.toContain(grok.id);
    expect(
      findMissingKnownModels({ [`unrelated/${grok.providerModelId}x`]: usable }, {})
    ).toContain(grok.id);
  });

  test("a retained key with unusable token limits still counts as missing", () => {
    const anthropic = Object.values(KNOWN_MODELS).find((model) => model.provider === "anthropic");
    if (!anthropic) throw new Error("expected a curated anthropic model");

    // Key presence is not coverage: getModelStats would reject these entries.
    expect(findMissingKnownModels({ [anthropic.providerModelId]: {} }, {})).toContain(anthropic.id);
    expect(
      findMissingKnownModels({ [anthropic.providerModelId]: { max_input_tokens: 0 } }, {})
    ).toContain(anthropic.id);
  });

  test("models-extra overrides satisfy models absent upstream", () => {
    const anthropic = Object.values(KNOWN_MODELS).find((model) => model.provider === "anthropic");
    if (!anthropic) throw new Error("expected a curated anthropic model");

    expect(findMissingKnownModels({}, { [anthropic.providerModelId]: usable })).not.toContain(
      anthropic.id
    );
  });
});

describe("validateModelData", () => {
  test("accepts the current vendored models.json against its own baseline", () => {
    const vendored = modelsJson as Record<string, Record<string, unknown>>;
    const sanitized = sanitizePricing(vendored);
    expect(sanitized.droppedModelIds).toEqual([]);
    expect(() => validateModelData(sanitized, summarizeCatalog(vendored))).not.toThrow();
  });

  test("rejects truncated upstream data", () => {
    expect(() => validateModelData({ catalog: chatEntries(10), droppedModelIds: [] })).toThrow(
      /only 10 usable chat\/responses models found/
    );
  });

  test("rejects a large shrink below the vendored baseline even above the floor", () => {
    // Cover every curated model so only the shrink rule is under test.
    const curatedCoverage = Object.fromEntries(
      Object.values(KNOWN_MODELS).map((model) => [
        model.providerModelId,
        { mode: "chat", max_input_tokens: 200000 },
      ])
    );
    const sanitized = {
      catalog: { ...chatEntries(600), ...curatedCoverage },
      droppedModelIds: [],
    };
    const baseline = (usableChat: number) => ({
      totalEntries: usableChat,
      modes: { chat: { usable: usableChat, inputPriced: 600, outputPriced: 600 } },
    });
    expect(() => validateModelData(sanitized, baseline(2000))).toThrow(
      /chat usable model count shrank from 2000/
    );
    // A small decrease within the bound is acceptable (e.g. upstream pruning).
    expect(() => validateModelData(sanitized, baseline(650))).not.toThrow();
  });

  test("rejects the loss of one pricing field even when the other survives", () => {
    // An upstream rename of just output_cost_per_token keeps every entry
    // input-priced, so aggregated priced coverage would hide the regression.
    const outputless = Object.fromEntries(
      Array.from({ length: 700 }, (_, i) => [
        `provider/outputless-${i}`,
        { mode: "chat", max_input_tokens: 128000, input_cost_per_token: 0.000001 },
      ])
    );
    const curatedCoverage = Object.fromEntries(
      Object.values(KNOWN_MODELS).map((model) => [
        model.providerModelId,
        { mode: "chat", max_input_tokens: 200000 },
      ])
    );
    const sanitized = { catalog: { ...outputless, ...curatedCoverage }, droppedModelIds: [] };
    expect(() =>
      validateModelData(sanitized, {
        totalEntries: 700,
        modes: { chat: { usable: 700, inputPriced: 680, outputPriced: 680 } },
      })
    ).toThrow(/chat output-priced model count shrank from 680/);
  });

  test("rejects pricing loss confined to a smaller mode", () => {
    // Stripping costs from every responses row barely moves aggregate priced
    // counts, so each mode compares against its own baseline.
    const pricedChat = Object.fromEntries(
      Array.from({ length: 700 }, (_, i) => [
        `provider/chat-${i}`,
        {
          mode: "chat",
          max_input_tokens: 128000,
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002,
        },
      ])
    );
    const unpricedResponses = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `provider/responses-${i}`,
        { mode: "responses", max_input_tokens: 128000 },
      ])
    );
    const curatedCoverage = Object.fromEntries(
      Object.values(KNOWN_MODELS).map((model) => [
        model.providerModelId,
        { mode: "chat", max_input_tokens: 200000 },
      ])
    );
    const sanitized = {
      catalog: { ...pricedChat, ...unpricedResponses, ...curatedCoverage },
      droppedModelIds: [],
    };
    expect(() =>
      validateModelData(sanitized, {
        totalEntries: 760,
        modes: {
          chat: { usable: 700, inputPriced: 700, outputPriced: 700 },
          responses: { usable: 60, inputPriced: 59, outputPriced: 59 },
        },
      })
    ).toThrow(/responses input-priced model count shrank from 59 to 0/);
  });

  test("rejects wholesale omission of a non-mappable mode", () => {
    // A partial payload that keeps chat/responses but drops image_generation
    // rows must trip that mode's own usable baseline.
    const curatedCoverage = Object.fromEntries(
      Object.values(KNOWN_MODELS).map((model) => [
        model.providerModelId,
        { mode: "chat", max_input_tokens: 200000 },
      ])
    );
    const sanitized = {
      catalog: { ...chatEntries(700), ...curatedCoverage },
      droppedModelIds: [],
    };
    expect(() =>
      validateModelData(sanitized, {
        totalEntries: 760,
        modes: {
          chat: { usable: 700, inputPriced: 700, outputPriced: 700 },
          image_generation: { usable: 300, inputPriced: 250, outputPriced: 0 },
        },
      })
    ).toThrow(/image_generation usable model count shrank from 300 to 0/);
  });

  test("rejects a catalog-wide loss of token limits even when pricing survives", () => {
    // Entries keep mode + pricing but lose max_input_tokens: getModelStats
    // rejects them, so usable coverage must register the collapse.
    const limitless = Object.fromEntries(
      Array.from({ length: 700 }, (_, i) => [
        `provider/limitless-${i}`,
        { mode: "chat", input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
      ])
    );
    const curatedCoverage = Object.fromEntries(
      Object.values(KNOWN_MODELS).map((model) => [
        model.providerModelId,
        { mode: "chat", max_input_tokens: 200000 },
      ])
    );
    const sanitized = { catalog: { ...limitless, ...curatedCoverage }, droppedModelIds: [] };
    expect(() =>
      validateModelData(sanitized, {
        totalEntries: 700,
        modes: { chat: { usable: 700, inputPriced: 680, outputPriced: 680 } },
      })
    ).toThrow(/chat usable model count shrank from 700/);
  });

  test("summarizes coverage per mode with the usability bar applied", () => {
    expect(
      summarizeCatalog({
        usableChat: {
          mode: "chat",
          max_input_tokens: 128000,
          input_cost_per_token: 0.000001,
        },
        usableResponses: {
          mode: "responses",
          max_input_tokens: 128000,
          input_cost_per_token: 0.000002,
          output_cost_per_token: 0.000008,
        },
        limitlessChat: { mode: "chat", input_cost_per_token: 0.000001 },
        embedding: { mode: "embedding", max_input_tokens: 8192, input_cost_per_token: 0.0000001 },
      })
    ).toEqual({
      totalEntries: 4,
      modes: {
        chat: { usable: 1, inputPriced: 2, outputPriced: 0 },
        responses: { usable: 1, inputPriced: 1, outputPriced: 1 },
        embedding: { usable: 1, inputPriced: 1, outputPriced: 0 },
      },
    });
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

describe("serializeModelData", () => {
  test("sorts keys so upstream reordering produces no diff", () => {
    const forward = serializeModelData({ b: { mode: "chat" }, a: { mode: "chat" } });
    const reversed = serializeModelData({ a: { mode: "chat" }, b: { mode: "chat" } });
    expect(forward).toBe(reversed);
    expect(forward.indexOf('"a"')).toBeLessThan(forward.indexOf('"b"'));
  });
});
