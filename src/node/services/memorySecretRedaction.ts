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

/**
 * Callers cut text at a cap. They scan this much past it, so a secret that starts inside the kept
 * text is matched whole before the cut, and not left as a readable prefix of it.
 */
export const REDACTION_LOOKAHEAD_CHARS = 512;

// `token` excludes the plural so `max_tokens: 4096` and `input_tokens` stay readable.
// `AccountKey` is the Azure storage connection string's secret and `SharedAccessKey` the Service Bus
// and Event Hubs one (its sibling `SharedAccessKeyName` is the policy's name, so it stays readable,
// as `AccountName` does); a key named `bearer` holds the token.
const SECRET_NAME = String.raw`(?:api[_-]?key|account[_-]?key|shared[_-]?access[_-]?key(?![_-]?name)|secret|token(?!s\b)|bearer|passw(?:or)?d|authorization|credential)`;
// Longest run after the name (`secret_access_key`, `token_endpoint_auth_method`) and widest gap
// of spaces around the separator that still count. Past these a pair is not recognized.
const NAME_SUFFIX_MAX = 48;
const GAP_MAX = 48;

const SIGNED_URL_PARAM = "(?:sig|signature|x-amz-signature|x-goog-signature)";

// Credential shapes that are secret on their own, wherever they appear.
const STANDALONE_SECRET_PATTERNS: RegExp[] = [
  // An unterminated block (a tool that cut its own output) redacts through to the end of the text.
  // A PGP armor header ends `PRIVATE KEY BLOCK-----`.
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  // Provider key prefixes: OpenAI/Anthropic, GitHub, Slack, AWS, Stripe, GitLab, Google, npm.
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|glpat-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{30,})/g,
  // A Slack incoming-webhook URL is a bearer secret in its path.
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/_-]{8,}/g,
  // `scheme://user:password@host`: only the userinfo goes, so the host stays readable. The user
  // may be empty (`redis://:password@host`).
  /(?<=:\/\/)[^\s:/@]{0,64}:[^\s/@]{1,256}(?=@)/g,
  new RegExp(String.raw`\bBearer\s{1,${GAP_MAX}}[A-Za-z0-9._~+/=-]{8,}`, "gi"),
  // A signed URL's signature is the credential: Azure SAS `sig`, `signature`, AWS `X-Amz-Signature`,
  // Google `X-Goog-Signature`. Only the value goes, and only in query position (after `?` or `&`,
  // `&amp;` too, as in XML listings). `signature` stays out of SECRET_NAME: the memory-write guard
  // reuses it, and prose such as `signature: foo(a, b)` must stay writable.
  new RegExp(String.raw`(?<=[?&](?:amp;)?${SIGNED_URL_PARAM}=)[^\s"'\\<>&#,;)\]}]+`, "gi"),
  // Anchored to the start of a character run: `\b` also matches after `-`, so `eyJ-eyJ-eyJ-...`
  // would start a scan to the end of the run at every `eyJ`.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
];

// A quoted value reads through backslash escapes, so an escaped quote inside the string does not
// end it: `{"password":"abc\"DEF"}` (what `JSON.stringify` makes of `abc"DEF`) must lose `DEF` too.
// Every position can take a character, except a closing delimiter and the end of the text, which
// end the value. So a match never fails and backtracks into the body, and the scan stays linear.
const QUOTED_VALUE = String.raw`(["'])(?:\\[\s\S]|(?!\2)[^\\]|\\$)*(?:\2|$)`;

// Text that went through JSON.stringify `d` times writes a quote as `2^d - 1` backslashes and a quote
// (`\"`, `\\\"`, `\\\\\\\"`), so a pair nested in JSON strings has delimiters of 1, 3, 7, 15 or 31
// backslashes: five layers. A pair nested deeper is not recognized.
const ESCAPE_RUN_MAX = 31;

