import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";

/** Why model creation refused while mock AI mode is on. */
export const MOCK_AI_MODEL_REFUSED_MESSAGE =
  "Model calls are disabled in mock AI mode (XUM_MOCK_AI=1)";

/**
 * XUM_MOCK_AI=1 (or the legacy MUX_MOCK_AI=1): AIService plays chat turns through
 * MockAiStreamPlayer, and the model factories refuse to create provider models, so no
 * feature (title, status, memory, compaction summary, refine, routing) sends a real
 * provider request (#5604).
 */
export function isMockAiMode(): boolean {
  return resolveXumEnvironmentValue("MOCK_AI", process.env) === "1";
}
