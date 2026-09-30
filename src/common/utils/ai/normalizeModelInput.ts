import {
  resolveModelAlias,
  isValidModelFormat,
  normalizeSelectedModel,
} from "@/common/utils/ai/models";

export interface ModelInputResult {
  model: string | null;
  isAlias: boolean;
  error?: "invalid-format";
}

/** Normalize user-provided model input (alias resolution + gateway migration + format validation). */
export function normalizeModelInput(raw: string | null | undefined): ModelInputResult {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return { model: null, isAlias: false };
  }

  const resolved = resolveModelAlias(trimmed);
  const isAlias = resolved !== trimmed;
  const selectedModel = normalizeSelectedModel(resolved);

  if (!isValidModelFormat(selectedModel)) {
    return { model: null, isAlias, error: "invalid-format" };
  }

  const separatorIndex = selectedModel.indexOf(":");
  if (selectedModel.slice(separatorIndex + 1).startsWith(":")) {
    return { model: null, isAlias, error: "invalid-format" };
  }

  return { model: selectedModel, isAlias };
}
