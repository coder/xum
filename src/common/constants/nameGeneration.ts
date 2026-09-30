import { getKnownModel } from "@/common/constants/knownModels";

/**
 * Hardcoded small/fast fallbacks for AI-generated workspace names and titles.
 * A configured `name_workspace` agent model always runs first (see
 * WorkspaceService.getWorkspaceNamingCandidates); these only cover the unset case
 * or a failing configured model.
 *
 * Luna is the catalog's small OpenAI model and is also included in the Codex OAuth
 * allowlist (CODEX_OAUTH_ALLOWED_MODELS).
 */
export const NAME_GEN_PREFERRED_MODELS = [
  getKnownModel("HAIKU").id,
  getKnownModel("GPT_6_LUNA").id,
];

/**
 * Output reserve for the propose_name tool call. Anthropic rejects requests whose
 * max_tokens does not exceed thinking.budget_tokens, so a naming request that
 * serializes an Anthropic thinking budget sets maxOutputTokens = budget + this.
 * A name and a short title need far less than this.
 */
export const NAME_GEN_MAX_OUTPUT_TOKENS = 1024;
