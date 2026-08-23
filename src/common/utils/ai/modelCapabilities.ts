import type { ProvidersConfigMap } from "@/common/orpc/types";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import modelsData from "../tokens/models.json";
import { modelsExtra } from "../tokens/models-extra";
import { normalizeToCanonical } from "./models";

interface RawModelCapabilitiesData {
  supports_pdf_input?: boolean;
  supports_vision?: boolean;
  supports_audio_input?: boolean;
  supports_video_input?: boolean;
  max_pdf_size_mb?: number;
  litellm_provider?: string;
  [key: string]: unknown;
}

export interface ModelCapabilities {
  supportsPdfInput: boolean;
  supportsVision: boolean;
  supportsAudioInput: boolean;
  supportsVideoInput: boolean;
  maxPdfSizeMb?: number;
}

export type SupportedInputMediaType = "image" | "pdf" | "audio" | "video";

const PROVIDER_KEY_ALIASES: Record<string, string> = {
  // GitHub Copilot keys in models.json use underscores for LiteLLM provider names.
  "github-copilot": "github_copilot",
};

/**
 * Generates lookup keys for a model string with multiple naming patterns.
 *
 * Keep this aligned with getModelStats(): many providers/layers use slightly different
 * conventions (e.g. "ollama/model-cloud", "provider/model").
 */
function generateLookupKeys(modelString: string): string[] {
  const colonIndex = modelString.indexOf(":");
  const provider = colonIndex !== -1 ? modelString.slice(0, colonIndex) : "";
  const modelName = colonIndex !== -1 ? modelString.slice(colonIndex + 1) : modelString;
  const litellmProvider = PROVIDER_KEY_ALIASES[provider] ?? provider;

  const keys: string[] = [
    modelName, // Direct model name (e.g., "claude-opus-4-5")
  ];

  if (provider) {
    keys.push(
      `${litellmProvider}/${modelName}`, // "ollama/gpt-oss:20b"
      `${litellmProvider}/${modelName}-cloud` // "ollama/gpt-oss:20b-cloud" (LiteLLM convention)
    );

    // Fallback: strip size suffix for base model lookup
    // "ollama:gpt-oss:20b" → "ollama/gpt-oss"
    if (modelName.includes(":")) {
      const baseModel = modelName.split(":")[0];
      keys.push(`${litellmProvider}/${baseModel}`);
    }
  }

  return keys;
}

// Exported for tests: upstream LiteLLM no longer ships max_pdf_size_mb, so the
// inference branches can only be exercised with injected metadata.
export function extractModelCapabilities(data: RawModelCapabilitiesData): ModelCapabilities {
  const maxPdfSizeMb = typeof data.max_pdf_size_mb === "number" ? data.max_pdf_size_mb : undefined;
  const provider = typeof data.litellm_provider === "string" ? data.litellm_provider : undefined;

  return {
    // Some providers omit supports_pdf_input but still include a max_pdf_size_mb field.
    // Treat maxPdfSizeMb as a strong signal that PDF input is supported.
    // OpenAI's vision-capable models also accept PDFs, but our local GPT-5 metadata in
    // models-extra.ts currently omits supports_pdf_input. Infer support here so users
    // don't get a false "does not support PDF input" block for models like openai:gpt-5.5.
    supportsPdfInput:
      data.supports_pdf_input === true ||
      maxPdfSizeMb !== undefined ||
      (provider === "openai" && data.supports_vision === true && data.supports_pdf_input !== false),
    supportsVision: data.supports_vision === true,
    supportsAudioInput: data.supports_audio_input === true,
    supportsVideoInput: data.supports_video_input === true,
    maxPdfSizeMb,
  };
}

export function getModelCapabilities(modelString: string): ModelCapabilities | null {
  const normalized = normalizeToCanonical(modelString);
  const lookupKeys = generateLookupKeys(normalized);

  // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const modelsExtraRecord = modelsExtra as unknown as Record<string, RawModelCapabilitiesData>;
  // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const modelsDataRecord = modelsData as unknown as Record<string, RawModelCapabilitiesData>;

  // Merge models.json (upstream) + models-extra.ts (local overrides). Extras win.
  // This avoids wiping capabilities (e.g. PDF support) when modelsExtra only overrides
  // pricing/token limits.
  for (const key of lookupKeys) {
    const base = modelsDataRecord[key];
    const extra = modelsExtraRecord[key];

    if (base || extra) {
      const merged: RawModelCapabilitiesData = { ...(base ?? {}), ...(extra ?? {}) };
      return extractModelCapabilities(merged);
    }
  }

  return null;
}

export function getModelCapabilitiesResolved(
  modelString: string,
  providersConfig: ProvidersConfigMap | null
): ModelCapabilities | null {
  const metadataModel = resolveModelForMetadata(modelString, providersConfig);
  return getModelCapabilities(metadataModel);
}

export function getSupportedInputMediaTypes(
  modelString: string
): Set<SupportedInputMediaType> | null {
  const caps = getModelCapabilities(modelString);
  if (!caps) return null;

  const result = new Set<SupportedInputMediaType>();
  if (caps.supportsVision) result.add("image");
  if (caps.supportsPdfInput) result.add("pdf");
  if (caps.supportsAudioInput) result.add("audio");
  if (caps.supportsVideoInput) result.add("video");
  return result;
}
