/**
 * Credential-shape detection for text that reaches, or is about to be written to, memory.
 * Shared by the harvest transcript renderer (redacts before a model reads tool output) and the
 * guarded memory tool (rejects a write that carries a credential), so both agree on what a
 * secret looks like. A heuristic, not a vault: it catches common shapes, not every secret.
 *
 * The guard runs this on model-supplied text, so no pattern may backtrack quadratically. A
 * quantifier that a failed match rescans (a name suffix, a gap, a JWT segment, a PEM label) is
 * bounded or anchored to the start of a character run. Token bodies after a fixed prefix are left
 * open: once their minimum is met the match succeeds, so nothing rescans them, and a bound would
 * leave the tail of a long credential readable.
 */

const REDACTED = "[redacted]";

// `token` excludes the plural so `max_tokens: 4096` and `input_tokens` stay readable.
const SECRET_NAME = String.raw`(?:api[_-]?key|secret|token(?!s\b)|passw(?:or)?d|authorization|credential)`;
// Longest run after the name (`secret_access_key`, `token_endpoint_auth_method`) and widest gap
// of spaces around the separator that still count. Past these a pair is not recognized.
const NAME_SUFFIX_MAX = 48;
const GAP_MAX = 48;

// Credential shapes that are secret on their own, wherever they appear.
const STANDALONE_SECRET_PATTERNS: RegExp[] = [
  // An unterminated block (a tool that cut its own output) redacts through to the end of the text.
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  // Provider key prefixes: OpenAI/Anthropic, GitHub, Slack, AWS, Stripe, GitLab, Google, npm.
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|glpat-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{30,})/g,
  // A Slack incoming-webhook URL is a bearer secret in its path.
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/_-]{8,}/g,
  // `scheme://user:password@host`: only the userinfo goes, so the host stays readable. The user
  // may be empty (`redis://:password@host`).
  /(?<=:\/\/)[^\s:/@]{0,64}:[^\s/@]{1,256}(?=@)/g,
  new RegExp(String.raw`\bBearer\s{1,${GAP_MAX}}[A-Za-z0-9._~+/=-]{8,}`, "gi"),
  // Anchored to the start of a character run: `\b` also matches after `-`, so `eyJ-eyJ-eyJ-...`
  // would start a scan to the end of the run at every `eyJ`.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
];

// `key=value`, `key: value`, `"key": "value"`, `os.environ["KEY"] = "value"` and the same inside a
// JSON-escaped string (`\"key\": \"value\"`). The value is a quoted run (to its closing quote, or
// to the end of an unterminated one) or one unquoted word, optionally behind an auth scheme.
// Already-redacted values are skipped so the passes compose, and so are comparisons (`token === x`).
const SECRET_KEY_VALUE_PATTERN = new RegExp(
  String.raw`(${SECRET_NAME}[\w-]{0,${NAME_SUFFIX_MAX}}(?:\\?["']\]?)?\s{0,${GAP_MAX}}[:=]\s{0,${GAP_MAX}})` +
    String.raw`(?![=]|\[redacted\])(?:(\\?["'])[\s\S]*?(?:\2|$)|(?:(?:Basic|Bearer|Token|Digest)\s{1,${GAP_MAX}})?[^\s"'\\,;&}\])]+)`,
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
