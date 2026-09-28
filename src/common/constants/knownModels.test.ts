/**
 * Integration tests for the curated known-model registry.
 */

import { describe, test, expect } from "@jest/globals";
import {
  KNOWN_MODELS,
  MODEL_ABBREVIATIONS,
  TOKENIZER_MODEL_OVERRIDES,
} from "@/common/constants/knownModels";
import modelsJson from "@/common/utils/tokens/models.json";
import { findMissingKnownModels } from "@/common/utils/tokens/updateModelsData";

describe("Known Models Integration", () => {
  test("all known models exist in token metadata", () => {
    const missingModels = findMissingKnownModels(modelsJson);

    if (missingModels.length > 0) {
      throw new Error(
        `The following known models are missing from token metadata:\n${missingModels.join("\n")}\n\n` +
          `Run 'make update-models' to refresh models.json from LiteLLM.`
      );
    }
  });

  // Aliases users type or that hand-written UI/docs reference (e.g. the composer
  // tooltip examples, `/model sonnet` and `/compact -m gpt` hints, docs agent and
  // compaction examples), plus each provider's bare family name. Pin the family,
  // not the exact id, so a model release that moves an alias to a newer tier of
  // the same family does not churn this table; it fails only when a user-facing
  // alias disappears or starts resolving to a different family.
  test.each([
    ["opus", /^anthropic:claude-opus-/],
    ["sonnet", /^anthropic:claude-sonnet-/],
    ["haiku", /^anthropic:claude-haiku-/],
    ["gpt", /^openai:gpt-[\d.]+-sol$/],
    ["gpt-pro", /^openai:gpt-[\d.]+-pro$/],
    // GPT tier names users type with /model (tier, not version, so they survive releases).
    ["sol", /^openai:gpt-[\d.]+-sol$/],
    ["terra", /^openai:gpt-[\d.]+-terra$/],
    ["luna", /^openai:gpt-[\d.]+-luna$/],
    ["astra", /^openai:gpt-[\d.]+-astra$/],
    ["codex", /^openai:gpt-[\d.]+-codex$/],
    ["gemini", /^google:gemini-.*pro/],
    ["gemini-flash", /^google:gemini-.*flash/],
    ["grok", /^xai:grok-/],
    ["deepseek", /^deepseek:deepseek-.*pro/],
    ["kimi", /^moonshotai:kimi-/],
    ["glm", /^zai:glm-/],
    ["glm-flash", /^zai:glm-.*flash/],
  ])("user-facing alias %s resolves within its model family", (alias, family) => {
    expect(MODEL_ABBREVIATIONS[alias]).toMatch(family);
  });

  // The flagship alias follows the Sol tier, never the pricier Astra tier (Astra is additive).
  test("gpt alias tracks the same model as sol", () => {
    expect(MODEL_ABBREVIATIONS.gpt).toBe(MODEL_ABBREVIATIONS.sol);
  });

  // Exact-id lookup for retired-but-documented custom model strings must keep
  // resolving to an approximate tokenizer instead of falling back (with a
  // warning) to the generic per-provider tokenizer.
  test.each([
    ["anthropic:claude-opus-5", "anthropic/claude-opus-4.5"],
    ["openai:gpt-5.6-sol", "openai/gpt-5"],
    ["openai:gpt-5.6-luna", "openai/gpt-5"],
  ])("retired id %s keeps its tokenizer override", (modelId, tokenizer) => {
    expect(TOKENIZER_MODEL_OVERRIDES[modelId]).toBe(tokenizer);
  });

  test("known model ids and aliases stay unique across the curated registry", () => {
    const seenIds = new Set<string>();
    const seenAliases = new Set<string>();

    for (const model of Object.values(KNOWN_MODELS)) {
      expect(seenIds.has(model.id)).toBe(false);
      seenIds.add(model.id);

      for (const alias of model.aliases ?? []) {
        expect(seenAliases.has(alias)).toBe(false);
        seenAliases.add(alias);
        expect(MODEL_ABBREVIATIONS[alias]).toBe(model.id);
      }
    }
  });
});
