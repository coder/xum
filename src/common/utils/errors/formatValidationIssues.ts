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

/** The server log formatter lists the same number, so both sides show the same issues. */
export const MAX_SHOWN_VALIDATION_ISSUES = 5;
const MAX_ISSUE_MESSAGE_CHARS = 300;

function formatIssueDetails(issues: readonly StandardSchemaV1.Issue[]): string {
  const details = issues.slice(0, MAX_SHOWN_VALIDATION_ISSUES).map((issue) => {
    const message =
      issue.message.length > MAX_ISSUE_MESSAGE_CHARS
        ? `${issue.message.slice(0, MAX_ISSUE_MESSAGE_CHARS)}…`
        : issue.message;
    return `${formatIssuePath(issue.path)}: ${message}`;
  });
  const hidden = issues.length - MAX_SHOWN_VALIDATION_ISSUES;
  if (hidden > 0) details.push(`+${hidden} more`);
  return details.join("; ");
}

function readValidationIssues(error: Error): StandardSchemaV1.Issue[] {
  const data = "data" in error ? error.data : undefined;
  if (typeof data !== "object" || data === null || !("issues" in data)) return [];
  return Array.isArray(data.issues) ? data.issues.filter(isValidationIssue) : [];
}

/**
 * oRPC rejects schema-invalid input with the generic "Input validation failed" and puts
 * each schema issue in `data.issues`, which survives serialization to the client. Without
 * them a settings form cannot say which field is wrong or why (#7771).
 *
 * Best effort: crash and stream-failure paths format arbitrary thrown values through
 * `getErrorMessage`, so a throwing `data` getter or Proxy trap must not replace the original
 * message with a new error.
 */
export function getMessageWithInputValidationIssues(error: Error): string {
  try {
    const issues = readValidationIssues(error);
    if (issues.length === 0) return error.message;
    return `${error.message}: ${formatIssueDetails(issues)}`;
  } catch {
    return error.message;
  }
}
