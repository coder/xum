import { useEffect, useRef, useState, type RefObject } from "react";
import type RFB from "@novnc/novnc/lib/rfb";
import { useAPI } from "@/browser/contexts/API";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import { DESKTOP_DEFAULTS, DESKTOP_VIEWER_DISCONNECT_TIMEOUT_MS } from "@/common/constants/desktop";
import type { DesktopCapability } from "@/common/types/desktop";
import { getErrorMessage } from "@/common/utils/errors";
import { trackDesktopInput } from "./desktopInput";

export type DesktopConnectionState =
  | "idle"
  | "checking"
  | "unavailable"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface UseDesktopConnectionResult {
  state: DesktopConnectionState;
  reason: string | null;
  rfbRef: RefObject<RFB>;
  containerRef: RefObject<HTMLDivElement>;
  connect: () => void;
  disconnect: () => void;
  disconnectAndWait: () => Promise<void>;
  controlling: boolean;
  setControlling: (value: boolean) => void;
  scaleToFit: boolean;
  setScaleToFit: (value: boolean) => void;
  width: number;
  height: number;
  sharedDesktop: Extract<DesktopCapability, { available: true }>["sharedDesktop"] | null;
}

type DesktopUnavailableReason = Extract<DesktopCapability, { available: false }>["reason"];

const UNAVAILABLE_REASONS: Record<DesktopUnavailableReason, string> = {
  disabled: "Desktop sessions are disabled",
  unsupported_platform: "Desktop sessions are not supported on this platform",
  unsupported_runtime: "Desktop sessions are not supported in this runtime",
  startup_failed: "Desktop session failed to start",
  binary_not_found: "Desktop binary not found",
};