// Where a nested value ends: its quote behind the opener's run of backslashes (`n`), or behind `n`
// plus a multiple of `2 * (n + 1)`, since a backslash the value itself ends in is written as that
// many at this depth. A quote behind any other run is the value's own: an escaped quote in it has
// one more escape level than the delimiter. The body reads a run whole, so only a run's start is
// checked. At one layer this is a run of one more than a multiple of four. Nothing is decoded.
const ESCAPED_CLOSE = String.raw`\k<run>(?:\k<run>\\\k<run>\\)*\k<quote>`;

// The pair inside JSON-escaped text. The body takes a character, or a whole run of backslashes
// unless the run is the close, so it stops only at the close or at the end of the text: a match
// never fails and backtracks, and a run costs its length plus a check bounded by the opener's. An
// unterminated value reads to the end of the text, so a credential the cap cut off is redacted.
const ESCAPED_QUOTED_VALUE = String.raw`(?<run>\\{1,${ESCAPE_RUN_MAX}})(?<quote>["'])(?:[^\\]|(?!${ESCAPED_CLOSE})\\+)*(?:${ESCAPED_CLOSE}|$)`;

// `key=value`, `key: value`, `"key": "value"`, `os.environ["KEY"] = "value"` and the same inside
// JSON-escaped text (`\"key\": \"value\"`, the key's closing quote behind a run of backslashes too).
// The value is a quoted run (to its closing quote, or to the end of an unterminated one) or one
// unquoted word, optionally behind an auth scheme.
// Already-redacted values are skipped so the passes compose, and so are comparisons (`token === x`).
const SECRET_KEY_VALUE_PATTERN = new RegExp(
  String.raw`(${SECRET_NAME}[\w-]{0,${NAME_SUFFIX_MAX}}(?:\\{0,${ESCAPE_RUN_MAX}}["']\]?)?\s{0,${GAP_MAX}}[:=]\s{0,${GAP_MAX}})` +
    String.raw`(?![=]|\[redacted\])(?:${QUOTED_VALUE}|${ESCAPED_QUOTED_VALUE}|(?:(?:Basic|Bearer|Token|Digest)\s{1,${GAP_MAX}})?[^\s"'\\,;&}\])]+)`,
  "gi"
);

// A session cookie is a bearer credential that has no keyword and no token shape of its own, so the
// header is the only thing that marks it. The value of a `Cookie` / `Set-Cookie` header goes, and
// the header name stays. A header's value ends at its line break (raw, or the escape of one in
// JSON text: `\n`, `\r`) or at the quote that closes it (a JSON string, a `curl -H "..."`), so the
// body takes everything but those, and a backslash that does not start an escape. The header may
// also be a JSON key (`"cookie": "a=b"`, its opening quote kept so the quotes stay paired), whose
// value may be an array (`"set-cookie": ["a=b", "c=d"]`, Node's shape), read to its `]`.
// What tells a header from prose is its value, not where it sits: a cookie header's value is
// `name=value` pairs (or a list of them), while a sentence such as `Session cookie: HttpOnly is set`
// has words. Positions draw a new case every time a header turns up in a new frame (Markdown
// emphasis, a numbered list, `Host: x; Cookie: a=b` on one line, Go's `map[Cookie:[a=b]]`), so the
// name counts after any character that cannot be part of a longer name (`getCookie:` and
// `X-Cookie-Policy:` stay readable), and `redactCookieValue` leaves a value that is not a cookie
// pair alone. The memory-write guard reuses this detector, so a note about cookies stays writable.
// Linear: once the colon matched, the body and the array never fail and never backtrack, as
// `QUOTED_VALUE` is (a run of body characters, or of backslashes, is one step: a step per backslash
// cost 50 ms on 100 KB of them); the name, the context, the key's quote and the gaps are bounded,
// and the value is read once, since the match ends it. The context is read backwards from the
// name, so the scan pays for it only at the word `cookie`. A value that needs a check the pattern
// cannot make without backtracking (see `redactCookieValue`) is read whole and judged afterwards.
const COOKIE_NAME = "(?:Set-)?Cookie";
// Behind the name: the start of the text, a character that cannot be part of a longer name, or the
// escape of a line break in JSON text (`\n` ends in a letter).
const COOKIE_CONTEXT = String.raw`(?:^|[^\w-]|\\[nr])`;
const COOKIE_KEY_QUOTE = String.raw`(?:\\{0,${ESCAPE_RUN_MAX}}["'])`;
const COOKIE_HEADER_PATTERN = new RegExp(
  String.raw`(${COOKIE_NAME}(?<=${COOKIE_CONTEXT}${COOKIE_NAME})${COOKIE_KEY_QUOTE}?[ \t]{0,${GAP_MAX}}:[ \t]{0,${GAP_MAX}})` +
    // A marker read back (`[redacted]`) is read to the end of the header like any value, so a cookie
    // pair after it is judged too (`redactCookieValue`); any other `[` starts a list, read to its `]`.
    String.raw`(?:\[redacted\](?:[^\r\n"'\\]+|\\+(?![nr"']))*|\[[^\]]*\]?|(${COOKIE_KEY_QUOTE}?)(?:[^\r\n"'\\]+|\\+(?![nr"']))*)`,
  "gi"
);

