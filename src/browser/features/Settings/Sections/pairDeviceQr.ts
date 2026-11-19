import type { ApiServerStatus } from "@/common/orpc/types";

/**
 * The connection link the Xum iOS app parses (see `ios/Xum/Kit/ConnectionLink.swift` on the
 * native-app branch): `<baseUrl>/?token=<urlencoded token>`, the same "Open in browser" link
 * that `xum server` prints. A path prefix on the base URL (a reverse proxy) is kept.
 */
export function buildConnectionLink(baseUrl: string, token: string): string {
  return `${baseUrl}/?token=${encodeURIComponent(token)}`;
}

/** The link with its token replaced by bullets, for display before the user reveals it. */
export function maskConnectionLink(link: string): string {
  const tokenStart = link.indexOf("token=");
  if (tokenStart < 0) return link;
  return `${link.slice(0, tokenStart + "token=".length)}\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022`;
}

function urlHostname(url: string): string | null {
  try {
    // WHATWG URL keeps the brackets on an IPv6 hostname; drop them for comparison.
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/** Whether a base URL only a process on the same machine can reach (no phone can). */
export function isLoopbackBaseUrl(url: string): boolean {
  const host = urlHostname(url);
  if (host == null) return false;
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.startsWith("127.")
  );
}

/**
 * Server base URLs the pairing QR can encode: the network addresses (LAN/Tailscale) first,
 * then the always-connectable base URL, deduplicated.
 */
export function pairingBaseUrls(
  status: Pick<ApiServerStatus, "baseUrl" | "networkBaseUrls">
): string[] {
  const urls: string[] = [];
  for (const url of [...status.networkBaseUrls, ...(status.baseUrl ? [status.baseUrl] : [])]) {
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * Default QR address: one a phone can reach (a LAN or Tailscale address) over loopback.
 * Falls back to the only address available, or null when the server has none.
 */
export function defaultPairingBaseUrl(urls: string[]): string | null {
  return urls.find((url) => !isLoopbackBaseUrl(url)) ?? urls[0] ?? null;
}
