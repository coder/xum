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

/** What a redacted value becomes. */
export const REDACTED = "[redacted]";

/**
 * Callers cut text at a cap. They scan this much past it, so a secret that starts inside the kept
 * text is matched whole before the cut, and not left as a readable prefix of it. `redactWithinCap`
 * reads the window and keeps the lookahead out of what is shown.
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
// Where a signed URL's value starts, and the characters that end it.
const SIGNED_URL_VALUE_START = String.raw`(?<=[?&](?:amp;)?${SIGNED_URL_PARAM}=)`;
const SIGNED_URL_VALUE_END = String.raw`\s"'\\<>&#,;)\]}`;

// `scheme://user:password@host`: only the userinfo goes, so the host stays readable. The user may be
// empty (`redis://:password@host`). Its user and password take any character but the delimiters, so
// they read across a marker and the text behind it, up to their bounds.
const USERINFO_PATTERN = /(?<=:\/\/)[^\s:/@]{0,64}:[^\s/@]{1,256}(?=@)/g;

// Credential shapes that are secret on their own, wherever they appear.
const STANDALONE_SECRET_PATTERNS: RegExp[] = [
  // An unterminated block (a tool that cut its own output) redacts through to the end of the text.
  // A PGP armor header ends `PRIVATE KEY BLOCK-----`.
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  // Provider key prefixes: OpenAI/Anthropic, GitHub, Slack, AWS, Stripe, GitLab, Google, npm.
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|glpat-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{30,})/g,
  // A Slack incoming-webhook URL is a bearer secret in its path.
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/_-]{8,}/g,
  USERINFO_PATTERN,
  new RegExp(String.raw`\bBearer\s{1,${GAP_MAX}}[A-Za-z0-9._~+/=-]{8,}`, "gi"),
  // A signed URL's signature is the credential: Azure SAS `sig`, `signature`, AWS `X-Amz-Signature`,
  // Google `X-Goog-Signature`. Only the value goes, and only in query position (after `?` or `&`,
  // `&amp;` too, as in XML listings). `signature` stays out of SECRET_NAME: the memory-write guard
  // reuses it, and prose such as `signature: foo(a, b)` must stay writable.
  new RegExp(String.raw`${SIGNED_URL_VALUE_START}[^${SIGNED_URL_VALUE_END}]+`, "gi"),
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
// What goes on after a skipped marker is read by the marker tail pattern below.
const KEY_VALUE_PREFIX = String.raw`${SECRET_NAME}[\w-]{0,${NAME_SUFFIX_MAX}}(?:\\{0,${ESCAPE_RUN_MAX}}["']\]?)?\s{0,${GAP_MAX}}[:=]\s{0,${GAP_MAX}}`;
// The characters that end an unquoted value.
const UNQUOTED_VALUE_END = String.raw`\s"'\\,;&}\])`;
const SECRET_KEY_VALUE_PATTERN = new RegExp(
  `(${KEY_VALUE_PREFIX})` +
    String.raw`(?![=]|\[redacted\])(?:${QUOTED_VALUE}|${ESCAPED_QUOTED_VALUE}|(?:(?:Basic|Bearer|Token|Digest)\s{1,${GAP_MAX}})?[^${UNQUOTED_VALUE_END}]+)`,
  "gi"
);

// A value that goes on after a marker. A pass that redacts part of a value leaves the marker inside
// it (`sig=abc.<key>.xyz` is `sig=abc.[redacted].xyz` once the key pattern ran), and a value that a
// model writes beside a marker starts with it (`password=[redacted]SEKRIT`). The two patterns above
// end a value at the marker's `]` or skip a value that starts with the marker, so the rest stayed
// readable, and the write guard accepted it. A marker is no end of a value: the value goes on through
// the characters that would continue it without the marker, and through a `]` that a character of
// the value follows (the marker's own bracket, which the pass that cut the value there leaves behind,
// or a bracket inside the value: ending at it would leave `[redacted]]d]Z` for a second pass to cut
// again). A marker with no letter or digit after it (punctuation, or more markers) is a redacted
// value, and stays as it is: a note that quotes one puts a backtick or a full stop behind it.
// This runs after every other pass, on what they left, and only puts the marker over a span of their
// output, so it never redacts less than they do. Extending their patterns would take the tail in
// their pass, and a later pass would no longer read what it holds (`token="SEKRIT"` or a
// `Cookie:` header glued to the marker).
// Linear: a marker, then characters of a class and markers with nothing after them.
const MARKER_SOURCE = String.raw`\[redacted\]`;
// A letter or digit outside the markers decides that a value goes on. Once it does, the punctuation
// before and after that letter goes with it, as it does when no marker is there.
function markerTail(valueEnd: string): string {
  const mark = String.raw`${MARKER_SOURCE}|\](?=[^${valueEnd}])`;
  const alnum = "A-Za-z0-9";
  return (
    String.raw`${MARKER_SOURCE}(?=(?:${mark}|(?!${MARKER_SOURCE})[^${valueEnd}${alnum}])*[${alnum}])` +
    String.raw`(?:[^${valueEnd}\[]+|${mark}|\[)+`
  );
}
const KEY_MARKER_TAIL_PATTERN = new RegExp(
  `(${KEY_VALUE_PREFIX})` + markerTail(UNQUOTED_VALUE_END),
  "gi"
);
const SIGNED_URL_MARKER_TAIL_PATTERN = new RegExp(
  SIGNED_URL_VALUE_START + markerTail(SIGNED_URL_VALUE_END),
  "gi"
);
// What both patterns need: a marker with a character after it that no value ends at (the signed-URL
// set holds all of the key pair's, so this one is the wider). Most text has none, and then a scan
// for a key or a parameter, which reads the whole text, would find nothing.
const MARKER_TAIL_CANDIDATE = new RegExp(
  String.raw`${MARKER_SOURCE}\]?[^${UNQUOTED_VALUE_END}]`,
  "i"
);

// A session cookie is a bearer credential that has no keyword and no token shape of its own, so the
// header is the only thing that marks it. The value of a `Cookie` / `Set-Cookie` header goes, and
// the header name stays. A header's value ends at its line break (raw, or the escape of one in
// JSON text: `\n`, `\r`) or at the quote that closes it (a JSON string, a `curl -H "..."`), so the
// body takes everything but those, and a backslash that does not start an escape. The header may
// also be a JSON key (`"cookie": "a=b"`, its opening quote kept so the quotes stay paired), whose
// value may be an array (`"set-cookie": ["a=b", "c=d"]`, Node's shape), read to its `]`.
// A name starts after a non-word character, so `getCookie:` and `X-Cookie:` are not headers; after
// an escaped line break it starts behind the letter of `\n`. A prose line that begins with
// `cookie:` is redacted to its end: the name and the colon are all this rule can see.
// Linear: the body and the array never fail and never backtrack, as `QUOTED_VALUE` is (a run of
// body characters is one step); the name, the key's quote and the gaps are bounded, and the value
// is read once, since the match ends it.
const COOKIE_HEADER_PATTERN = new RegExp(
  String.raw`(?:(?<![\w-])|(?<=\\[nr]))` +
    String.raw`((?:Set-)?Cookie(?:\\{0,${ESCAPE_RUN_MAX}}["'])?[ \t]{0,${GAP_MAX}}:[ \t]{0,${GAP_MAX}})` +
    String.raw`(?:\[[^\]]*\]?|((?:\\{0,${ESCAPE_RUN_MAX}}["'])?)(?:[^\r\n"'\\]+|\\(?![nr"']))*)`,
  "gi"
);

// A session cookie is a bearer credential that has no keyword and no token shape of its own, so the
// header is the only thing that marks it. The value of a `Cookie` / `Set-Cookie` header goes, and
// the header name stays. A hand-written forward reader, not a regex: one rule holds it together,
// a value is never ended by its own content, only by the end of its frame (a raw line, a quoted
// string, a JSON string at some depth). Each content-based end a regex tried (a quote, a `]`, a `;`
// after a marker) was a way to leave the rest of the value readable.
// The reader judges no shape of the value, so a prose line with `cookie:` in it is redacted to the
// end of its frame. A value of only blanks, or only the marker, is left as it is.
// Linear: the index only moves forward, a failed header costs its name, key quote and gap (which
// holds no name, so no other candidate reads it), and every backslash run is read once and
// classified by arithmetic. No regex runs over a value; the ones below test a single character.
// Not covered (each needs another name, or a value on the next line): curl `-b` / `--cookie`,
// `document.cookie = "..."`, a YAML list under a `cookie:` key, obs-fold continuation lines,
// `cookies={'sid': ...}` and Python header tuples (`[('Cookie', 'sid=...')]`).

/** A quoted frame: its quote, and the backslash run that escapes that quote at the frame's depth. */
interface QuotedFrame {
  quote: string;
  run: number;
}

