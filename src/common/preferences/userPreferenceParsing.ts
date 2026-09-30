import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import { isValidModelFormat, normalizeSelectedModel } from "@/common/utils/ai/models";
import { normalizeAgentId } from "@/common/utils/agentIds";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function parseEnum<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : undefined;
}

export function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = parseNonEmptyString(item);
    if (!parsed || seen.has(parsed)) {
      continue;
    }
    seen.add(parsed);
    out.push(parsed);
  }

  return out.length > 0 ? out : undefined;
}

export function parseAgentId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return normalizeAgentId(value, "");
}

export function parseModelString(value: unknown): string | undefined {
  const parsed = parseNonEmptyString(value);
  if (!parsed) {
    return undefined;
  }

  if (parsed.startsWith("mux-gateway:") && !parsed.includes("/")) {
    return undefined;
  }

  const normalized = normalizeSelectedModel(parsed);
  return isValidModelFormat(normalized) ? normalized : undefined;
}

export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return coerceThinkingLevel(value);
}

export function parseRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && Object.keys(value).length > 0 ? value : undefined;
}