/** A value that stays as it is: none (only spaces, or an array with nothing in it). */
const EMPTY_COOKIE_VALUE = /^\s*(?:$|\[\s*\]?$)/;
/** An already-redacted value: `[redacted]`, then attributes or nothing, but no other cookie pair. */
const REDACTED_COOKIE_VALUE = /^\s*\[redacted\]/;
/**
 * A `name=` after the marker that is not a Set-Cookie attribute (RFC 6265: Path, Domain, Expires,
 * Max-Age, SameSite; Secure and HttpOnly take no value): another cookie the marker does not cover.
 */
const COOKIE_PAIR_AFTER_MARKER =
  /[\s;,"'](?!(?:path|domain|expires|max-age|samesite|priority)=)[^\s=;,"'\\[\]]+=/i;
/** A header value: a `name=value` pair first, or a list (`[...]`, Node's and Go's shapes). */
const COOKIE_HEADER_VALUE = /^\s*(?:\[|[^\s=;,"'\\[\]]+=)/;

/**
 * What a matched cookie header becomes. The match runs to the end of the header whatever the value
 * is, and this decides what to do with it: an empty value is no credential (`Cookie:` in a note),
 * and one that is already `[redacted]` stays as it is (`Cookie: "[redacted]; Path=/"` is not a new
 * one), so the passes compose, as the key/value rule's do, and the write guard accepts a note that
 * quotes redacted text. Checked here and not in the pattern, where a lookahead before the value
 * lets the gap give a space back, and the value start there.
 */
function redactCookieValue(match: string, prefix: string, opener: string | undefined): string {
  // mutation-equivalent: `opener` is a string or undefined, never a falsy string that `||` would
  // replace with another one, so `??` and `||` agree.
  const quote = opener ?? "";
  const value = match.slice(prefix.length + quote.length);
  if (EMPTY_COOKIE_VALUE.test(value)) return match;
  // A marker read back from an earlier pass is not a new credential, unless a cookie pair follows it.
  if (REDACTED_COOKIE_VALUE.test(value)) {
    if (!COOKIE_PAIR_AFTER_MARKER.test(value)) return match;
  } else if (!COOKIE_HEADER_VALUE.test(value)) {
    return match;
  }
  return `${prefix}${quote}${REDACTED}`;
}

/** Replaces common credential shapes with `[redacted]`. */
export function redactSecretLike(text: string): string {
  // First, while the value is still whole: a standalone pattern that redacts the head of a cookie
  // would end the value there and leave its tail readable.
  let redacted = text.replace(COOKIE_HEADER_PATTERN, redactCookieValue);
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
