import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { createClient } from "@/common/orpc/client";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import { RPCLink as MessagePortLink } from "@orpc/client/message-port";
import {
  getStoredAuthToken,
  setStoredAuthToken,
  clearStoredAuthToken,
} from "@/browser/components/AuthTokenModal/AuthTokenModal";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import { getErrorMessage } from "@/common/utils/errors";

type APIClient = ReturnType<typeof createClient>;

export type { APIClient };

// Discriminated union for type-safe state handling
export type APIState =
  | { status: "connecting"; api: null; error: null }
  | { status: "connected"; api: APIClient; error: null }
  | { status: "degraded"; api: APIClient; error: null } // Connected but pings failing
  | { status: "reconnecting"; api: null; error: null; attempt: number }
  | { status: "auth_required"; api: null; error: string | null }
  | { status: "error"; api: null; error: string };

interface APIStateMethods {
  authenticate: (token: string) => void;
  retry: () => void;
}

// Union distributes over intersection, preserving discriminated union behavior
export type UseAPIResult = APIState & APIStateMethods;

// Internal state for the provider (includes cleanup)
type ConnectionState =
  | { status: "connecting" }
  | { status: "connected"; client: APIClient; cleanup: () => void }
  | { status: "degraded"; client: APIClient; cleanup: () => void } // Pings failing
  | { status: "reconnecting"; attempt: number }
  | { status: "auth_required"; error?: string }
  | { status: "error"; error: string };

// Reconnection constants
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 10000;

// Startup auth probe: if the initial WS handshake fails with an abnormal closure (1006),
// browsers often hide the underlying HTTP status (401/403). We fetch /api/spec.json to
// infer whether auth is required, but the probe must never block reconnect progress.
const AUTH_PROBE_TIMEOUT_MS = 2000;

// Liveness check constants
const LIVENESS_INTERVAL_MS = 5000; // Check every 5 seconds
const LIVENESS_TIMEOUT_MS = 3000; // Ping must respond within 3 seconds
const CONSECUTIVE_FAILURES_FOR_DEGRADED = 2; // Mark degraded after N failures
const CONSECUTIVE_FAILURES_FOR_RECONNECT = 3; // Force reconnect after N failures (WS may be half-open)

// Exported so hooks that need to tolerate being mounted outside an
// APIProvider (e.g., `useGoalDefaults`, `useGoalBoard`) can read the
// context directly and short-circuit gracefully when it's null. The
// canonical `useAPI()` below still throws — keep using it whenever
// API access is required, not optional.
export const APIContext = createContext<UseAPIResult | null>(null);

interface APIProviderProps {
  children: React.ReactNode;
  /** Optional pre-created client. If provided, skips internal connection setup. */
  client?: APIClient;
  /** WebSocket factory for testing. Defaults to native WebSocket constructor. */
  createWebSocket?: (url: string) => WebSocket;
}

const noopConnectionControl = (_token?: string) => undefined;

