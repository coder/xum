import { describe, expect, test } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { isValidProvider } from "@/common/constants/providers";
import { listModelCatalogIds } from "./modelCatalog";
import { searchModelCatalog } from "./modelCatalogSearch";
import { getModelStats } from "./modelStats";

describe("searchModelCatalog", () => {
  test("offers only addable Xum providers, mapping LiteLLM aliases", () => {
    const { models } = searchModelCatalog({});
    const providers = new Set(models.map((model) => model.provider));
    for (const provider of providers) {
      expect(isValidProvider(provider)).toBe(true);
    }
    // Catalogue rows keyed github_copilot/<model> become addable github-copilot models.
    expect(listModelCatalogIds().some((id) => id.startsWith("github_copilot:"))).toBe(true);
    expect(providers.has("github-copilot")).toBe(true);
    // Every built-in is present exactly once and flagged.
    for (const known of Object.values(KNOWN_MODELS)) {
      const matches = models.filter((model) => model.id === known.id);
      expect(matches.map((model) => [model.builtIn, model.providerModelId])).toEqual([
        [true, known.providerModelId],
      ]);
    }
  });

  test("every token must match; provider display names and aliases count", () => {
    const fable = searchModelCatalog({ query: "fable" }).models.map((model) => model.id);
    // Bedrock/Vertex copies use non-Xum provider names and are not addable.
    expect(fable).toEqual(["anthropic:claude-fable-5-1", "anthropic:claude-fable-5"]);

    // "Anthropic" matches the provider, "fable" the model: both are required.
    expect(searchModelCatalog({ query: "ANTHROPIC  fable" }).total).toBe(2);
    expect(searchModelCatalog({ query: "openai fable" }).total).toBe(0);
    expect(searchModelCatalog({ query: "fable", provider: "openai" }).total).toBe(0);
    // "Z.ai" only appears in the provider display name, never in the zai ids.
    const zai = searchModelCatalog({ query: "z.ai" }).models;
    expect(zai.length).toBeGreaterThan(0);
    expect(zai.every((model) => model.provider === "zai")).toBe(true);

    // Aliases only exist on built-ins.
    const opus = KNOWN_MODELS.OPUS;
    const aliasHits = searchModelCatalog({ query: opus.aliases?.[0] }).models;
    expect(aliasHits[0]?.id).toBe(opus.id);
  });

  test("offers LiteLLM Gemini API models as google models", () => {
    const models = searchModelCatalog({ query: "gemini flash" }).models;
    const byId = new Map(models.map((model) => [model.id, model]));
    // Listed only as gemini/<model> in LiteLLM.
    expect(byId.get("google:gemini-flash-latest")?.builtIn).toBe(false);
    // Only reachable via its Vertex bare key because models-extra overrides it.
    expect(byId.get("google:gemini-3.7-flash")).toMatchObject({
      builtIn: false,
      contextWindowTokens: getModelStats("google:gemini-3.7-flash")?.max_input_tokens,
    });
    // Vertex-only models are not served by the Gemini API.
    expect(listModelCatalogIds()).toContain("vertex_ai-language-models:medlm-large");
    expect(searchModelCatalog({ query: "medlm" }).total).toBe(0);
  });

  test("offers LiteLLM Moonshot models as moonshotai models", () => {
    const litellmIds = listModelCatalogIds().filter((id) => id.startsWith("moonshot:"));
    expect(litellmIds.length).toBeGreaterThan(0);
    const offered = new Set(
      searchModelCatalog({ provider: "moonshotai" }).models.map((model) => model.providerModelId)
    );
    for (const id of litellmIds) {
      expect(offered.has(id.slice("moonshot:".length))).toBe(true);
    }
  });

  test("ranks exact model ids above prefix matches before preferring built-ins", () => {
    const ids = searchModelCatalog({ query: "claude-fable-5" }).models.map((model) => model.id);
    // The exact legacy id outranks the built-in successor that only prefix-matches.
    expect(ids).toEqual(["anthropic:claude-fable-5", "anthropic:claude-fable-5-1"]);
  });

  test("lists newer versions first within a rank tier", () => {
    const ids = searchModelCatalog({ query: "gemini flash" }).models.map((model) => model.id);
    const order = [
      "google:gemini-3.7-flash",
      "google:gemini-2.5-flash",
      "google:gemini-2.0-flash",
    ].map((id) => ids.indexOf(id));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // Version chunks compare as numbers (20 > 3), not as text.
    const grok = searchModelCatalog({ query: "grok-4." }).models.map((model) => model.id);
    const grok420 = grok.findIndex((id) => id.startsWith("xai:grok-4.20"));
    expect(grok420).toBeGreaterThanOrEqual(0);
    expect(grok420).toBeLessThan(grok.indexOf("xai:grok-4.3"));
  });

  test("keeps each provider's matches together", () => {
    // No built-in matches "lama", so no provider leads and all matches share a tier.
    const providers = searchModelCatalog({ query: "lama" }).models.map((model) => model.provider);
    const runs = providers.filter((provider, i) => provider !== providers[i - 1]);
    expect(runs.length).toBeGreaterThan(1);
    expect(new Set(runs).size).toBe(runs.length);
  });

  test.each([
    ["claude", "anthropic", "bedrock"],
    ["gpt", "openai", "github-copilot"],
  ])("lists %s models from %s ahead of %s", (query, firstParty, other) => {
    const models = searchModelCatalog({ query }).models.filter((m) => !m.builtIn);
    expect(models.some((model) => model.provider === other)).toBe(true);
    expect(models[0]?.provider).toBe(firstParty);
  });

  test("applies the policy predicate before counting and paging", () => {
    const result = searchModelCatalog(
      { query: "fable", limit: 1 },
      (provider, modelId) => provider === "anthropic" && modelId === "claude-fable-5"
    );
    expect(result.models.map((model) => [model.id, model.builtIn])).toEqual([
      ["anthropic:claude-fable-5", false],
    ]);
    expect([result.total, result.nextOffset]).toEqual([1, null]);
  });

  test("pages with offset/limit and returns everything when limit is omitted", () => {
    const all = searchModelCatalog({ query: "gpt" });
    expect(all.nextOffset).toBeNull();
    expect(all.models).toHaveLength(all.total);
    expect(all.total).toBeGreaterThan(10);

    const paged: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = searchModelCatalog({ query: "gpt", offset, limit: 7 });
      expect(page.total).toBe(all.total);
      expect(page.models.length).toBeLessThanOrEqual(7);
      paged.push(...page.models.map((model) => model.id));
      offset = page.nextOffset;
    }
    expect(paged).toEqual(all.models.map((model) => model.id));

    expect(searchModelCatalog({ query: "gpt", offset: all.total, limit: 5 })).toEqual({
      models: [],
      total: all.total,
      nextOffset: null,
    });
  });
});
