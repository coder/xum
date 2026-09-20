/**
 * URL validators for server-reported MCP display metadata (website links and
 * connection origins). Server input is untrusted: only credential-free
 * `https:` URLs are ever shown or persisted.
 */

/** Any whitespace or control character: the WHATWG parser silently strips these, so the stored string must not contain them. */
const UNSAFE_URL_CHARS = /[\s\p{Cc}]/u;

function parseHttps(value: string): URL | undefined {
  if (!value.startsWith("https://") || UNSAFE_URL_CHARS.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** True for an `https:` URL without userinfo (even an empty `@` marker is rejected). */
export function isHttpsUrlWithoutUserinfo(value: string): boolean {
  const url = parseHttps(value);
  if (!url) {
    return false;
  }
  if (url.username !== "" || url.password !== "") {
    return false;
  }
  const authority = value.slice("https://".length).split(/[/?#]/, 1)[0] ?? "";
  return !authority.includes("@");
}

/**
 * True only for an exactly serialized https origin (`https://host[:port]`,
 * lowercase ASCII host, no default port, no trailing slash) — the form
 * `httpsOriginOf` produces.
 */
export function isHttpsOrigin(value: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(value)) {
    return false;
  }
  return parseHttps(value)?.origin === value;
}

/** Origin (scheme + host + port) of an https URL; undefined for anything else. */
export function httpsOriginOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