function closeWebSocketSafely(ws: WebSocket) {
  try {
    // readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
    if (ws.readyState === 2 || ws.readyState === 3) return;
    ws.close();
  } catch {
    // Some browsers throw if close() is called while already closing/closed.
    // Since our cleanup can be invoked from multiple code paths, treat close as idempotent.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tryParseJSONFramePayload(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string" && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
    return null;
  }

  const rawPayload =
    typeof data === "string"
      ? data
      : new TextDecoder().decode(
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        );

  try {
    const parsed: unknown = JSON.parse(rawPayload);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isLikelyOrpcPongResponseFrame(data: unknown): boolean {
  const payload = tryParseJSONFramePayload(data);
  if (!payload) {
    return false;
  }

  // Defensive guard: ORPC frames should always carry a numeric request id.
  if (typeof payload.i !== "number") {
    return false;
  }

  // Event iterator and abort frames are never ping responses.
  if (payload.t === 3 || payload.t === 4) {
    return false;
  }

  if (!isRecord(payload.p)) {
    return false;
  }

  // ORPC encodes normal response bodies at payload.p.b.
  return payload.p.b === "pong";
}

function createElectronClient(): { client: APIClient; cleanup: () => void } {
  const { port1: clientPort, port2: serverPort } = new MessageChannel();
  window.postMessage("start-orpc-client", "*", [serverPort]);

  const link = new MessagePortLink({ port: clientPort });
  clientPort.start();

  return {
    client: createClient(link),
    cleanup: () => clientPort.close(),
  };
}

function createBrowserClient(
  authToken: string | null,
  createWebSocket: (url: string) => WebSocket
): {
  client: APIClient;
  cleanup: () => void;
  ws: WebSocket;
} {
  const apiBaseUrl = getBrowserBackendBaseUrl();

  const wsUrl = new URL(`${apiBaseUrl}/orpc/ws`);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  if (authToken) {
    wsUrl.searchParams.set("token", authToken);
  }

  const ws = createWebSocket(wsUrl.toString());
  // oRPC >=1.14 replaced the `websocket` option with a `connect` factory.
  const link = new WebSocketLink({ connect: () => ws });

  return {
    client: createClient(link),
    cleanup: () => closeWebSocketSafely(ws),
    ws,
  };
}

function ManagedAPIProvider(props: Omit<APIProviderProps, "client">) {
  const [state, setState] = useState<ConnectionState>({ status: "connecting" });
  const [authToken, setAuthToken] = useState<string | null>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get("token")?.trim();
    if (urlToken) {
      setStoredAuthToken(urlToken);
      // Strip token from URL so it doesn't leak into bookmarks, browser
      // history, PWA launch URLs, or Referer headers.
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("token");
      window.history.replaceState({}, "", cleanUrl.pathname + cleanUrl.search);
      return urlToken;
    }

    return getStoredAuthToken();
  });

  const cleanupRef = useRef<(() => void) | null>(null);
  const hasConnectedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReconnectRef = useRef<(() => void) | null>(null);
  const consecutivePingFailuresRef = useRef(0);
  const connectionIdRef = useRef(0);
  const forceReconnectInProgressRef = useRef(false);
  const livenessPingsInFlightCountRef = useRef(0);
  const lastInboundBrowserFrameAtRef = useRef(0);

  // When we decide the user needs to provide a token, stop the reconnect loop.
  //
  // Otherwise, the WebSocket close event (triggered by cleanup()) can schedule a reconnect
  // which immediately flips the UI back to "reconnecting", causing the AuthTokenModal
  // to flicker.
  const authRequiredRef = useRef(false);

  const authProbeAttemptedRef = useRef(false);
  const wsFactory = useMemo(
    () => props.createWebSocket ?? ((url: string) => new WebSocket(url)),
    [props.createWebSocket]
  );

  const connect = useCallback(
    (token: string | null) => {
      const connectionId = ++connectionIdRef.current;
      // Reset per-connection inbound traffic tracking so stale timestamps from a prior
      // socket cannot suppress liveness pings on the next connection.
      lastInboundBrowserFrameAtRef.current = 0;
      livenessPingsInFlightCountRef.current = 0;

      authRequiredRef.current = false;

      // This connect() call supersedes any prior pending reconnect or active connection.
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      cleanupRef.current?.();
      cleanupRef.current = null;

      // Skip Electron detection if custom WebSocket factory provided (for testing)
      if (!props.createWebSocket && window.api) {
        const { client, cleanup } = createElectronClient();
        window.__ORPC_CLIENT__ = client;
        cleanupRef.current = cleanup;
        setState({ status: "connected", client, cleanup });
        return;
      }

      setState({ status: "connecting" });
      const { client, cleanup, ws } = createBrowserClient(token, wsFactory);
      ws.addEventListener("message", (event) => {
        // User rationale: during large catch-up streams, ORPC ping responses can be delayed
        // behind data frames. Treat inbound non-probe traffic as proof of liveness to avoid
        // unnecessary reconnect loops for healthy-but-busy connections.
        if (connectionId !== connectionIdRef.current) {
          return;
        }

        // Keep counting stream frames while liveness probes are in flight; otherwise a slow
        // probe could incorrectly hide active traffic and trigger false reconnects.
        //
        // Only ignore frames that look like ORPC "pong" responses from those probes.
        const isLikelyProbeReply =
          livenessPingsInFlightCountRef.current > 0 && isLikelyOrpcPongResponseFrame(event.data);

        if (isLikelyProbeReply) {
          return;
        }

        lastInboundBrowserFrameAtRef.current = Date.now();
      });

      ws.addEventListener("open", () => {
        // Ignore stale connections (can happen if we force reconnect while the old socket is mid-flight).
        if (connectionId !== connectionIdRef.current) {
          cleanup();
          return;
        }

        client.general
          .ping("auth-check")
          .then(() => {
            // Ignore stale connections (e.g., auth-check returned after a new connect()).
            if (connectionId !== connectionIdRef.current) {
              cleanup();
              return;
            }

            authRequiredRef.current = false;
            hasConnectedRef.current = true;
            reconnectAttemptRef.current = 0;
            consecutivePingFailuresRef.current = 0;
            forceReconnectInProgressRef.current = false;
            window.__ORPC_CLIENT__ = client;
            cleanupRef.current = cleanup;
            setState({ status: "connected", client, cleanup });
          })
          .catch((err: unknown) => {
            if (connectionId !== connectionIdRef.current) {
              cleanup();
              return;
            }

            forceReconnectInProgressRef.current = false;
            const errMsg = getErrorMessage(err);
            const errMsgLower = errMsg.toLowerCase();
            const isAuthError =
              errMsgLower.includes("unauthorized") ||
              errMsgLower.includes("401") ||
              errMsgLower.includes("auth token") ||
              errMsgLower.includes("authentication");

            if (isAuthError) {
              authRequiredRef.current = true;
              clearStoredAuthToken();
              hasConnectedRef.current = false; // Reset - need fresh auth
              setState({ status: "auth_required", error: token ? "Invalid token" : undefined });
              cleanup();
              return;
            }

            cleanup();
            setState({ status: "error", error: errMsg });
          });
      });

      // Note: Browser fires 'error' before 'close', so we handle reconnection
      // only in 'close' to avoid double-scheduling. The 'error' event just
      // signals that something went wrong; 'close' provides the final state.
      ws.addEventListener("error", () => {
        // Error occurred - close event will follow and handle reconnection
        // We don't call cleanup() here since close handler will do it
      });

      ws.addEventListener("close", (event) => {
        cleanup();

        // Ignore stale connections (can happen if we force reconnect while the old socket is mid-flight).
        if (connectionId !== connectionIdRef.current) {
          return;
        }

        forceReconnectInProgressRef.current = false;

        // If we've already decided auth is required (e.g. via ping error), don't immediately
        // overwrite the modal with a reconnect attempt.
        // Auth-specific close codes
        if (event.code === 1008 || event.code === 4401) {
          authRequiredRef.current = true;
          clearStoredAuthToken();
          hasConnectedRef.current = false; // Reset - need fresh auth
          setState({ status: "auth_required", error: "Authentication required" });
          return;
        }

        if (authRequiredRef.current) {
          return;
        }

        // If this is the initial connection attempt and the WS handshake failed, browsers often
        // collapse HTTP auth errors (401/403) into an abnormal closure (1006) with no status.
        //
        // If the backend is reachable over HTTP, we can use the OpenAPI spec to disambiguate:
        // the server includes a `security` stanza when a bearer token is required.
        if (
          !hasConnectedRef.current &&
          !token &&
          event.code === 1006 &&
          !authProbeAttemptedRef.current
        ) {
          authProbeAttemptedRef.current = true;

          const apiBaseUrl = getBrowserBackendBaseUrl();
          const specUrl = new URL(`${apiBaseUrl}/api/spec.json`);

          type AuthProbeResult = "requires_auth" | "no_auth" | "unknown";

          const controller = new AbortController();
          let timeoutId: ReturnType<typeof setTimeout> | null = null;

          // `fetch` has no builtin timeout, and some environments don't reliably reject on abort.
          // Use a race so the probe cannot hang the connection loop.
          const timeoutPromise = new Promise<AuthProbeResult>((resolve) => {
            timeoutId = setTimeout(() => {
              controller.abort();
              resolve("unknown");
            }, AUTH_PROBE_TIMEOUT_MS);
          });

          const fetchPromise: Promise<AuthProbeResult> = fetch(specUrl, {
            signal: controller.signal,
          })
            .then(async (res): Promise<AuthProbeResult> => {
              if (!res.ok) return "unknown";

              try {
                const spec = (await res.json()) as { security?: unknown };
                const requiresAuth = Array.isArray(spec.security) && spec.security.length > 0;
                return requiresAuth ? "requires_auth" : "no_auth";
              } catch {
                return "unknown";
              }
            })
            .catch((): AuthProbeResult => "unknown");

          void Promise.race([fetchPromise, timeoutPromise])
            .then((result) => {
              if (connectionId !== connectionIdRef.current) {
                return;
              }

              if (result === "requires_auth") {
                authRequiredRef.current = true;
                clearStoredAuthToken();
                hasConnectedRef.current = false; // Reset - need fresh auth
                setState({ status: "auth_required", error: "Authentication required" });
                return;
              }

              if (result === "unknown") {
                // Probe was inconclusive (timeout, network error, non-OK, invalid JSON). Allow re-probe
                // on a later initial-handshake failure.
                authProbeAttemptedRef.current = false;
              }

              scheduleReconnectRef.current?.();
            })
            .finally(() => {
              if (timeoutId) {
                clearTimeout(timeoutId);
              }
            });

          return;
        }
        // If we were previously connected, try to reconnect
        if (hasConnectedRef.current) {
          scheduleReconnectRef.current?.();
          return;
        }

        // First connection failed.
        // This can happen in dev-server mode if the UI boots before the backend is ready.
        // Prefer retry/backoff over forcing the auth modal (auth will be detected via ping/close codes).
        scheduleReconnectRef.current?.();
      });
    },
    [props.createWebSocket, wsFactory]
  );

  // Schedule reconnection with exponential backoff
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    const attempt = reconnectAttemptRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      const error = hasConnectedRef.current
        ? "Connection lost. Please refresh the page."
        : "Failed to connect to the Xum backend after multiple attempts.";
      setState({ status: "error", error });
      return;
    }

    const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
    reconnectAttemptRef.current = attempt + 1;
    setState({ status: "reconnecting", attempt: attempt + 1 });

    reconnectTimeoutRef.current = setTimeout(() => {
      connect(authToken);
    }, delay);
  }, [authToken, connect]);

  // Keep ref in sync with latest scheduleReconnect
  scheduleReconnectRef.current = scheduleReconnect;

  useEffect(() => {
    connect(authToken);
    return () => {
      cleanupRef.current?.();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Liveness check: periodic ping to detect degraded connections.
  // Only runs for managed browser WebSocket connections.
  useEffect(() => {
    // Only check liveness for connected/degraded browser connections.
    if (state.status !== "connected" && state.status !== "degraded") return;
    // Skip for Electron (MessagePort) clients.
    if (!props.createWebSocket && window.api) return;

    const client = state.client;
    const cleanup = state.cleanup;
    let effectDisposed = false;

    const markConnectionHealthy = () => {
      if (effectDisposed) {
        return;
      }

      consecutivePingFailuresRef.current = 0;
      forceReconnectInProgressRef.current = false;
      if (state.status === "degraded") {
        setState({ status: "connected", client, cleanup });
      }
    };

    const checkLiveness = async () => {
      if (effectDisposed) {
        return;
      }

      const timeSinceLastInboundFrameMs = Date.now() - lastInboundBrowserFrameAtRef.current;
      const hasRecentInboundTraffic =
        lastInboundBrowserFrameAtRef.current > 0 &&
        timeSinceLastInboundFrameMs >= 0 &&
        timeSinceLastInboundFrameMs <= LIVENESS_TIMEOUT_MS;

      if (hasRecentInboundTraffic) {
        // User rationale: if we're still receiving stream frames, the connection is alive
        // even when application-level ping responses are delayed behind backlog.
        markConnectionHealthy();
        return;
      }

      try {
        // Race ping against timeout
        const livenessPingConnectionId = connectionIdRef.current;
        const pingPromise = client.general.ping("liveness");
        livenessPingsInFlightCountRef.current += 1;
        const finalizeLivenessProbe = () => {
          // Ignore stale probes from an older socket after reconnect.
          if (livenessPingConnectionId !== connectionIdRef.current) {
            return;
          }

          // Multiple probes can overlap when a ping exceeds LIVENESS_INTERVAL_MS.
          // Track count instead of boolean so one delayed probe cannot clear
          // in-flight state for a newer still-pending probe.
          livenessPingsInFlightCountRef.current = Math.max(
            0,
            livenessPingsInFlightCountRef.current - 1
          );
        };

        // Handle both resolve/reject explicitly to avoid an unhandled rejection chain.
        void pingPromise.then(finalizeLivenessProbe, finalizeLivenessProbe);

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("Ping timeout")), LIVENESS_TIMEOUT_MS);
          });

          await Promise.race([pingPromise, timeoutPromise]);
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        }

        if (effectDisposed) {
          return;
        }

        // Ping succeeded - reset failure count and restore connected state if degraded
        markConnectionHealthy();
      } catch {
        if (effectDisposed) {
          return;
        }

        // Ping failed
        consecutivePingFailuresRef.current++;

        if (
          consecutivePingFailuresRef.current >= CONSECUTIVE_FAILURES_FOR_RECONNECT &&
          !forceReconnectInProgressRef.current
        ) {
          forceReconnectInProgressRef.current = true;
          console.warn(
            `[APIProvider] Liveness ping failed ${consecutivePingFailuresRef.current} times; reconnecting...`
          );
          cleanup();
          if (effectDisposed) {
            return;
          }
          connect(authToken);
          return;
        }

        if (
          consecutivePingFailuresRef.current >= CONSECUTIVE_FAILURES_FOR_DEGRADED &&
          state.status === "connected"
        ) {
          setState({ status: "degraded", client, cleanup });
        }
      }
    };

    const intervalId = setInterval(() => {
      void checkLiveness();
    }, LIVENESS_INTERVAL_MS);
    return () => {
      effectDisposed = true;
      clearInterval(intervalId);
    };
  }, [state, props.createWebSocket, connect, authToken]);

  const authenticate = useCallback(
    (token: string) => {
      authProbeAttemptedRef.current = false;
      setStoredAuthToken(token);
      setAuthToken(token);
      connect(token);
    },
    [connect]
  );

  const retry = useCallback(() => {
    authProbeAttemptedRef.current = false;
    connect(authToken);
  }, [connect, authToken]);

  // Convert internal state to the discriminated union API
  const value = useMemo((): UseAPIResult => {
    const base = { authenticate, retry };
    switch (state.status) {
      case "connecting":
        return { status: "connecting", api: null, error: null, ...base };
      case "connected":
        return { status: "connected", api: state.client, error: null, ...base };
      case "degraded":
        return { status: "degraded", api: state.client, error: null, ...base };
      case "reconnecting":
        return { status: "reconnecting", api: null, error: null, attempt: state.attempt, ...base };
      case "auth_required":
        return { status: "auth_required", api: null, error: state.error ?? null, ...base };
      case "error":
        return { status: "error", api: null, error: state.error, ...base };
    }
  }, [state, authenticate, retry]);

  // Always render children - consumers handle their own loading/error states
  return <APIContext.Provider value={value}>{props.children}</APIContext.Provider>;
}

