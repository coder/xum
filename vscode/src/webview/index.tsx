import React from "react";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "xum/browser/components/ErrorBoundary/ErrorBoundary";
import { removeDroppedCacheKeys } from "xum/browser/utils/legacyLocalStorageCleanup";
import { App } from "./App";
import { getVscodeBridge } from "./vscodeBridge";

const bridge = getVscodeBridge();

try {
  removeDroppedCacheKeys();
} catch {
  // Reclaiming localStorage quota is best-effort and must never block webview startup.
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  bridge.debugLog("fatal: missing #root element");
  throw new Error("mux webview: missing #root element");
}

createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary workspaceInfo="VS Code webview">
      <App bridge={bridge} />
    </ErrorBoundary>
  </React.StrictMode>
);
