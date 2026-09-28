/**
 * Centralized model metadata. Update model versions here and everywhere else will follow.
 */

import { formatModelDisplayName } from "../utils/ai/modelDisplay";

type ModelProvider = "anthropic" | "openai" | "google" | "xai" | "deepseek" | "moonshotai" | "zai";

interface KnownModelDefinition {
  /** Provider identifier used by SDK factories */
  provider: ModelProvider;
  /** Provider-specific model name (no provider prefix) */
  providerModelId: string;
  /**
   * Aliases that should resolve to this model. User-facing family aliases are
   * pinned by family (not exact id) in knownModels.test.ts, so moving one to a
   * newer tier of the same family needs no test change.
   */
  aliases?: string[];
  /** Preload tokenizer encodings at startup */
  warm?: boolean;
  /** Optional tokenizer override for ai-tokenizer */
  tokenizerOverride?: string;
}

interface KnownModel extends KnownModelDefinition {
  /** Full model id string in the format provider:model */
  id: `${ModelProvider}:${string}`;
}

// Model definitions. Note we avoid listing legacy models here. These represent the focal models
// of the community.
const MODEL_DEFINITIONS = {
  // Claude Fable 5.1 - Mythos-class model (a tier above Opus), successor to Fable 5
  // (released June 9, 2026) as the generally-available safeguarded variant, at the same
  // pricing ($10/M input, $50/M output) except cheaper cache reads (0.025x input).
  // API id `claude-fable-5-1`; Fable 5 stays usable as the custom model string
  // `anthropic:claude-fable-5`.
  FABLE: {
    provider: "anthropic",
    providerModelId: "claude-fable-5-1",
    aliases: ["fable"],
    warm: true,
    // Fable/Mythos use the newer Opus 4.7+ tokenizer, which isn't published upstream;
    // reuse Opus 4.5 (the newest Anthropic tokenizer in ai-tokenizer) for approximate
    // counting. Anthropic says the newer tokenizer produces ~30% more tokens for the
    // same text, so real usage can run ~1.0-1.3x higher than this estimate.
    tokenizerOverride: "anthropic/claude-opus-4.5",
  },
  // Claude Mythos 5.1 - successor to Mythos 5 (released June 9, 2026 alongside Fable 5)
  // as the restricted-access, safeguards-lifted twin of Fable 5.1, with identical specs
  // and pricing ($10/M input, $50/M output, 0.025x-input cache reads) and unchanged
  // availability (approved Project Glasswing customers only, no self-serve sign-up).
  // API id `claude-mythos-5-1`; Mythos 5 stays usable as the custom model string
  // `anthropic:claude-mythos-5`.
  // Not warmed: most users cannot access it, and its tokenizer override is already
  // warmed via FABLE.
  MYTHOS: {
    provider: "anthropic",
    providerModelId: "claude-mythos-5-1",
    aliases: ["mythos"],
    // Same tokenizer situation as Fable 5 (see FABLE above): reuse Opus 4.5 for
    // approximate counting; real usage can run ~1.0-1.3x higher.
    tokenizerOverride: "anthropic/claude-opus-4.5",
  },
  // Claude Opus 5.5 - released September 22, 2026, successor to Opus 5. $4/M input,
  // $20/M output, 20% below Opus 5. API id `claude-opus-5-5`; Opus 5 stays usable
  // as the custom model string `anthropic:claude-opus-5`. Unlike Opus 5, thinking
  // cannot be disabled (see anthropicRejectsDisabledThinking).
  OPUS: {
    provider: "anthropic",
    providerModelId: "claude-opus-5-5",
    aliases: ["opus"],
    warm: true,
    // Opus 5.5 uses the newer Opus 4.7+ tokenizer (~30% more tokens for the same text),
    // which isn't published upstream; reuse Opus 4.5 for approximate counting. Real
    // usage can run ~1.0-1.3x higher than this estimate (same situation as FABLE above).
    tokenizerOverride: "anthropic/claude-opus-4.5",
  },
  // Claude Sonnet 5 - released June 30, 2026. The most agentic Sonnet yet (native 1M context,
  // 128K max output, adaptive thinking + effort including native xhigh). Standard pricing matches
  // Sonnet 4.6 ($3/M in, $15/M out); introductory $2/$10 applies through Aug 31, 2026. API id
  // `claude-sonnet-5`. The bare `sonnet` alias tracks the latest Sonnet tier.
  SONNET: {
    provider: "anthropic",
    providerModelId: "claude-sonnet-5",
    aliases: ["sonnet"],
    warm: true,
    // Sonnet 5 ships an updated tokenizer (same kind of change introduced with Opus 4.7) that
    // isn't published upstream yet; reuse Sonnet 4.5 for approximate counting. Real usage can run
    // ~1.0-1.35x higher than this estimate depending on content type.
    tokenizerOverride: "anthropic/claude-sonnet-4.5",
  },
  HAIKU: {
    provider: "anthropic",
    providerModelId: "claude-haiku-4-5",
    aliases: ["haiku"],
    tokenizerOverride: "anthropic/claude-3.5-haiku",
  },
  // September 22 releases: keep the durable gpt/sol and luna aliases on their
  // latest tiers without moving users to the more expensive Astra tier. Retired
  // GPT-5.6 Sol/Luna remain usable as custom model strings with their own metadata.
  GPT: {
    provider: "openai",
    providerModelId: "gpt-6-sol",
    aliases: ["gpt", "sol"],
    warm: true,
    // GPT-6's tokenizer is not published upstream; reuse gpt-5 for approximate counting.
    tokenizerOverride: "openai/gpt-5",
  },
  // GPT-5.6 Terra - balanced everyday tier, released July 9, 2026.
  // GPT-5.5-class quality at a fraction of the cost: $2/M input, $12/M output; 1.05M context.
  GPT_56_TERRA: {
    provider: "openai",
    providerModelId: "gpt-5.6-terra",
    aliases: ["terra"],
    tokenizerOverride: "openai/gpt-5",
  },
  // GPT-6 Luna - the latest cost-efficient tier, released September 22, 2026.
  GPT_6_LUNA: {
    provider: "openai",
    providerModelId: "gpt-6-luna",
    aliases: ["luna"],
    tokenizerOverride: "openai/gpt-5",
  },
  // Astra stays a separate frontier-tier choice rather than taking over `gpt`.
  // Not warmed: its tokenizer override is already warmed via GPT.
  GPT_6_ASTRA: {
    provider: "openai",
    providerModelId: "gpt-6-astra",
    aliases: ["astra", "gpt-6-astra"],
    // GPT-6 tokenizer not published upstream; reuse gpt-5 for approximate
    // counting (same approach as the GPT-5.6 family).
    tokenizerOverride: "openai/gpt-5",
  },
  // GPT Pro alias tracks the latest GPT-5 Pro tier.
  GPT_PRO: {
    provider: "openai",
    providerModelId: "gpt-5.5-pro",
    aliases: ["gpt-pro", "gpt-5.5-pro"],
    warm: true,
    tokenizerOverride: "openai/gpt-5",
  },
  // GPT Mini alias tracks the latest stable GPT-5 mini tier.
  GPT_54_MINI: {
    provider: "openai",
    providerModelId: "gpt-5.4-mini",
    aliases: ["gpt-mini"],
    tokenizerOverride: "openai/gpt-5",
  },
  // GPT Nano alias tracks the latest stable GPT-5 nano tier.
  GPT_54_NANO: {
    provider: "openai",
    providerModelId: "gpt-5.4-nano",
    aliases: ["gpt-nano"],
    tokenizerOverride: "openai/gpt-5",
  },
  // GPT-5.3-Codex is the released API model id.
  GPT_53_CODEX: {
    provider: "openai",
    providerModelId: "gpt-5.3-codex",
    aliases: ["codex", "codex-5.3"],
    warm: true,
    tokenizerOverride: "openai/gpt-5",
  },
  // Codex Spark is a real-time, text-only variant of GPT-5.3-Codex with a 128k context window.
  // We intentionally keep it first-class so users can select it directly via the `spark` alias.
  GPT_53_CODEX_SPARK: {
    provider: "openai",
    providerModelId: "gpt-5.3-codex-spark",
    aliases: ["spark"],
    warm: true,
    tokenizerOverride: "openai/gpt-5",
  },
  GPT_MINI: {
    provider: "openai",
    providerModelId: "gpt-5.1-codex-mini",
    aliases: ["codex-mini"],
  },
  GPT_CODEX_MAX: {
    provider: "openai",
    providerModelId: "gpt-5.1-codex-max",
    aliases: ["codex-max"],
    warm: true,
    tokenizerOverride: "openai/gpt-5",
  },
  DAYBREAK_BLUE: {
    provider: "openai",
    providerModelId: "daybreak-blue-latest",
    tokenizerOverride: "openai/gpt-5",
  },
  DAYBREAK_RED: {
    provider: "openai",
    providerModelId: "daybreak-red-latest",
    tokenizerOverride: "openai/gpt-5",
  },
  // Gemini 3.1 Pro supersedes Gemini 3 Pro; keep bare aliases pointed at the latest Pro tier.
  GEMINI_31_PRO: {
    provider: "google",
    providerModelId: "gemini-3.1-pro-preview",
    aliases: ["gemini", "gemini-pro"],
    tokenizerOverride: "google/gemini-2.5-pro",
  },
  // Gemini Flash alias tracks the latest stable Flash tier (3.8 Flash, GA September 2, 2026).
  // Older Flash tiers stay usable as custom model strings (e.g. `google:gemini-3.7-flash`).
  GEMINI_FLASH: {
    provider: "google",
    providerModelId: "gemini-3.8-flash",
    aliases: ["gemini-flash"],
    tokenizerOverride: "google/gemini-2.5-pro",
  },
  // Grok 4.7 - xAI's frontier coding and knowledge-work model, released September 21,
  // 2026. Supersedes Grok 4.6 at identical pricing and specs ($2/M in, $6/M out, 500K
  // context, native xhigh); Grok 4.6 remains usable as the custom model string
  // `xai:grok-4.6`. The Grok 4.7 Fast variant is Cursor/Grok Build-only (not on the
  // public xAI API), so it is intentionally not listed.
  GROK_47: {
    provider: "xai",
    providerModelId: "grok-4.7",
    aliases: ["grok", "grok-4.7"],
  },
  // DeepSeek V4 Pro is the flagship V4 tier (1.6T total / 49B active params, 1M context,
  // 384K max output). Bare `deepseek` alias points here per the convention that the
  // shortest alias tracks each provider's flagship model (mirrors `gemini` → Gemini Pro,
  // `grok` → Grok 4.7).
  DEEPSEEK_V4_PRO: {
    provider: "deepseek",
    providerModelId: "deepseek-v4-pro",
    aliases: ["deepseek", "deepseek-pro", "deepseek-v4", "deepseek-v4-pro"],
    // V4 ships a custom `encoding_dsv4` tokenizer that isn't published upstream yet;
    // reuse v3.1 (the latest available DeepSeek tokenizer in ai-tokenizer) for
    // approximate token counting until V4 weights land in the registry.
    tokenizerOverride: "deepseek/deepseek-v3.1",
  },
  // DeepSeek V4 Flash is the fast/economical V4 tier (284B total / 13B active params).
  // Same 1M context + 384K output as Pro; lower cost, smaller scale.
  DEEPSEEK_V4_FLASH: {
    provider: "deepseek",
    providerModelId: "deepseek-v4-flash",
    aliases: ["deepseek-flash", "deepseek-v4-flash"],
    tokenizerOverride: "deepseek/deepseek-v3.1",
  },
  // Kimi K3 - Moonshot AI's flagship open-weight multimodal reasoning model (released
  // July 16, 2026; 1M context, text+image input; $3/M in, $15/M out).
  // Bare `kimi` alias tracks Moonshot's flagship per the shortest-alias convention.
  KIMI_K3: {
    provider: "moonshotai",
    providerModelId: "kimi-k3",
    aliases: ["kimi", "k3", "kimi-k3"],
    // K3's tokenizer isn't published in ai-tokenizer yet; reuse Kimi K2 (the newest
    // Moonshot tokenizer available) for approximate counting.
    tokenizerOverride: "moonshotai/kimi-k2",
  },
  GLM_53_FLASH: {
    provider: "zai",
    providerModelId: "glm-5.3-flash",
    aliases: ["glm", "glm-flash", "glm-5.3-flash"],
    // GLM 5.3 is not in ai-tokenizer yet; use the closest published GLM encoding.
    tokenizerOverride: "zai/glm-4.5",
  },
} as const satisfies Record<string, KnownModelDefinition>;

