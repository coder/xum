/**
 * Anthropic Fast mode (research preview): `speed: "fast"` on the Messages API
 * for up to 2.5x output tokens/sec at premium pricing. @ai-sdk/anthropic adds the
 * required `fast-mode-2026-02-01` beta header whenever
 * `providerOptions.anthropic.speed === "fast"`.
 *
 * Source: https://platform.claude.com/docs/en/build-with-claude/fast-mode
 * (fetched 2026-09-29).
 */
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { stripModelProviderPrefixes } from "@/common/types/thinking";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { resolveProviderOptionsRoute } from "@/common/utils/ai/openaiProviderOptionsAvailability";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";

/**
 * Models Anthropic documents for Fast mode. Kept as an explicit list: Opus 4.7
 * rejects `speed: "fast"` and Opus 4.6 silently runs (and bills) at standard
 * speed, so a version-range matcher would expose a toggle that errors or lies.
 * Dated snapshots of the listed models are accepted.
 */
export function anthropicSupportsFastMode(modelString: string): boolean {
  return /^claude-opus-(?:4-8|5|5-5)(?:-\d{8})?$/.test(stripModelProviderPrefixes(modelString));
}

function isFirstPartyAnthropicBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

export interface AnthropicFastModeAvailability {
  /** Settings-resolved route for the canonical model ("direct" = no gateway). */
  resolvedRouteProvider?: string | null;
  /** Providers config for explicit gateway, policy, and beta-feature detection. */
  providersConfig?: ProvidersConfigMap | null;
}

/**
 * Fast mode is only offered on the first-party Claude API: not on gateways,
 * Bedrock, Vertex, Foundry, or custom Anthropic-compatible endpoints, which
 * reject the `speed` field.
 */
export function anthropicFastModeAvailable(
  modelString: string,
  options?: AnthropicFastModeAvailability
): boolean {
  const providersConfig = options?.providersConfig;
  // Policy-filtered configs omit denied providers, including this preference's
  // write target. Do not expose Fast or inject a hidden saved speed.
  if (providersConfig != null && providersConfig.anthropic == null) return false;
  // Fast mode is a beta; ZDR setups disable Anthropic beta features entirely.
  if (providersConfig?.anthropic?.disableBetaFeatures === true) return false;

  // A built-in provider pointed at a proxy/compatible endpoint (config or env
  // base URL) is not the first-party API; only the official host gets Fast.
  const baseUrl =
    providersConfig?.anthropic?.baseUrlResolved ?? providersConfig?.anthropic?.baseUrl;
  if (baseUrl != null && baseUrl.trim() !== "" && !isFirstPartyAnthropicBaseUrl(baseUrl)) {
    return false;
  }

  const prefix = modelString.split(":", 1)[0];
  if (isCustomProviderConfig(providersConfig?.[prefix])) return false;
  if (resolveProviderOptionsRoute(modelString, options) !== "direct") return false;

  const normalized = normalizeToCanonical(modelString);
  if (!normalized.startsWith("anthropic:")) return false;
  // Mapped aliases (e.g. anthropic:team-opus → claude-opus-5-5) use their target.
  return anthropicSupportsFastMode(resolveModelForMetadata(normalized, providersConfig ?? null));
}
