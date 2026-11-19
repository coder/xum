/**
 * Integration tests for the curated known-model registry.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test, expect } from "@jest/globals";
import {
  KNOWN_MODELS,
  MODEL_ABBREVIATIONS,
  TOKENIZER_MODEL_OVERRIDES,
} from "@/common/constants/knownModels";
import modelsJson from "@/common/utils/tokens/models.json";
import { modelsExtra } from "@/common/utils/tokens/models-extra";
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
    // GPT tier names users type with /model (tier, not version, so they survive releases).
    ["sol", /^openai:gpt-[\d.]+-sol$/],
    ["luna", /^openai:gpt-[\d.]+-luna$/],
    ["astra", /^openai:gpt-[\d.]+-astra$/],
    ["gemini", /^google:gemini-.*pro/],
    ["argon", /^google:gemini-4-argon/],
    ["carbon", /^google:gemini-4-carbon/],
    ["gemini-flash", /^google:gemini-.*flash/],
    ["grok", /^xai:grok-/],
    ["muse", /^meta:muse-wonder-/],
    ["wonder", /^meta:muse-wonder-/],
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
    ["anthropic:claude-sonnet-5", "anthropic/claude-sonnet-4.5"],
    ["anthropic:claude-haiku-4-5", "anthropic/claude-3.5-haiku"],
    ["anthropic:claude-fable-5-1", "anthropic/claude-opus-4.5"],
    ["anthropic:claude-mythos-5-1", "anthropic/claude-opus-4.5"],
    ["openai:gpt-6.1-sol", "openai/gpt-5"],
    ["openai:gpt-6-astra", "openai/gpt-5"],
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

  // The iOS app cannot import this registry, so it keeps a copy that offers these models for
  // every configured provider; a model missing there cannot be picked on a server that has it.
  test("the iOS built-in model list matches the registry", () => {
    const swift = readFileSync(
      path.join(process.cwd(), "ios", "Xum", "Kit", "Models.swift"),
      "utf8"
    );
    const block = /static let builtIn = \[([\s\S]*?)\]/.exec(swift);
    expect(block).not.toBeNull();
    const iosIds = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    const knownIds = Object.values(KNOWN_MODELS)
      .map((m) => m.id)
      .sort();
    expect(iosIds).toEqual(knownIds);
  });

  test("the iOS context windows match the registry's input limits", () => {
    const swift = readFileSync(
      path.join(process.cwd(), "ios", "Xum", "Kit", "Models.swift"),
      "utf8"
    );
    const block = /\[String: Int\] = \[([\s\S]*?)\]/.exec(swift)?.[1] ?? "";
    const ios = Object.fromEntries(
      [...block.matchAll(/"([^"]+)": ([0-9_]+)/g)].map((m) => [
        m[1],
        Number(m[2].replaceAll("_", "")),
      ])
    );
    const expected = Object.fromEntries(
      Object.values(KNOWN_MODELS).map((m) => {
        const key = Object.keys(modelsExtra).find(
          (k) => k === m.providerModelId || k.endsWith(`/${m.providerModelId}`)
        );
        return [m.providerModelId, key ? modelsExtra[key].max_input_tokens : undefined];
      })
    );
    expect(ios).toEqual(expected);
  });
});
