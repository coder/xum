import React from "react";
import ReactDOM from "react-dom/client";
import { installBrowserLogCapture } from "@/browser/utils/browserLog";
import { installWindowOpenLocalhostProxyNormalization } from "@/browser/utils/windowOpenLocalhostProxy";
import { installInactiveAnimationPause } from "@/browser/utils/inactiveAnimations";
import { installViewportHeightSync } from "@/browser/utils/viewportHeight";
import { removeDroppedCacheKeys } from "@/browser/utils/legacyLocalStorageCleanup";
import { AppLoader } from "@/browser/components/AppLoader/AppLoader";
import { initTelemetry } from "@/common/telemetry";
import { trackAppStarted } from "@/browser/utils/telemetryLifecycle";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { initTitlebarInsets } from "@/browser/hooks/useDesktopTitlebar";
import { resolveBrowserAssetUrl } from "@/browser/utils/frontendBasePath";
import { removeFirstRunView } from "@/browser/features/SplashScreens/SplashScreenProvider";

// Initialize telemetry on app startup
try {
  installBrowserLogCapture();
} catch {
  // Silent failure — never crash the app for logging capture
}

try {
  installInactiveAnimationPause();
} catch {
  // Animation throttling is an optimization and must never block renderer startup.
}

try {
  removeDroppedCacheKeys();
} catch {
  // Reclaiming localStorage quota is best-effort and must never block renderer startup.
}

installWindowOpenLocalhostProxyNormalization();
installViewportHeightSync();

initTelemetry();
// vimEnabled lives in config.json, so the startup event waits for the first config snapshot.
const stopWaitingForAppConfig = getAppConfigStore().subscribe(() => {
  stopWaitingForAppConfig();
  trackAppStarted();
});

// Initialize titlebar CSS custom properties (platform-specific insets)
initTitlebarInsets();

// Global error handlers for renderer process
// These catch errors that escape the ErrorBoundary
window.addEventListener("error", (event) => {
  console.error("Uncaught error in renderer:", event.error);
  console.error("Error details:", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error,
    stack: event.error?.stack,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection in renderer:", event.reason);
  console.error("Promise:", event.promise);
  if (event.reason instanceof Error) {
    console.error("Stack:", event.reason.stack);
  }
});

/**
 * T3 #5971, C step 2: an uncaught render error unmounts the whole root, and the static first-run
 * view (outside #root) would stay on screen. This boundary removes it, then renders what such an
 * error leaves today (an empty root) and reports the error as an uncaught one.
 */
export class FirstRunViewErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    removeFirstRunView();
    window.reportError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FirstRunViewErrorBoundary>
      <AppLoader />
    </FirstRunViewErrorBoundary>
  </React.StrictMode>
);

// Register service worker for PWA support
if ("serviceWorker" in navigator) {
  const isHttpProtocol =
    window.location.protocol === "http:" || window.location.protocol === "https:";
  if (isHttpProtocol) {
    const registerServiceWorker = () => {
      navigator.serviceWorker
        .register(resolveBrowserAssetUrl("service-worker.js"))
        .then((registration) => {
          console.log("Service Worker registered:", registration);
        })
        .catch((error) => {
          console.log("Service Worker registration failed:", error);
        });
    };
    // C step 2 loads this module after the static first-run view paints, which can be after
    // `load`: then the event never fires again.
    if (document.readyState === "complete") registerServiceWorker();
    else window.addEventListener("load", registerServiceWorker);
  }
}
