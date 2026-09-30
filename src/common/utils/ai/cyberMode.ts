/**
 * Route-aware Cyber mode (OpenAI Daybreak access program) availability.
 *
 * Cyber sends the Responses API `access_programs.cyber` field, which only the
 * direct OpenAI API accepts. Gateways, Codex OAuth, custom providers and Chat
 * Completions never receive it, and eligibility is the exact request model id
 * OpenAI's Daybreak guide maps to a program (see
 * KnownModelDefinition.cyberAccessProgram): no dated snapshots, mapped aliases
 * or name patterns, because the API rejects a program the model does not take.
 */

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { OpenAICyberAccessProgram } from "@/common/types/openaiAccessPrograms";
import { normalizeToCanonical, resolveModelAlias } from "@/common/utils/ai/models";
import {
  openaiDirectProviderOptionsAvailable,
  resolveProviderOptionsRoute,
} from "@/common/utils/ai/openaiProviderOptionsAvailability";
import type { ProModeAvailabilityOptions } from "@/common/utils/ai/proMode";

const CYBER_ACCESS_PROGRAM_BY_MODEL_ID = new Map<string, OpenAICyberAccessProgram>(
  Object.values(KNOWN_MODELS).flatMap((model) =>
    model.provider === "openai" && model.cyberAccessProgram != null
      ? [[model.id, model.cyberAccessProgram] as const]
      : []
  )
);

/** The `access_programs.cyber` value Cyber mode sends, or undefined when Cyber is unavailable. */
export function openaiCyberAccessProgram(
  modelString: string,
  options?: ProModeAvailabilityOptions
): OpenAICyberAccessProgram | undefined {
  // Opt-in provider setting; policy-filtered configs without OpenAI stay off.
  if (options?.providersConfig?.openai?.cyberModelEnabled !== true) return undefined;

  const wireFormat =
    options.openaiWireFormat ?? options.providersConfig.openai.wireFormat ?? "responses";
  if (wireFormat !== "responses") return undefined;

  const normalized = normalizeToCanonical(resolveModelAlias(modelString.trim()));
  const program = CYBER_ACCESS_PROGRAM_BY_MODEL_ID.get(normalized);
  if (program == null) return undefined;

  const route = options.effectiveRouteProvider ?? resolveProviderOptionsRoute(modelString, options);
  return openaiDirectProviderOptionsAvailable(normalized, {
    ...options,
    resolvedRouteProvider: route,
  })
    ? program
    : undefined;
}

export function openaiCyberModeAvailable(
  modelString: string,
  options?: ProModeAvailabilityOptions
): boolean {
  return openaiCyberAccessProgram(modelString, options) != null;
}
