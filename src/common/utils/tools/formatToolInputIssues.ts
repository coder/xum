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
  keys?: readonly string[];
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

export const RECEIVED_ARGUMENTS_MARKER = "Received arguments: ";
export const UNRECOGNIZED_KEY_MARKER = "unrecognized key: ";
export const UNRECOGNIZED_KEYS_MARKER = "unrecognized keys: ";

const RECEIVED_MAX_KEYS = 10;
const DISPLAYABLE_KEY_MAX_CHARS = 40;
// Every tool parameter name is lowercase-led snake_case or camelCase without
// digits (the longest is 19 characters). Keys outside that shape are only
// counted, which keeps most misplaced data out of the model's retry text. This
// is a display rule: a lowercase-led credential still fits it, so the log copy
// is redacted separately (redactRejectedToolCallError).
const DISPLAYABLE_KEY = /^[a-z][a-z_]*(?:[A-Z][a-z_]*)*$/;
// A path segment can be model text (a record key). Escaping the characters the
// rendered line uses as structure keeps such a key from forging a clause that
// redactRejectedToolCallError would then log as-is.
const PATH_SEGMENT_ESCAPES: Record<string, string> = {
  "%": "%25",
  ";": "%3B",
  ":": "%3A",
  "\r": "%0D",
  "\n": "%0A",
};

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
  return missing
    ? `${text}. ${RECEIVED_ARGUMENTS_MARKER}${describeReceivedArguments(input)}`
    : text;
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
  return joinWithCounts(
    displayable.map(([key, value]) => `${key}=${describeReceivedValue(value)}`),
    entries.length - displayable.length
  );
}

// Zod's own message quotes each unrecognized key, so build the text from the
// keys under the same rule as the received list.
function describeUnrecognizedKeys(keys: readonly string[]): string {
  const displayable = keys.filter(isDisplayableKey);
  const hidden = keys.length - displayable.length;
  const marker = keys.length === 1 ? UNRECOGNIZED_KEY_MARKER : UNRECOGNIZED_KEYS_MARKER;
  if (displayable.length === 0) {
    return `${hidden} ${marker.slice(0, -": ".length)} not shown`;
  }
  return `${marker}${joinWithCounts(displayable, hidden)}`;
}

function joinWithCounts(parts: readonly string[], hidden: number): string {
  let text = parts.slice(0, RECEIVED_MAX_KEYS).join(", ");
  if (parts.length > RECEIVED_MAX_KEYS) {
    text += ` (+${parts.length - RECEIVED_MAX_KEYS} more)`;
  }
  if (hidden > 0) {
    const notShown = `${hidden} ${hidden === 1 ? "key" : "keys"} not shown`;
    text = text === "" ? notShown : `${text} (${notShown})`;
  }
  return text;
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
  const label = issue.path.length > 0 ? issue.path.map(encodePathSegment).join(".") : "input";
  if (issue.code === "unrecognized_keys") {
    // mutation-equivalent: keys is an array or undefined, so ?? and || agree
    return `${label}: ${describeUnrecognizedKeys(issue.keys ?? [])}`;
  }
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

function encodePathSegment(segment: PropertyKey): string {
  return String(segment).replace(/[%;:\r\n]/g, (char) => PATH_SEGMENT_ESCAPES[char]);
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
