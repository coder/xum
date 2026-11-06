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

const RECEIVED_MAX_KEYS = 10;
const DISPLAYABLE_KEY_MAX_CHARS = 40;
// Every tool parameter name is lowercase-led snake_case or camelCase without
// digits (the longest is 19 characters). Keys outside that shape are data a
// model put in the wrong place (tokens, paths, emails) and are only counted.
const DISPLAYABLE_KEY = /^[a-z][a-z_]*(?:[A-Z][a-z_]*)*$/;

/**
 * Render zod issues as one concise line: "<path>: <message>[ (received N characters)]".
 * Never echoes an input value: the AI SDK's own message does, which buries the
 * actionable issue under kilobytes of the model's rejected input, and this text
 * also reaches the shared log through the tool-error path, so a value could leak
 * a credential there.
 *
 * When a property is missing, the shape of what did arrive is appended: each
 * parameter-shaped key with its value's type and length, and a count of the
 * other keys, which could carry data. A model whose script arrived as 2
 * characters otherwise reads "script: expected string" and concludes it named
 * a field wrong, not that its text was cut.
 */
export function formatToolInputIssues(issues: readonly ToolInputIssue[], input: unknown): string {
  const text = issues.map((issue) => formatToolInputIssue(issue, input)).join("; ");
  const missing = issues.some((issue) => isMissingProperty(issue, input));
  return missing ? `${text}. Received arguments: ${describeReceivedArguments(input)}` : text;
}

// Paths resolve against the raw input, before any schema preprocess renames an
// alias key (bash `command` -> `script`), so an aliased key also reads as missing
// here; the received list then shows the alias as it arrived.
function isMissingProperty(issue: ToolInputIssue, input: unknown): boolean {
  return issue.code === "invalid_type" && resolvePath(input, issue.path) === undefined;
}

function describeReceivedArguments(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "no named arguments";
  }
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return "no arguments";
  }
  const displayable = entries.filter(([key]) => isDisplayableKey(key));
  const shown = describeDisplayableArguments(displayable);
  const hidden = entries.length - displayable.length;
  if (hidden === 0) {
    return shown;
  }
  const notShown = `${hidden} ${hidden === 1 ? "key" : "keys"} not shown`;
  return shown === "" ? notShown : `${shown} (${notShown})`;
}

function describeDisplayableArguments(entries: Array<[string, unknown]>): string {
  const parts = entries
    .slice(0, RECEIVED_MAX_KEYS)
    .map(([key, value]) => `${key}=${describeReceivedValue(value)}`);
  const more = entries.length - parts.length;
  return more > 0 ? `${parts.join(", ")} (+${more} more)` : parts.join(", ");
}

function isDisplayableKey(key: string): boolean {
  return key.length <= DISPLAYABLE_KEY_MAX_CHARS && DISPLAYABLE_KEY.test(key);
}

function describeReceivedValue(value: unknown): string {
  if (typeof value === "string") {
    return `string(${value.length} chars)`;
  }
  if (Array.isArray(value)) {
    return `array(${value.length} items)`;
  }
  return value === null ? "null" : typeof value;
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
