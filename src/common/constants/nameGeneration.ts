import { getKnownModel } from "@/common/constants/knownModels";

/**
 * Hardcoded small/fast fallbacks for AI-generated workspace names and titles.
 * A configured `name_workspace` agent model always runs first (see
 * WorkspaceService.getWorkspaceNamingCandidates); these only cover the unset case
 * or a failing configured model.
 *
 * Luna is the catalog's newer small OpenAI model (previously gpt-5.1-codex-mini) and
 * is also included in the Codex OAuth allowlist (CODEX_OAUTH_ALLOWED_MODELS), unlike
 * gpt-5.4-nano.
 */
export const NAME_GEN_PREFERRED_MODELS = [
  getKnownModel("HAIKU").id,
  getKnownModel("GPT_56_LUNA").id,
];
