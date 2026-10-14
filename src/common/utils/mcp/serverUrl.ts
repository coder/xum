/**
 * Shared check for user-entered remote (http/sse/auto) MCP server URLs. The Settings
 * form uses it to gate Save and the backend uses it to refuse bad input, so both
 * layers agree. MCP server URLs are used literally (no `${VAR}` templating), so
 * anything the WHATWG parser rejects can never connect.
 */
export function getMcpServerUrlError(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "URL must be an absolute http:// or https:// URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must use http:// or https://";
  }
  return null;
}
