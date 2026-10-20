/**
 * Per-provider session header (#4231): some gateways (e.g. OpenCode Go) want a
 * stable id per conversation in a header they name. Xum fills the configured
 * header with the workspace id on each chat request (see buildRequestHeaders).
 */

// RFC 7230 section 3.2.6 `token`: the only characters a header field name may hold.
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// The value is the workspace id, so these names would replace credentials or a
// header Xum (or the SDK) already sets on every request. Lowercase: HTTP header
// names are case-insensitive.
const RESERVED_SESSION_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "cookie",
  "host",
  "content-type",
  "content-length",
  "user-agent",
  "anthropic-beta",
  "anthropic-version",
  "x-mux-workspace-id",
]);

/** Why `name` cannot be a session header, or null when it can. */
export function sessionHeaderNameError(name: string): string | null {
  if (!HTTP_TOKEN_PATTERN.test(name)) {
    return "Session header must be a valid HTTP header name (letters, digits and !#$%&'*+-.^_`|~, no spaces).";
  }
  if (RESERVED_SESSION_HEADER_NAMES.has(name.toLowerCase())) {
    return `Session header cannot be "${name}": Xum or the provider already uses it.`;
  }
  return null;
}