export type KnownModelKey = keyof typeof MODEL_DEFINITIONS;
const MODEL_DEFINITION_ENTRIES = Object.entries(MODEL_DEFINITIONS) as Array<
  [KnownModelKey, KnownModelDefinition]
>;

export const KNOWN_MODELS = Object.fromEntries(
  MODEL_DEFINITION_ENTRIES.map(([key, definition]) => toKnownModelEntry(key, definition))
);
function toKnownModelEntry<K extends KnownModelKey>(
  key: K,
  definition: KnownModelDefinition
): [K, KnownModel] {
  return [
    key,
    {
      ...definition,
      id: `${definition.provider}:${definition.providerModelId}`,
    },
  ];
}

export function getKnownModel(key: KnownModelKey): KnownModel {
  return KNOWN_MODELS[key];
}

// ------------------------------------------------------------------------------------
// Derived collections
// ------------------------------------------------------------------------------------

/**
 * The default known model key.
 *
 * Keep this local (non-exported) to avoid confusion with storage keys.
 */
const DEFAULT_KNOWN_MODEL_KEY: KnownModelKey = "OPUS";

export const DEFAULT_MODEL = KNOWN_MODELS[DEFAULT_KNOWN_MODEL_KEY].id;

export const DEFAULT_HIDDEN_MODELS = [KNOWN_MODELS.DAYBREAK_BLUE.id, KNOWN_MODELS.DAYBREAK_RED.id];

