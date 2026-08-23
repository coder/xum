import { describe, test, expect } from "@jest/globals";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { listModelCatalogIds } from "./modelCatalog";
import { getModelStats } from "./modelStats";

describe("listModelCatalogIds", () => {
  const ids = listModelCatalogIds();

  test("includes every curated known model", () => {
    for (const model of Object.values(KNOWN_MODELS)) {
      expect(ids).toContain(model.id);
    }
  });

  test("exposes the full catalog, far beyond the curated list", () => {
    expect(ids.length).toBeGreaterThan(Object.keys(KNOWN_MODELS).length * 10);
    // Bare LiteLLM key: provider derived from litellm_provider.
    expect(ids).toContain("openai:gpt-4o-mini");
    // Provider-prefixed LiteLLM key: provider derived from the key itself.
    expect(ids).toContain("gemini:gemini-2.5-pro");
  });

  test("every id is canonical provider:model and resolves to model stats", () => {
    const invalid = ids.filter((id) => {
      const colonIndex = id.indexOf(":");
      return colonIndex <= 0 || colonIndex >= id.length - 1;
    });
    expect(invalid).toEqual([]);

    const unresolved = ids.filter((id) => getModelStats(id) === null);
    expect(unresolved).toEqual([]);
  });

  test("excludes models without chat-style metadata", () => {
    expect(ids).not.toContain("openai:text-embedding-3-small");
  });

  test("every id is self-canonical so selection metadata matches the visible row", () => {
    // Gateway keys like openrouter/deepseek/x normalize to the direct provider id
    // during stats resolution; exposing non-canonical ids would create rows that
    // look distinct but inherit another entry's metadata.
    const nonCanonical = ids.filter((id) => normalizeToCanonical(id) !== id);
    expect(nonCanonical).toEqual([]);
  });

  test("is sorted, deduplicated, and stable across calls", () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(listModelCatalogIds()).toBe(ids);
  });
});