function InjectedClientAPIProvider(
  props: Pick<APIProviderProps, "children"> & { client: APIClient }
) {
  // User rationale: injected clients are already fully constructed, so wrapping them in the
  // browser liveness/reconnect state machine risks leaking async state updates into tests.
  window.__ORPC_CLIENT__ = props.client;

  return (
    <APIContext.Provider
      value={{
        status: "connected",
        api: props.client,
        error: null,
        authenticate: noopConnectionControl,
        retry: noopConnectionControl,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
}

export const APIProvider = (props: APIProviderProps) => {
  if (props.client) {
    return (
      <InjectedClientAPIProvider client={props.client}>{props.children}</InjectedClientAPIProvider>
    );
  }

  return (
    <ManagedAPIProvider createWebSocket={props.createWebSocket}>
      {props.children}
    </ManagedAPIProvider>
  );
};

export const useAPI = (): UseAPIResult => {
  const context = useContext(APIContext);
  if (!context) {
    throw new Error("useAPI must be used within an APIProvider");
  }
  return context;
};

/**
 * Like {@link useAPI} but returns null instead of throwing when there is no APIProvider.
 * Use this in best-effort hooks that may render outside an APIProvider (e.g. isolated
 * test harnesses) and should degrade gracefully rather than crash.
 */
export const useOptionalAPI = (): UseAPIResult | null => useContext(APIContext);