export const DEFAULT_WARM_MODELS = Object.values(KNOWN_MODELS)
  .filter((model) => model.warm)
  .map((model) => model.id);

export const MODEL_ABBREVIATIONS: Record<string, string> = Object.fromEntries(
  Object.values(KNOWN_MODELS)
    .flatMap((model) => (model.aliases ?? []).map((alias) => [alias, model.id] as const))
    .sort(([a], [b]) => a.localeCompare(b))
);

// Retired first-class models stay documented as custom model strings (see the
// FABLE/OPUS comments); keep their approximate-tokenizer overrides so exact-id
// lookup does not fall back to the generic per-provider tokenizer.
const LEGACY_TOKENIZER_MODEL_OVERRIDES: Record<string, string> = {
  "anthropic:claude-fable-5": "anthropic/claude-opus-4.5",
  "anthropic:claude-mythos-5": "anthropic/claude-opus-4.5",
  "anthropic:claude-opus-5": "anthropic/claude-opus-4.5",
  "anthropic:claude-opus-4-8": "anthropic/claude-opus-4.5",
  "openai:gpt-5.6-sol": "openai/gpt-5",
  "openai:gpt-5.6-luna": "openai/gpt-5",
};

export const TOKENIZER_MODEL_OVERRIDES: Record<string, string> = {
  ...LEGACY_TOKENIZER_MODEL_OVERRIDES,
  // Spread current models last so a returning id always wins over its legacy entry.
  ...Object.fromEntries(
    Object.values(KNOWN_MODELS)
      .filter((model) => Boolean(model.tokenizerOverride))
      .map((model) => [model.id, model.tokenizerOverride!])
  ),
};

/** Tooltip-friendly abbreviation examples: show representative shortcuts */
export const MODEL_ABBREVIATION_EXAMPLES = (["opus", "sonnet"] as const).map((abbrev) => ({
  abbrev,
  displayName: formatModelDisplayName(MODEL_ABBREVIATIONS[abbrev]?.split(":")[1] ?? abbrev),
}));
