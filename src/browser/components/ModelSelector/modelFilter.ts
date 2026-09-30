/**
 * Search matching for the ModelSelector dropdown.
 */
import { MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";
import { normalizeToCanonical } from "@/common/utils/ai/models";

// Reverse alias map so searches match documented aliases (e.g. "gemini-flash")
// that are not substrings of the model string.
const ALIASES_BY_MODEL = new Map<string, string[]>();
for (const [alias, modelId] of Object.entries(MODEL_ABBREVIATIONS)) {
  const aliases = ALIASES_BY_MODEL.get(modelId);
  if (aliases) {
    aliases.push(alias);
  } else {
    ALIASES_BY_MODEL.set(modelId, [alias]);
  }
}

export function modelMatchesQuery(model: string, lowerQuery: string): boolean {
  if (model.toLowerCase().includes(lowerQuery)) return true;
  // Aliases map to canonical provider:model ids; normalize so gateway-prefixed
  // entries (mux-gateway:google/...) match their aliases too.
  const aliases = ALIASES_BY_MODEL.get(normalizeToCanonical(model));
  return aliases?.some((alias) => alias.includes(lowerQuery)) ?? false;
}
