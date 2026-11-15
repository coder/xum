/**
 * Zod v4 issue fields read when rendering tool input validation failures.
 * Duck-typed so callers can pass issues recovered from an AI SDK error cause
 * chain (InvalidToolInputError -> TypeValidationError -> ZodError) without
 * importing zod.
 */
export interface ToolInputIssue {
  path: readonly PropertyKey[];
  message: string;
  code?: string;
  origin?: string;
}

export function isToolInputIssueArray(value: unknown): value is ToolInputIssue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (issue: unknown) =>
        typeof issue === "object" &&
        issue !== null &&
        Array.isArray((issue as { path?: unknown }).path) &&
        typeof (issue as { message?: unknown }).message === "string"
    )
  );
}

/**
 * Render zod issues as one concise line: "<path>: <message>[ (received N characters)]".
 * Never echoes the input value itself; the AI SDK's own message does, which buries the
 * actionable issue under kilobytes of the model's rejected input.
 */
export function formatToolInputIssues(issues: readonly ToolInputIssue[], input: unknown): string {
  const text = issues.map((issue) => formatToolInputIssue(issue, input)).join("; ");
  // A missing required field usually means the model sent another tool's argument shape;
  // listing the keys that did arrive (never their values) shows it which shape it sent.
  const receivedKeys = issues.some((issue) => isMissingFieldIssue(issue, input))
    ? describeReceivedKeys(input)
    : undefined;
  return receivedKeys == null ? text : `${text}; ${receivedKeys}`;
}

const MAX_LISTED_KEYS = 12;
const MAX_KEY_NAME_CHARS = 40;

/** Comma-separated key names, bounded so a model's junk keys cannot flood the error. */
export function formatKeyNames(keys: readonly string[]): string {
  const listed = keys
    .slice(0, MAX_LISTED_KEYS)
    .map((key) =>
      key.length > MAX_KEY_NAME_CHARS ? `${key.slice(0, MAX_KEY_NAME_CHARS)}...` : key
    );
  const hidden = keys.length - listed.length;
  return hidden > 0 ? `${listed.join(", ")} and ${hidden} more` : listed.join(", ");
}

function isMissingFieldIssue(issue: ToolInputIssue, input: unknown): boolean {
  return (
    issue.code === "invalid_type" &&
    issue.path.length > 0 &&
    resolvePath(input, issue.path) === undefined
  );
}

function describeReceivedKeys(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  return keys.length === 0 ? "received no keys" : `received keys: ${formatKeyNames(keys)}`;
}

function formatToolInputIssue(issue: ToolInputIssue, input: unknown): string {
  const label = issue.path.length > 0 ? issue.path.map(String).join(".") : "input";
  let text = `${label}: ${issue.message}`;
  // Zod v4 size messages state the limit but not the actual length, which is
  // the number the model needs to shorten its retry.
  if ((issue.code === "too_big" || issue.code === "too_small") && issue.origin === "string") {
    const value = resolvePath(input, issue.path);
    if (typeof value === "string") {
      text += ` (received ${value.length} characters)`;
    }
  }
  return text;
}

function resolvePath(input: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}