function assertDesktop(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Derive the base URL for the Desktop WebSocket bridge.
 *
 * In browser mode, getBrowserBackendBaseUrl() works correctly (respects
 * VITE_BACKEND_URL, app-proxy paths, and window.location.origin).
 *
 * In packaged Electron, window.location.origin may be "file://" or
 * "null", so we fall back to a localhost URL. The backend port in
 * Electron is available through window.api (the preload bridge).
 */
function getDesktopBridgeBaseUrl(): string {
  const backendUrl = getBrowserBackendBaseUrl();
  // getBrowserBackendBaseUrl checks VITE_BACKEND_URL first, which is
  // set in dev mode. In production browser mode it uses window.location.origin.
  // Both are valid — only packaged Electron (file:// origin) needs a fallback.
  if (!backendUrl || backendUrl === "null" || backendUrl.startsWith("file:")) {
    return "http://localhost";
  }

  try {
    const origin = new URL(backendUrl).origin;
    if (origin && origin !== "null") {
      return backendUrl;
    }
  } catch {
    // Packaged Electron can surface opaque or otherwise non-URL backend base strings.
    // Fall back to localhost so the desktop bridge still connects through the preload backend.
  }

  // Electron fallback: use localhost. In Electron, the backend URL is
  // provided via the preload bridge at window.api.
  return "http://localhost";
}

function buildDesktopBridgeUrl(
  bridgePath: string,
  token: string,
  localBridgeBaseUrl?: string
): string {
  assertDesktop(bridgePath.length > 0, "Desktop bootstrap response is missing a valid bridgePath.");
  assertDesktop(token.length > 0, "Desktop bootstrap response is missing a valid token.");

  const isDesktop = typeof window.api !== "undefined";
  const baseUrl =
    isDesktop && typeof localBridgeBaseUrl === "string" && localBridgeBaseUrl.length > 0
      ? localBridgeBaseUrl
      : getDesktopBridgeBaseUrl();
  // Concatenate base + bridgePath to preserve any app-proxy prefix
  // (e.g. /@user/ws/apps/mux + /desktop/ws → /@user/ws/apps/mux/desktop/ws)
  const fullUrl = baseUrl.endsWith("/")
    ? baseUrl + bridgePath.replace(/^\//, "")
    : baseUrl + bridgePath;
  const wsUrl = new URL(fullUrl);
  // Derive ws/wss from page protocol — in HTTPS deployments, a reverse proxy handles TLS
  // termination for the bridge.
  wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("token", token);
  return wsUrl.toString();
}

export function useDesktopConnection(workspaceId: string): UseDesktopConnectionResult {
  const { api } = useAPI();
  const [state, setState] = useState<DesktopConnectionState>("idle");
  const [reason, setReason] = useState<string | null>(null);
  const [width, setWidth] = useState<number>(DESKTOP_DEFAULTS.WIDTH);
  const [height, setHeight] = useState<number>(DESKTOP_DEFAULTS.HEIGHT);
  const [sharedDesktop, setSharedDesktop] =
    useState<UseDesktopConnectionResult["sharedDesktop"]>(null);

  const [controlling, setControllingState] = useState(false);
  const [scaleToFit, setScaleToFitState] = useState(true);
  const scaleToFitRef = useRef(true);
  const inputRef = useRef<ReturnType<typeof trackDesktopInput> | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const setControlling = (value: boolean) => {
    const rfb = rfbRef.current;
    if (!value) inputRef.current?.release();
    if (rfb) rfb.viewOnly = !value;
    setControllingState(value && rfb !== null);
  };
  const setScaleToFit = (value: boolean) => {
    scaleToFitRef.current = value;
    if (rfbRef.current) rfbRef.current.scaleViewport = value;
    setScaleToFitState(value);
  };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasEverConnectedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const generationRef = useRef(0);
  const isDisposedRef = useRef(false);

  const connectImplRef = useRef<() => void>(() => undefined);
  const disconnectImplRef = useRef<() => void>(() => undefined);
  const connectHandleRef = useRef<() => void>(() => connectImplRef.current());
  const disconnectHandleRef = useRef<() => void>(() => disconnectImplRef.current());
  const scheduleReconnectRef = useRef<() => void>(() => undefined);

  const disconnectAndWait = (): Promise<void> => {
    const rfb = rfbRef.current;
    if (!rfb) {
      disconnectHandleRef.current();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const onDisconnect = () => {
        clearTimeout(timeout);
        rfb.removeEventListener("disconnect", onDisconnect);
        resolve();
      };
      const timeout = setTimeout(onDisconnect, DESKTOP_VIEWER_DISCONNECT_TIMEOUT_MS);
      rfb.addEventListener("disconnect", onDisconnect);
      // Release synchronously, but let the WebSocket drain before the popout disappears.
      disconnectHandleRef.current();
    });
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const disconnectCurrentRfb = () => {
    setSharedDesktop(null);
    const currentRfb = rfbRef.current;
    setControlling(false);
    inputRef.current?.dispose();
    inputRef.current = null;
    rfbRef.current = null;
    if (!currentRfb) {
      return;
    }

    try {
      currentRfb.disconnect();
    } catch {
      // noVNC disconnect can race with its own close handling; treat teardown as idempotent.
    }
  };

  scheduleReconnectRef.current = () => {
    if (isDisposedRef.current) {
      return;
    }

    clearReconnectTimer();
    const delay = Math.min(
      DESKTOP_DEFAULTS.RECONNECT_BASE_DELAY_MS * 2 ** attemptRef.current,
      DESKTOP_DEFAULTS.RECONNECT_MAX_DELAY_MS
    );
    attemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (isDisposedRef.current) {
        return;
      }
      connectHandleRef.current();
    }, delay);
  };

  disconnectImplRef.current = () => {
    isDisposedRef.current = true;
    generationRef.current += 1;
    clearReconnectTimer();
    disconnectCurrentRfb();
    setState("idle");
    setReason(null);
  };

  connectImplRef.current = () => {
    void (async () => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      isDisposedRef.current = false;
      clearReconnectTimer();
      disconnectCurrentRfb();
      setReason(null);

      if (!api) {
        // User rationale: the Desktop tab can mount while the API client is still reconnecting,
        // so treat a missing API client as transient and retry instead of wedging the hook in error.
        setState("connecting");
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (isDisposedRef.current || generationRef.current !== generation) {
            return;
          }
          connectHandleRef.current();
        }, DESKTOP_DEFAULTS.RECONNECT_BASE_DELAY_MS);
        return;
      }

      setState("checking");

      try {
        // Shared-target metadata is display-only: the caller's bootstrap/token preserves the
        // backend's authorization and binding checks; never bootstrap the owner directly.
        const result = await api.desktop.getBootstrap({ workspaceId });
        if (generationRef.current !== generation || isDisposedRef.current) {
          return;
        }

        if (!result.capability.available) {
          if (hasEverConnectedRef.current) {
            // A prior successful session means bootstrap unavailability is part of the reconnect
            // loop, so keep retrying instead of wedging the panel in a permanent unavailable state.
            setState("disconnected");
            setReason(null);
            scheduleReconnectRef.current();
            return;
          }
          setState("unavailable");
          setReason(UNAVAILABLE_REASONS[result.capability.reason]);
          return;
        }

        const bridgePath = result.bridgePath;
        assertDesktop(
          typeof bridgePath === "string" && bridgePath.length > 0,
          "Desktop bootstrap response is missing a valid bridgePath."
        );
        const token = result.token;
        assertDesktop(
          typeof token === "string" && token.length > 0,
          "Desktop bootstrap response is missing a valid token."
        );
        const wsUrl = buildDesktopBridgeUrl(bridgePath, token, result.localBridgeBaseUrl);
        setWidth(result.capability.width);
        setHeight(result.capability.height);

        const container = containerRef.current;
        assertDesktop(container, "Desktop panel container is not mounted.");

        // noVNC's CommonJS entry reaches a transitive dependency with top-level await,
        // so Vite dev mode must load it lazily instead of pre-bundling a static import.
        const { default: RFB } = await import("@novnc/novnc/lib/rfb");
        // Guard against stale connection after async import
        if (isDisposedRef.current || generation !== generationRef.current) {
          return;
        }
        const rfb = new RFB(container, wsUrl);
        rfb.background = "var(--color-background)";
        rfb.viewOnly = true;
        rfb.scaleViewport = scaleToFitRef.current;
        rfb.resizeSession = false;

        const handleConnect = () => {
          if (generationRef.current !== generation || isDisposedRef.current) {
            return;
          }
          const canvas = container.querySelector("canvas");
          assertDesktop(canvas, "Connected desktop is missing its canvas.");
          inputRef.current = trackDesktopInput(canvas, () => !rfb.viewOnly);
          hasEverConnectedRef.current = true;
          attemptRef.current = 0;
          setState("connected");
          setReason(null);
        };

        const handleDisconnect = (event: CustomEvent<{ clean: boolean }>) => {
          if (generationRef.current !== generation || isDisposedRef.current) {
            return;
          }
          disconnectCurrentRfb();
          if (hasEverConnectedRef.current) {
            setState("disconnected");
            setReason(null);
            scheduleReconnectRef.current();
            return;
          }
          const cleanSuffix = event.detail.clean ? " cleanly" : " unexpectedly";
          setState("error");
          setReason(`Desktop session disconnected${cleanSuffix} before it finished connecting.`);
        };

        const handleSecurityFailure = (event: CustomEvent<{ status: number; reason: string }>) => {
          if (generationRef.current !== generation || isDisposedRef.current) {
            return;
          }
          disconnectCurrentRfb();
          setState("error");
          const securityReason = event.detail.reason.trim();
          setReason(
            securityReason.length > 0
              ? `Desktop connection failed security checks: ${securityReason}`
              : "Desktop connection failed security checks."
          );
        };

        rfb.addEventListener("connect", handleConnect);
        rfb.addEventListener("disconnect", handleDisconnect);
        rfb.addEventListener("securityfailure", handleSecurityFailure);
        rfbRef.current = rfb;
        setSharedDesktop(result.capability.sharedDesktop ?? null);
        setState("connecting");
      } catch (error) {
        if (generationRef.current !== generation || isDisposedRef.current) {
          return;
        }
        disconnectCurrentRfb();
        if (hasEverConnectedRef.current) {
          // A prior successful session means this is part of the reconnect loop, so keep the
          // exponential backoff running instead of wedging the panel in a permanent error state.
          setState("disconnected");
          setReason(null);
          scheduleReconnectRef.current();
          return;
        }
        setState("error");
        setReason(getErrorMessage(error));
      }
    })();
  };

  useEffect(() => {
    const disconnect = disconnectHandleRef.current;
    const release = () => setControlling(false);
    const onWindowBlur = (event: FocusEvent) => {
      // Capture runs before noVNC's window blur handler, but also sees toolbar/canvas
      // focus changes. Moving focus into the guest must not revoke human control.
      if (event.target === window) release();
    };
    window.addEventListener("blur", onWindowBlur, true);
    const onVisibilityChange = () => {
      if (document.hidden) release();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", onWindowBlur, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      disconnect();
    };
  }, []);

  return {
    state,
    reason,
    rfbRef,
    containerRef,
    connect: connectHandleRef.current,
    disconnect: disconnectHandleRef.current,
    disconnectAndWait,
    controlling,
    setControlling,
    scaleToFit,
    setScaleToFit,
    width,
    height,
    sharedDesktop,
  };
}
