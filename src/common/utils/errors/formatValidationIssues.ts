import type { StandardSchemaV1 } from "@standard-schema/spec";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isValidationIssue(value: unknown): value is StandardSchemaV1.Issue {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function formatPathKey(key: unknown, isFirst: boolean): string {
  if (typeof key !== "string") return `[${String(key)}]`;
  if (!IDENTIFIER.test(key)) return `[${JSON.stringify(key)}]`;
  return isFirst ? key : `.${key}`;
}

export function formatIssuePath(path: StandardSchemaV1.Issue["path"]): string {
  // Client-side issues arrive as deserialized JSON, so the declared type is not guaranteed.
  if (!Array.isArray(path) || path.length === 0) return "<root>";
  return path
    .map((segment: unknown, index) =>
      formatPathKey(
        typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment,
        index === 0
      )
    )
    .join("");
}

/**
 * oRPC rejects schema-invalid input with the generic "Input validation failed" and puts
 * each schema issue in `data.issues`, which survives serialization to the client. Without
 * them a settings form cannot say which field is wrong or why (#7771).
 */
export function getMessageWithInputValidationIssues(error: Error): string {
  const data = "data" in error ? error.data : undefined;
  if (typeof data !== "object" || data === null || !("issues" in data)) return error.message;
  const issues = Array.isArray(data.issues) ? data.issues.filter(isValidationIssue) : [];
  if (issues.length === 0) return error.message;
  const details = issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`);
  return `${error.message}: ${details.join("; ")}`;
}
