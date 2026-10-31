import type { StandardSchemaV1 } from "@standard-schema/spec";

export function isValidationIssue(value: unknown): value is StandardSchemaV1.Issue {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  );
}

export function formatIssuePath(path: StandardSchemaV1.Issue["path"]): string {
  if (!path || path.length === 0) {
    return "<root>";
  }

  const parts: string[] = [];

  for (const segment of path) {
    const key =
      typeof segment === "object" && segment !== null && "key" in segment
        ? (segment as { key: PropertyKey }).key
        : segment;

    if (typeof key === "number") {
      parts.push(`[${key}]`);
      continue;
    }

    if (typeof key === "string") {
      const isIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
      if (parts.length === 0) {
        parts.push(isIdentifier ? key : `[${JSON.stringify(key)}]`);
      } else {
        parts.push(isIdentifier ? `.${key}` : `[${JSON.stringify(key)}]`);
      }
      continue;
    }

    const rendered = typeof key === "symbol" ? key.toString() : String(key);
    parts.push(parts.length === 0 ? `[${rendered}]` : `[${rendered}]`);
  }

  return parts.join("");
}

/**
 * oRPC rejects schema-invalid input with the generic "Input validation failed" and puts
 * each schema issue in `data.issues`, which survives serialization to the client. Without
 * them a settings form cannot say which field is wrong or why (#7771).
 */
export function formatInputValidationIssues(error: Error): string | null {
  const data = "data" in error ? error.data : undefined;
  if (typeof data !== "object" || data === null || !("issues" in data)) return null;
  if (!Array.isArray(data.issues)) return null;
  const issues = data.issues.filter(isValidationIssue);
  if (issues.length === 0) return null;
  return issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("; ");
}
