/**
 * Route-aware Cyber mode (OpenAI Daybreak access program) availability.
 *
 * Cyber sends the Responses API `access_programs.cyber` field, which only the
 * direct OpenAI API accepts. Gateways, Codex OAuth, custom providers and Chat
 * Completions never receive it, and eligibility is the exact request model id
 * OpenAI's Daybreak guide maps to a program: no dated snapshots, mapped aliases
 * or name patterns, because the API rejects a program the model does not take.
 */

import type { OpenAICyberAccessProgram } from "@/common/types/openaiAccessPrograms";
import { normalizeToCanonical, resolveModelAlias } from "@/common/utils/ai/models";
import {
  openaiDirectProviderOptionsAvailable,
  resolveProviderOptionsRoute,
} from "@/common/utils/ai/openaiProviderOptionsAvailability";
import type { ProModeAvailabilityOptions } from "@/common/utils/ai/proMode";

/**
 * The `access_programs.cyber` value per request model id, from the model table of
 * https://developers.openai.com/api/docs/guides/daybreak (retrieved 2026-11-17).
 * The value follows the model, not the organization's approval level: OpenAI
 * requires Daybreak Red approval for reduced refusals on these two, yet both
 * reject `daybreak_red`. The guide does not list GPT-6 Luna or GPT-6.2 Astra/Sol,
 * so Cyber is unavailable for them (and for the aliases on GPT-6.2); their
 * requests omit the field, which the guide says selects standard safeguards for
 * models released from gpt-6.1-terra on. GPT-6 Sol is listed but no longer a Xum
 * model. Daybreak aliases and gpt-5.6-cyber accept only one program, which the
 * API already selects when the field is omitted.
 */
const CYBER_ACCESS_PROGRAM_BY_MODEL_ID: ReadonlyMap<string, OpenAICyberAccessProgram> = new Map([
  ["openai:gpt-6-astra", "daybreak_blue"],
  ["openai:gpt-6.1-sol", "daybreak_blue"],
]);

/** The `access_programs.cyber` value Cyber mode sends, or undefined when Cyber is unavailable. */
export function openaiCyberAccessProgram(
  modelString: string,
  options?: ProModeAvailabilityOptions
): OpenAICyberAccessProgram | undefined {
  // Opt-in provider setting; configs without OpenAI stay off.
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
