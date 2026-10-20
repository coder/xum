/**
 * Per-provider session header (#4231): some gateways (e.g. OpenCode Go) want a
 * stable id per conversation in a header they name. Xum fills the configured
 * header with the workspace id on each chat request (see buildRequestHeaders).
 */

// RFC 7230 section 3.2.6 `token`: the only characters a header field name may hold.
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// The value is the workspace id, so a reserved name would replace credentials,
// a header Xum or the SDK already sets, or a header that fetch owns. Lowercase:
// HTTP header names are case-insensitive.
const RESERVED_SESSION_HEADER_NAMES = new Set([
  // Credentials.
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  // Set by Xum or the SDK on every request.
  "content-type",
  "user-agent",
  "anthropic-beta",
  "anthropic-version",
  "x-mux-workspace-id",
  // The Fetch spec's forbidden request-header names: Node fetch refuses some of
  // them before network I/O and overwrites or drops others.
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  // The body is not encoded, so the server would misread it.
  "content-encoding",
  // A valid token, but the prototype setter swallows it on a plain object.
  "__proto__",
]);

// The Fetch spec also forbids every name with these prefixes.
const RESERVED_SESSION_HEADER_PREFIXES = ["proxy-", "sec-"];

/** Why `name` cannot be a session header, or null when it can. */
export function sessionHeaderNameError(name: string): string | null {
  if (!HTTP_TOKEN_PATTERN.test(name)) {
    return "Session header must be a valid HTTP header name (letters, digits and !#$%&'*+-.^_`|~, no spaces).";
  }
  const lower = name.toLowerCase();
  if (
    RESERVED_SESSION_HEADER_NAMES.has(lower) ||
    RESERVED_SESSION_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
  ) {
    return `Session header cannot be "${name}": it is reserved for credentials or HTTP transport.`;
  }
  return null;
}
