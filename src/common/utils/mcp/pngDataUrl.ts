import {
  MCP_ICON_LIMITS,
  MCP_ICON_PNG_PREFIX,
  MCP_ICON_PNG_SIGNATURE,
} from "@/common/constants/mcpIcon";

/** Strict RFC 4648 padding, including zero unused bits; callers bound length before this scan. */
export function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  if (value.endsWith("==")) return /[AQgw]==$/.test(value);
  if (value.endsWith("=")) return /[AEIMQUYcgkosw048]=$/.test(value);
  return true;
}

/**
 * Renderer boundary, not an image decoder: only the host's bounded PNG format
 * is eligible for <img>. Recheck even cached/history/IPC data; MIME labels alone
 * do not establish the payload's type. Native decoding happens in the worker.
 */
export function isPngDataUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MCP_ICON_LIMITS.pngDataUrlMaxChars ||
    !value.startsWith(MCP_ICON_PNG_PREFIX)
  )
    return false;
  const encoded = value.slice(MCP_ICON_PNG_PREFIX.length);
  if (!isStrictBase64(encoded)) return false;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const bytes = (encoded.length / 4) * 3 - padding;
  if (bytes < MCP_ICON_PNG_SIGNATURE.length || bytes > MCP_ICON_LIMITS.pngMaxBytes) return false;
  const prefix = atob(encoded.slice(0, 12));
  return MCP_ICON_PNG_SIGNATURE.every((byte, index) => prefix.charCodeAt(index) === byte);
}
