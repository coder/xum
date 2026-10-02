/**
 * Serve the app page with `Document-Policy: include-js-call-stacks-in-crash-reports` so
 * the main process can read the renderer's JS stack when the window hangs (see
 * ./hangStacks.ts). Only the main app page gets the header; every other response passes
 * through unchanged.
 *
 * Type-only Electron imports keep this module loadable under bun tests.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "electron";
import { hasSameOrigin } from "../utils/hasSameOrigin";
import { mergeDocumentPolicyValue, withDocumentPolicyHeader } from "./hangStacks";

const fileHandlerSessions = new WeakSet<Session>();
const devServerSessions = new WeakSet<Session>();

function normalizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isFileUrlForPath(url: string, normalizedPath: string): boolean {
  try {
    return normalizeFilePath(fileURLToPath(url)) === normalizedPath;
  } catch {
    // Not a local file URL (e.g. file://remote-host/...): not the app page.
    return false;
  }
}

/**
 * Packaged and dist (E2E) builds load the app with `loadFile()`, and file:// responses have
 * no headers to rewrite through webRequest. Intercept the file scheme on `session` and add
 * the header only to `htmlPath`. The handler stays registered for the session's lifetime
 * because reloads (the E2E fixture reloads right after launch) must keep the header.
 */
export function installFileDocumentPolicy(session: Session, htmlPath: string): void {
  if (fileHandlerSessions.has(session)) {
    // createWindow can run more than once (macOS activate); protocol.handle throws on a
    // second registration for the same scheme.
    return;
  }
  const appPagePath = normalizeFilePath(htmlPath);

  session.protocol.handle("file", async (request) => {
    // bypassCustomProtocolHandlers forwards to Chromium's built-in file handler instead of
    // re-entering this one.
    const response = await session.fetch(request, { bypassCustomProtocolHandlers: true });
    if (!isFileUrlForPath(request.url, appPagePath)) {
      return response;
    }
    // `new Response` rejects statuses outside 200-599; leave such responses untouched.
    if (response.status < 200 || response.status > 599) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set("Document-Policy", mergeDocumentPolicyValue(headers.get("Document-Policy")));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
  fileHandlerSessions.add(session);
}

/**
 * Development loads the app from the Vite dev server: add the header to its main-frame
 * responses and keep every other response header (CSP included).
 *
 * Electron allows one onHeadersReceived listener per session, and registering again
 * replaces it; nothing else in the desktop app registers one on the main window's session.
 */
export function installDevServerDocumentPolicy(session: Session, devServerUrl: string): void {
  if (devServerSessions.has(session)) {
    return;
  }
  session.webRequest.onHeadersReceived(
    // Filter by origin in the listener: URL match patterns with ports are easy to get
    // subtly wrong, and remote-server windows may share this session.
    { urls: ["<all_urls>"], types: ["mainFrame"] },
    (details, callback) => {
      if (!hasSameOrigin(details.url, devServerUrl)) {
        callback({});
        return;
      }
      callback({ responseHeaders: withDocumentPolicyHeader(details.responseHeaders) });
    }
  );
  devServerSessions.add(session);
}
