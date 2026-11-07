/**
 * Credential-shape detection for text that reaches, or is about to be written to, memory.
 * Shared by the harvest transcript renderer (redacts before a model reads tool output) and the
 * guarded memory tool (rejects a write that carries a credential), so both agree on what a
 * secret looks like. A heuristic, not a vault: it catches common shapes, not every secret.
 */

const REDACTED = "[redacted]";

// `token` excludes the plural so `max_tokens: 4096` and `input_tokens` stay readable.
const SECRET_NAME = String.raw`(?:api[_-]?key|secret|token(?!s\b)|passw(?:or)?d|authorization|credential)`;
// Credential shapes that are secret on their own, wherever they appear.
const STANDALONE_SECRET_PATTERNS: RegExp[] = [
  // An unterminated block (a tool that cut its own output) redacts through to the end of the text.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16})/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
];

// `key=value`, `key: value`, `"key": "value"` and the same inside a JSON-escaped string
// (`\"key\": \"value\"`). The value is a quoted run (to its closing quote, or to the end of an
// unterminated one) or one unquoted word, optionally behind an auth scheme. Already-redacted
// values are skipped so the passes compose, and so are comparisons (`token === x`).
const SECRET_KEY_VALUE_PATTERN = new RegExp(
  String.raw`(${SECRET_NAME}[\w-]*\\?["']?\s*[:=]\s*)` +
    String.raw`(?![=]|\[redacted\])(?:(\\?["'])[\s\S]*?(?:\2|$)|(?:(?:Basic|Bearer|Token|Digest)\s+)?[^\s"'\\,;&}\])]+)`,
  "gi"
);

/** Replaces common credential shapes with `[redacted]`. */
export function redactSecretLike(text: string): string {
  let redacted = text;
  for (const pattern of STANDALONE_SECRET_PATTERNS) redacted = redacted.replace(pattern, REDACTED);
  return redacted.replace(
    SECRET_KEY_VALUE_PATTERN,
    (_match, prefix: string) => `${prefix}${REDACTED}`
  );
}

/** True when `text` holds a credential shape: redacting it would change it. */
export function containsSecretLike(text: string): boolean {
  return redactSecretLike(text) !== text;
}