/** Where a header value must end at the latest. `null` is a raw frame: a raw line or the text. */
type Frame = QuotedFrame | null;

/** A cookie header found at some index: where its value starts, and how it may end. */
interface CookieHeader {
  valueStart: number;
  frame: Frame;
  /** The name was a quoted key (`"cookie": ...`), so syntax after a quoted or list value ends it. */
  keyForm: boolean;
}

/**
 * How a quoted unit or a list ended: `closed` by its own delimiter, `stopped` at its frame's end,
 * or at a raw `line` break (an unbalanced list item). The value's span ends at `end`; reading
 * resumes at `next`.
 */
interface UnitEnd {
  kind: "closed" | "stopped" | "line";
  end: number;
  next: number;
}

/** What the reader knows about the text just before the index it is at. */
interface HintState {
  /** The frame a header that starts here sits in, read from the characters before it. */
  frame: Frame;
  /** Line markers passed since `frame` was set. */
  markers: number;
  /** Where the last replacement ended: what follows there follows `[redacted]`. */
  redactedEnd: number;
  /** The quote of the string open at each depth, by the run that escapes it there. */
  openQuotes: Map<number, string>;
}

const BACKSLASH = 92;
const QUOTE = /["']/;
const LINE_BREAK = /[\r\n]/;
const BLANK = /[ \t]/;
const ESCAPED_BREAK = /[nr]/;
// An escaped tab also ends the word before a name (`a\tCookie:` in JSON text).
const ESCAPED_SPACE = /[nrt]/;
const WORD_CHAR = /[A-Za-z0-9_-]/;
const HEADER_NAME = /(?:set-)?cookie/iy;
// What a Markdown list, quote, emphasis or code span, a numbered list or a curl trace (`> `) puts
// between a frame's opening and the header: up to this many keep the frame.
const LINE_MARKER = /[ \t>*_+#.0-9)`\-<]/;
const LINE_MARKER_MAX = 16;
// A quote opens a frame only after these (or at the start of the text): `"x" Cookie:` and
// `say \"hi\" Cookie:` pass a closing quote, after which the header sits in raw text.
const QUOTE_OPENS_AFTER = /[\s=([{,:]/;
// A quote closes a frame only before these (or the end of the text). Before `;`, a quote or a cookie
// character it is the value's own (`-H "Cookie: sid="S""`).
const CLOSE_FOLLOWER = /[\s,)\]}:`]/;
// An escape after a close is a line break or a tab, which follow a string, not one that sits
// inside it: `sid="S"\x1b[0m; b=S` in a string that escapes the color code goes on past its quote.
const ESCAPE_AFTER_CLOSE = /[nrt]/;
const LIST_ITEM_START = /[\s,[]/;
// After a quoted key's quoted or list value, these end it: JSON, JS and Python always look so.
const KEY_VALUE_END = /[,}\])]/;

function runLength(text: string, at: number): number {
  let end = at;
  while (text.charCodeAt(end) === BACKSLASH) end++;
  return end - at;
}

// Text that went through JSON.stringify writes a quote at depth `n` behind `depthRun` backslashes,
// and a backslash of its own as `2 * (depthRun + 1)` more, so a run of `depthRun` plus a multiple
// of that is the depth's delimiter; any other run escapes the character after it.
function isDepthRun(run: number, depthRun: number): boolean {
  return run >= depthRun && (run - depthRun) % (2 * (depthRun + 1)) === 0;
}

function followsClose(text: string, at: number): boolean {
  const follower = text.charAt(at);
  if (follower !== "\\") return follower === "" || CLOSE_FOLLOWER.test(follower);
  return ESCAPE_AFTER_CLOSE.test(text.charAt(at + runLength(text, at)));
}

/** True when the backslash run at `at` and the quote after it close `frame`. */
function closesFrame(text: string, at: number, run: number, frame: QuotedFrame): boolean {
  return (
    text.charAt(at + run) === frame.quote &&
    isDepthRun(run, frame.run) &&
    followsClose(text, at + run + 1)
  );
}

/** Where `frame` ends if it ends at the backslash run at `at` and the character after it, else -1. */
function frameEnd(text: string, at: number, run: number, frame: Frame): number {
  const char = text.charAt(at + run);
  if (char === "" || LINE_BREAK.test(char)) return at + run;
  if (frame === null) return -1;
  if (closesFrame(text, at, run, frame)) return at + run - frame.run;
  // An escaped line break at this depth: `n` or `r` behind one more escape than the quote.
  return ESCAPED_BREAK.test(char) && isDepthRun(run - 1, frame.run) ? at + run - frame.run - 1 : -1;
}

/** A list's frame ends only at the end of the text or its close quote: lists cross line breaks. */
function listFrameEnd(text: string, at: number, run: number, frame: Frame): number {
  // mutation-equivalent: an end past the text reads as its end, as `slice` clamps it
  if (at + run >= text.length) return at + run;
  return frame !== null && closesFrame(text, at, run, frame) ? at + run - frame.run : -1;
}

function readToFrameEnd(text: string, at: number, frame: Frame): number {
  for (let pos = at; ; ) {
    const run = runLength(text, pos);
    const end = frameEnd(text, pos, run, frame);
    if (end !== -1) return end;
    pos += run + 1;
  }
}

/** Reads a quoted unit to its close quote, or to where `stop` ends its frame, in one pass. */
function readQuoted(
  text: string,
  at: number,
  unit: QuotedFrame,
  stop: (pos: number, run: number) => number
): UnitEnd {
  for (let pos = at; ; ) {
    const run = runLength(text, pos);
    if (closesFrame(text, pos, run, unit)) {
      return { kind: "closed", end: pos + run - unit.run, next: pos + run + 1 };
    }
    const end = stop(pos, run);
    if (end !== -1) return { kind: "stopped", end, next: end };
    if (LINE_BREAK.test(text.charAt(pos + run))) {
      // mutation-equivalent: a list resumes at a line unit's `next` and never reads its `end`
      return { kind: "line", end: pos + run, next: pos + run };
    }
    pos += run + 1;
  }
}

function bracketDepthChange(char: string, run: number): number {
  if (run > 0) return 0;
  if (char === "[") return 1;
  return char === "]" ? -1 : 0;
}

/**
 * Reads a list to its matching `]`. A quote opens an item only at an item's start, so the `'` of
 * `[it's x]` is content, and an item read whole keeps a `]` in it from closing the list. An item
 * also ends at a raw line break, so an unbalanced one cannot swallow the rest of the text.
 */
function readList(text: string, at: number, frame: Frame): UnitEnd {
  const stop = (pos: number, run: number): number => listFrameEnd(text, pos, run, frame);
  let depth = 1;
  let itemStart = true;
  for (let pos = at; ; ) {
    const run = runLength(text, pos);
    const stopped = stop(pos, run);
    if (stopped !== -1) return { kind: "stopped", end: stopped, next: stopped };
    const char = text.charAt(pos + run);
    if (itemStart && QUOTE.test(char)) {
      const item = readQuoted(text, pos + run + 1, { quote: char, run }, stop);
      // mutation-equivalent: without it the list resumes at the item's stop, where its frame stops it
      // again at the same index
      if (item.kind === "stopped") return item;
      pos = item.next;
    } else {
      depth += bracketDepthChange(char, run);
      if (depth === 0) return { kind: "closed", end: pos + 1, next: pos + 1 };
      pos += run + 1;
    }
    itemStart = run === 0 && LIST_ITEM_START.test(char);
  }
}

function skipBlanks(text: string, at: number): number {
  let end = at;
  while (BLANK.test(text.charAt(end))) end++;
  return end;
}

/** True when a quoted key's value ends after its unit: next comes syntax, a line or the frame. */
function keyValueEnds(text: string, at: number, frame: Frame): boolean {
  const next = skipBlanks(text, at);
  return (
    KEY_VALUE_END.test(text.charAt(next)) ||
    frameEnd(text, next, runLength(text, next), frame) !== -1
  );
}

/**
 * A quoted or list unit decides only where the frame's end tests begin, so its `"` or `]` is not
 * taken for the frame's. Behind a quoted key, syntax after the unit ends the value; anything else
 * (`"cookie": "a"; sid=S`) is more value.
 */
function settleValue(
  text: string,
  header: CookieHeader,
  start: number,
  unit: UnitEnd
): { start: number; end: number } {
  // mutation-equivalent: a stopped unit's `next` is its frame's end, so reading on from there, or
  // testing a key's syntax there, ends at the same index
  if (unit.kind !== "closed") return { start, end: unit.end };
  if (header.keyForm && keyValueEnds(text, unit.next, header.frame)) {
    return { start, end: unit.end };
  }
  return { start, end: readToFrameEnd(text, unit.next, header.frame) };
}

function readQuotedValue(
  text: string,
  header: CookieHeader,
  run: number,
  quote: string
): { start: number; end: number } {
  const { valueStart: start, frame } = header;
  const contentStart = start + run + 1;
  const stop = (pos: number, posRun: number): number => frameEnd(text, pos, posRun, frame);
  const unit = readQuoted(text, contentStart, { quote, run }, stop);
  const value = settleValue(text, header, start, unit);
  // mutation-equivalent: a value that is no key's always reads past its unit's close, so its end is
  // never the unit's
  if (!header.keyForm || unit.kind !== "closed" || value.end !== unit.end) return value;
  // A quoted key's value that ends at its own close goes with both its quotes. A kept quote pair
  // around the marker would not read back the same: the regex pass eats all but one backslash of
  // a close quote's run (`\\"`), and a lone kept quote would close at the frame's quote after it.
  // The pair around the marker alone is what the regex pass writes, and it stays.
  const marker = text.slice(contentStart, unit.end) === REDACTED;
  return marker ? { start: unit.next, end: unit.next } : { start, end: unit.next };
}

function readValue(text: string, header: CookieHeader): { start: number; end: number } {
  const { valueStart: start, frame } = header;
  const run = runLength(text, start);
  const opener = text.charAt(start + run);
  // A quote here opens the value, before any frame test: read as the frame's close, it would leave
  // `'Cookie: ' sid=S'` an empty value with the pair after it readable. The cost: the value of an
  // empty header in a quoted argument (`-H "Cookie: " url`) runs to the end of the line.
  if (QUOTE.test(opener)) return readQuotedValue(text, header, run, opener);
  const endsAtOnce = frameEnd(text, start, run, frame);
  // mutation-equivalent: no frame ends at a `[`, and reading to the frame's end from here makes the
  // same first test
  if (endsAtOnce !== -1) return { start, end: endsAtOnce };
  if (run === 0 && opener === "[") {
    return settleValue(text, header, start, readList(text, start + 1, frame));
  }
  return { start, end: readToFrameEnd(text, start, frame) };
}

/**
 * A name starts after a non-word character, so `getCookie:` and `X-Cookie:` are not headers; after
 * an escaped line break or tab behind the letter of its escape.
 */
function startsName(text: string, at: number): boolean {
  const before = text.charAt(at - 1);
  if (!WORD_CHAR.test(before)) return true;
  return ESCAPED_SPACE.test(before) && text.charAt(at - 2) === "\\";
}

function matchName(text: string, at: number): number | null {
  HEADER_NAME.lastIndex = at;
  const name = HEADER_NAME.exec(text);
  return name === null ? null : at + name[0].length;
}

// A quoted key sits in a JSON string at the depth its closing quote's run (`2^d - 1`) shows, and
// that string's close ends the value; another run is no depth, so its frame is raw.
function keyFrame(quote: string, run: number): Frame {
  // mutation-equivalent: a fractional run never closes a frame, so it reads as raw
  return run > 0 && (run & (run + 1)) === 0 ? { quote, run: (run - 1) / 2 } : null;
}

function matchHeader(text: string, at: number, state: HintState): CookieHeader | null {
  const nameEnd = matchName(text, at);
  if (nameEnd === null || !startsName(text, at)) return null;
  const keyRun = runLength(text, nameEnd);
  const keyQuote = text.charAt(nameEnd + keyRun);
  // Any run before the quote makes a key: the scan reads the run once, so it needs no bound, and a
  // run that is no JSON depth gives a raw frame.
  const keyForm = QUOTE.test(keyQuote);
  const colon = skipBlanks(text, keyForm ? nameEnd + keyRun + 1 : nameEnd);
  if (text.charAt(colon) !== ":") return null;
  const frame = keyForm ? keyFrame(keyQuote, keyRun) : state.frame;
  return { valueStart: skipBlanks(text, colon + 1), frame, keyForm };
}

function setHint(state: HintState, frame: Frame): void {
  Object.assign(state, { frame, markers: 0 });
}

// A quote opens a string at its depth, the same quote closes it, and the other quote inside it is
// content (`'h'` in `b"{ host: 'h' }"`, Python's repr of a JS object).
function trackOpenQuote(openQuotes: Map<number, string>, quote: string, run: number): void {
  const open = openQuotes.get(run);
  if (open === undefined) openQuotes.set(run, quote);
  else if (open === quote) openQuotes.delete(run);
}

function noteQuote(text: string, runStart: number, quote: string, run: number, state: HintState) {
  // The `]` of a marker written here opens nothing, so a second pass reads this quote as the first.
  trackOpenQuote(state.openQuotes, quote, run);
  const before = runStart === state.redactedEnd ? "]" : text.charAt(runStart - 1);
  const opens = runStart === 0 || QUOTE_OPENS_AFTER.test(before);
  setHint(state, opens ? { quote, run } : null);
}

/**
 * An escaped line break at depth `d` is a run of `2^(d-1)` backslashes, so the largest power of two
 * that divides the run gives the depth, and the string around it closes on a run one shorter, with
 * the quote of the string open at that depth. With no string open there the escapes are not JSON's
 * alone (Python's repr inside JSON writes its `'` and `"` unescaped), so the frame is raw: a guessed
 * quote could close the frame inside the value.
 */
function escapedBreakFrame(run: number, state: HintState): Frame {
  const depthRun = (run & -run) - 1;
  const quote = state.openQuotes.get(depthRun);
  return quote === undefined ? null : { quote, run: depthRun };
}

function advanceRun(text: string, at: number, state: HintState): number {
  const run = runLength(text, at);
  const char = text.charAt(at + run);
  if (QUOTE.test(char)) noteQuote(text, at, char, run, state);
  else if (ESCAPED_SPACE.test(char)) setHint(state, escapedBreakFrame(run, state));
  else {
    state.frame = null;
    return at + run;
  }
  return at + run + 1;
}

/** Moves past the character (or backslash run) at `at` and updates the frame hint for it. */
function advanceHint(text: string, at: number, state: HintState): number {
  const char = text.charAt(at);
  if (char === "\\") return advanceRun(text, at, state);
  if (QUOTE.test(char)) noteQuote(text, at, char, 0, state);
  else if (LINE_MARKER.test(char) && state.markers < LINE_MARKER_MAX) state.markers++;
  else state.frame = null;
  return at + 1;
}

function redactCookieHeaders(text: string, onRemoved: (removed: string) => void): string {
  const state: HintState = {
    frame: null,
    // mutation-equivalent: with no frame yet, markers count for nothing
    markers: 0,
    // mutation-equivalent: a quote at index 0 opens a frame anyway
    redactedEnd: -1,
    openQuotes: new Map(),
  };
  const parts: string[] = [];
  let copied = 0;
  let at = 0;
  // mutation-equivalent: at the text's end no header matches and the step leaves the loop
  while (at < text.length) {
    const header = matchHeader(text, at, state);
    if (header === null) {
      at = advanceHint(text, at, state);
      continue;
    }
    const value = readValue(text, header);
    let end = value.end;
    // Trailing blanks stay, so `Cookie: [redacted] ` reads back as the marker.
    // mutation-equivalent: an end before the start slices to "", as an empty value does
    while (end > value.start && BLANK.test(text.charAt(end - 1))) end--;
    const removed = text.slice(value.start, end);
    if (removed !== "" && removed !== REDACTED) {
      parts.push(text.slice(copied, value.start), REDACTED);
      copied = end;
      state.redactedEnd = end;
      onRemoved(removed);
    }
    setHint(state, null);
    // mutation-equivalent: the value ends after the header's name, and only blanks lie between the
    // trimmed end and this one, which change no hint once it is cleared
    at = value.end;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

/** Puts the marker over what goes on after a marker in a value (see `KEY_MARKER_TAIL_PATTERN`). */
function redactMarkerTails(text: string, onRemoved: (removed: string) => void): string {
  if (!MARKER_TAIL_CANDIDATE.test(text)) return text;
  const keyed = text.replace(KEY_MARKER_TAIL_PATTERN, (match: string, prefix: string) => {
    onRemoved(match.slice(prefix.length));
    return `${prefix}${REDACTED}`;
  });
  return keyed.replace(SIGNED_URL_MARKER_TAIL_PATTERN, (match: string) => {
    onRemoved(match);
    return REDACTED;
  });
}

/**
 * Which passes took a value out: main's regex passes, the reader that runs on their output, the
 * marker tails after that, or the userinfo pattern on a text that a tail cut (`cut`). The write
 * guard compares each apart, so its verdict on the regex passes' values is main's own: a value that
 * the reader, a tail or the cut text takes out of the previous text never excuses one the regex
 * takes out of the new.
 */
type RemovalSource = "regex" | "reader" | "tail" | "cut";

/** The regex passes and the reader, in order, each on the previous pass's output. */
function runPassesBeforeTails(
  text: string,
  onRemoved: (removed: string, source: RemovalSource) => void
): string {
  const fromRegex = (removed: string): void => onRemoved(removed, "regex");
  // First, while the value is still whole: a standalone pattern that redacts the head of a cookie
  // would end the value there and leave its tail readable.
  let redacted = text.replace(
    COOKIE_HEADER_PATTERN,
    (match: string, prefix: string, opener: string | undefined) => {
      // mutation-equivalent: `opener` is undefined or a string, and "" or undefined both add nothing
      const kept = `${prefix}${opener ?? ""}`;
      fromRegex(match.slice(kept.length));
      return `${kept}${REDACTED}`;
    }
  );
  for (const pattern of STANDALONE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match: string) => {
      fromRegex(match);
      return REDACTED;
    });
  }
  redacted = redacted.replace(SECRET_KEY_VALUE_PATTERN, (match: string, prefix: string) => {
    fromRegex(match.slice(prefix.length));
    return `${prefix}${REDACTED}`;
  });
  // Last, on what the passes above left: the reader only replaces spans of their output with the
  // marker, so it never brings back a character they took out. It adds the rest of a value that
  // the regex ended early (at a quote, a `]` or a marker inside it), and never redacts less.
  return redactCookieHeaders(redacted, (removed) => onRemoved(removed, "reader"));
}

/**
 * The redaction passes, in order, each on the previous pass's output. `onRemoved` hears what each
 * replacement took out, so a caller can tell credentials apart instead of only counting them.
 */
function runRedactionPasses(
  text: string,
  onRemoved: (removed: string, source: RemovalSource) => void
): string {
  const redacted = runPassesBeforeTails(text, onRemoved);
  const tailed = redactMarkerTails(redacted, (removed) => onRemoved(removed, "tail"));
  if (tailed === redacted) return tailed;
  // The tail pass shortened the text, and the userinfo pattern bounds its user and its password: a
  // URL that was too long to match before the cut matches after it, and a second call would take the
  // password. It reads the cut text once more, so one call leaves a text that a second does not
  // change. No other pattern reads across the text that a tail cut (a key's prefix and a signed-URL
  // value stop at the marker), and the value it takes out is reported apart.
  return tailed.replace(USERINFO_PATTERN, (match: string) => {
    onRemoved(match, "cut");
    return REDACTED;
  });
}

/** Replaces common credential shapes with `[redacted]`. */
export function redactSecretLike(text: string): string {
  return runRedactionPasses(text, () => undefined);
}

/**
 * True when `updated` holds a credential shape `previous` did not: the values redaction takes out
 * of `updated` are not all among (as a multiset) those it takes out of `previous`. Comparing values,
 * not a count, refuses an edit that drops one credential and assembles another. The accepted cost:
 * an edit inside a matched span (rewording the rest of a quoted value beside `password:`, trimming a
 * key) makes a new value and is refused too, though it adds no secret.
 */
export function addsSecretLike(previous: string, updated: string): boolean {
  const held: Record<RemovalSource, Map<string, number>> = {
    regex: new Map(),
    reader: new Map(),
    tail: new Map(),
    cut: new Map(),
  };
  runRedactionPasses(previous, (removed, source) => {
    // mutation-equivalent: a held count only grows here, so it is undefined or at least 1
    held[source].set(removed, (held[source].get(removed) ?? 0) + 1);
  });
  let added = false;
  runRedactionPasses(updated, (removed, source) => {
    // mutation-equivalent: a count of 0 and a missing one both read as 0
    const left = held[source].get(removed) ?? 0;
    if (left === 0) added = true;
    else held[source].set(removed, left - 1);
  });
  return added;
}

/**
 * `text` redacted, and cut at its first `cap` characters, with the rest of `text` as a lookahead: a
 * secret that starts inside the cap is matched whole, and no output from past the cap is shown.
 * Redaction shortens text, so cutting its output at `cap` characters reaches the lookahead's end,
 * where a key that the end cut is too short to match shows as it is. The cut is in the characters
 * of `text` instead: redacting its first `cap` characters alone shows only those, except that it
 * leaves the start of a secret that crosses the cap. Where the redacted whole differs from that,
 * the whole has taken the secret, and its marker stands in for the start. Redaction can also
 * lengthen text (a one-character value becomes a marker), so the result can be longer than `cap`.
 */
export function redactWithinCap(text: string, cap: number): string {
  const whole = redactSecretLike(text);
  // mutation-equivalent: at a length of exactly `cap` the head is the whole text, so either branch
  // returns the same text; this one skips the second redaction
  if (text.length <= cap) return whole;
  const head = redactSecretLike(text.slice(0, cap));
  let same = 0;
  // mutation-equivalent: past the end of both texts `undefined === undefined` takes one more step,
  // which returns the whole text, and then the whole text is the head
  while (same < head.length && head[same] === whole[same]) same++;
  if (same === head.length) return head;
  return whole.slice(0, whole.startsWith(REDACTED, same) ? same + REDACTED.length : same);
}

/** True when `text` holds a credential shape: redacting it would change it. */
export function containsSecretLike(text: string): boolean {
  return redactSecretLike(text) !== text;
}
