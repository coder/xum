/**
 * Renderer network egress block for session tape replay mode (XUM_REPLAY_TAPES, perf harness).
 * Replayed transcripts hold recorded content (markdown images, links, ...) whose URLs must never
 * be contacted. Desktop main installs the block on the default session at app ready, before any
 * window loads (the main, desktop.html and terminal windows all use that session), and only then
 * lets the backend serve tapes (`markSessionTapeReplayEgressBlocked`). Imports stay light: this
 * module is on the pre-splash startup path.
 *
 * Type-only Electron imports keep this module loadable under bun tests.
 */
import type { Session } from "electron";
import { log } from "@/node/services/log";
import { isSessionTapeReplayConfigured } from "@/common/utils/sessionTapes/sessionTapeReplay";

/** Local schemes that never leave the machine. */
const ALLOWED_PROTOCOLS = new Set(["file:", "data:", "blob:", "devtools:"]);

/**
 * Whether the renderer may load `url` in replay mode. Everything not local is refused, loopback
 * included (recorded content can point at local services). `devServerOrigins` (dev-server mode
 * only: the app page's, e.g. `http://127.0.0.1:5173`, and the terminal page's) also allows those
 * exact origins over http and ws (HMR).
 */
export function isSessionTapeReplayAllowedUrl(
  url: string,
  devServerOrigins: readonly string[]
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (ALLOWED_PROTOCOLS.has(parsed.protocol)) return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "ws:") return false;
  // `host` includes the port only when it is not the scheme default, and http and ws share
  // default port 80, so comparing `host` matches the exact host and port for both schemes.
  return devServerOrigins.some((origin) => {
    const dev = new URL(origin);
    return dev.protocol === "http:" && parsed.host === dev.host;
  });
}

/** Origin (or scheme) of a refused URL: logs never carry recorded paths or queries. */
function describeOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? parsed.protocol : parsed.origin;
  } catch {
    return "invalid URL";
  }
}

/**
 * Cancel every default-session request that `isSessionTapeReplayAllowedUrl` refuses (the
 * renderer sees net::ERR_BLOCKED_BY_CLIENT).
 */
export function installSessionTapeReplayEgressBlock(
  session: Session,
  devServerOrigins: readonly string[]
): void {
  let blockedCount = 0;
  session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const allowed = isSessionTapeReplayAllowedUrl(details.url, devServerOrigins);
    if (!allowed) {
      blockedCount += 1;
      log.info("Session tape replay blocked a renderer request", {
        origin: describeOrigin(details.url),
        blockedCount,
      });
    }
    callback({ cancel: !allowed });
  });
}

/**
 * External-open guard for replay mode: returns true (and logs) when `url` must not be opened
 * in the user's browser. Callers deny the open.
 */
export function refuseSessionTapeReplayExternalOpen(url: string): boolean {
  if (!isSessionTapeReplayConfigured(process.env)) return false;
  log.info("Session tape replay refused to open an external URL", { origin: describeOrigin(url) });
  return true;
}
