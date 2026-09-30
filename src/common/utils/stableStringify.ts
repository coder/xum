function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }

  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableNormalize(value[key]);
  }
  return out;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value)) ?? "undefined";
}
