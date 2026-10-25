/**
 * Serve the app page with `Document-Policy: include-js-call-stacks-in-crash-reports` so
 * the main process can read the renderer's JS stack when the window hangs (see
 * ./hangStacks.ts). Only the main app document gets the header; every other response
 * passes through unchanged.
 *
 * Type-only Electron imports keep this module loadable under bun tests.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "electron";
import { hasSameOrigin } from "../utils/hasSameOrigin";
import { withDocumentPolicyHeader } from "./hangStacks";

/** Where the main window loads the app from: the Vite dev server or the built index.html. */
export type AppPage = { kind: "devServer"; url: string } | { kind: "file"; path: string };

const installedSessions = new WeakSet<Session>();

function normalizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isFileUrlForPath(url: string, normalizedPath: string): boolean {
  try {
    return normalizeFilePath(fileURLToPath(url)) === normalizedPath;
  } catch {
    // Not a local file URL (other scheme, or file://remote-host/...): not the app page.
    return false;
  }
}

function createAppPageMatcher(appPage: AppPage): (url: string) => boolean {
  if (appPage.kind === "devServer") {
    return (url) => hasSameOrigin(url, appPage.url);
  }
  const appPagePath = normalizeFilePath(appPage.path);
  return (url) => isFileUrlForPath(url, appPagePath);
}

/**
 * Add the header to the app document's response, for both dev-server (http) and
 * packaged/dist (file://) loads. webRequest.onHeadersReceived also fires for file://
 * navigations, so no custom file protocol handler is needed: subresources keep Chromium's
 * native file handling (and its native errors, e.g. ERR_FILE_NOT_FOUND).
 *
 * The `mainFrame` type filter runs natively, so subresource loads never reach this JS
 * callback (it runs on the main process thread, which also hosts the backend).
 *
 * Electron keeps one onHeadersReceived listener per session and registering again
 * replaces it; nothing else in the desktop app registers one on the main window's session.
 * The listener stays registered for the session's lifetime so reloads keep the header.
 */
export function installAppDocumentPolicy(session: Session, appPage: AppPage): void {
  if (installedSessions.has(session)) {
    // createWindow can run more than once (macOS activate) on the same session.
    return;
  }
  const isAppPage = createAppPageMatcher(appPage);
  session.webRequest.onHeadersReceived(
    // `file:///*` is the pattern verified against Electron 40 file:// navigations. The dev
    // server keeps `<all_urls>` and filters by origin in the listener: patterns with ports
    // are easy to get subtly wrong, and remote-server windows may share this session.
    { urls: appPage.kind === "file" ? ["file:///*"] : ["<all_urls>"], types: ["mainFrame"] },
    (details, callback) => {
      if (!isAppPage(details.url)) {
        callback({});
        return;
      }
      callback({ responseHeaders: withDocumentPolicyHeader(details.responseHeaders) });
    }
  );
  installedSessions.add(session);
}
