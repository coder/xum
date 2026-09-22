import { getKnownModel } from "@/common/constants/knownModels";

/**
 * Hardcoded small/fast fallbacks for AI-generated workspace names and titles.
 * A configured `name_workspace` agent model always runs first (see
 * WorkspaceService.getWorkspaceNamingCandidates); these only cover the unset case
 * or a failing configured model.
 *
 * Keep the naming fallback on GPT-5.6 Luna until GPT-6 Luna is verified on
 * Codex OAuth; promoting the catalog must not break naming for OAuth-only users.
 */
export const NAME_GEN_PREFERRED_MODELS = [getKnownModel("HAIKU").id, "openai:gpt-5.6-luna"];

/**
 * Output reserve for the propose_name tool call. Anthropic rejects requests whose
 * max_tokens does not exceed thinking.budget_tokens, so a naming request that
 * serializes an Anthropic thinking budget sets maxOutputTokens = budget + this.
 * A name and a short title need far less than this.
 */
export const NAME_GEN_MAX_OUTPUT_TOKENS = 1024;
