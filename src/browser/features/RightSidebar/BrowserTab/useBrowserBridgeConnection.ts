import { useEffect, useRef, useState } from "react";
import { useLiveAPI } from "@/browser/contexts/API";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import type {
  BrowserViewportMetadata,
  BrowserInputEvent,
  BrowserSession,
  BrowserSessionAttachOptions,
  BrowserStreamState,
} from "./browserBridgeTypes";

function assertBrowser(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function getBrowserBridgeBaseUrl(): string {
  const backendUrl = getBrowserBackendBaseUrl();
  if (!backendUrl || backendUrl === "null" || backendUrl.startsWith("file:")) {
    return "http://localhost";
  }

  try {
    const origin = new URL(backendUrl).origin;
    if (origin && origin !== "null") {
      return backendUrl;
    }
  } catch {
    // Fall back to localhost for packaged Electron-style opaque origins.
  }

  return "http://localhost";
}

function buildBrowserBridgeUrl(
  bridgePath: string,
  token: string,
  localBridgeBaseUrl?: string
): string {
  assertBrowser(bridgePath.length > 0, "Browser bootstrap response is missing a valid bridgePath.");
  assertBrowser(token.length > 0, "Browser bootstrap response is missing a valid token.");

  const isDesktop = typeof window.api !== "undefined";
  const baseUrl =
    isDesktop && typeof localBridgeBaseUrl === "string" && localBridgeBaseUrl.length > 0
      ? localBridgeBaseUrl
      : getBrowserBridgeBaseUrl();
  const fullUrl = baseUrl.endsWith("/")
    ? baseUrl + bridgePath.replace(/^\//, "")
    : baseUrl + bridgePath;
  const wsUrl = new URL(fullUrl);
  wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("token", token);
  return wsUrl.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeMessagePayload(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  return null;
}

function parseFrameMetadata(metadata: unknown): BrowserViewportMetadata | null {
  if (!isRecord(metadata)) {
    return null;
  }

  const values = [
    metadata.deviceWidth,
    metadata.deviceHeight,
    metadata.pageScaleFactor,
    metadata.offsetTop,
    metadata.scrollOffsetX,
    metadata.scrollOffsetY,
  ];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return null;
  }

  const typedMetadata = metadata as {
    deviceWidth: number;
    deviceHeight: number;
    pageScaleFactor: number;
    offsetTop: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
  };

  if (
    typedMetadata.deviceWidth <= 0 ||
    typedMetadata.deviceHeight <= 0 ||
    typedMetadata.pageScaleFactor <= 0
  ) {
    return null;
  }

  return {
    deviceWidth: typedMetadata.deviceWidth,
    deviceHeight: typedMetadata.deviceHeight,
    pageScaleFactor: typedMetadata.pageScaleFactor,
    offsetTop: typedMetadata.offsetTop,
    scrollOffsetX: typedMetadata.scrollOffsetX,
    scrollOffsetY: typedMetadata.scrollOffsetY,
  };
}

function extractStreamState(payload: Record<string, unknown>): BrowserStreamState | null {
  if (typeof payload.status === "string") {
    switch (payload.status) {
      case "connected":
        return "connecting";
      case "screencasting":
        return "live";
      default:
        return null;
    }
  }

  if (payload.connected === true && payload.screencasting === true) {
    return "live";
  }
  if (payload.connected === true) {
    return "connecting";
  }

  return null;
}

function extractMessageError(payload: Record<string, unknown>): string | null {
  if (typeof payload.error === "string" && payload.error.trim().length > 0) {
    return payload.error;
  }
  if (typeof payload.message === "string" && payload.message.trim().length > 0) {
    return payload.message;
  }
  return null;
}

function createSession(
  workspaceId: string,
  sessionName: string,
  sessionId: string,
  status: BrowserSession["status"]
): BrowserSession {
  return {
    id: sessionId,
    workspaceId,
    sessionName,
    status,
    frameBase64: null,
    lastError: null,
    streamState: status === "ended" ? null : "connecting",
    frameMetadata: null,
    currentUrl: null,
    isPageLoading: false,
    pendingUrl: null,
    streamErrorMessage: null,
  };
}

export function useBrowserBridgeConnection(workspaceId: string): {
  session: BrowserSession | null;
  connect: (sessionName: string, options?: BrowserSessionAttachOptions) => void;
  disconnect: () => void;
  sendInput: (input: BrowserInputEvent) => void;
  setPendingUrl: (url: string | null) => void;
} {
  if (workspaceId.trim().length === 0) {
    throw new Error("Browser bridge connection requires a workspaceId");
  }

  const liveApi = useLiveAPI();
  const [session, setSession] = useState<BrowserSession | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const generationRef = useRef(0);
  const intentionalCloseGenerationRef = useRef<number | null>(null);

  const disconnectSocket = (
    nextSession: BrowserSession | null,
    options?: { intentionalCloseGeneration?: number | null }
  ) => {
    intentionalCloseGenerationRef.current = options?.intentionalCloseGeneration ?? null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket != null) {
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        } else if (socket.readyState !== WebSocket.CLOSED) {
          socket.close();
        }
      } catch {
        // Best-effort cleanup only.
      }
    }
    setSession(nextSession);
  };

  const disconnect = () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    disconnectSocket(null, { intentionalCloseGeneration: generation });
  };

  const connect = (sessionName: string, options?: BrowserSessionAttachOptions) => {
    if (sessionName.trim().length === 0) {
      throw new Error("Browser bridge connection requires a non-empty sessionName");
    }
    void (async () => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      intentionalCloseGenerationRef.current = null;

      const sessionId = `browser-${workspaceId}-${sessionName}-${generation}`;
      disconnectSocket(createSession(workspaceId, sessionName, sessionId, "starting"));

      if (!liveApi) {
        setSession((previousSession) =>
          previousSession?.id !== sessionId
            ? previousSession
            : {
                ...previousSession,
                status: "error",
                streamState: "error",
                lastError: "Browser API client is unavailable.",
                streamErrorMessage: "Browser API client is unavailable.",
              }
        );
        return;
      }

      try {
        const bootstrap = await liveApi.browser.getBootstrap({
          workspaceId,
          sessionName,
          ...(options?.allowOtherWorkspaceSession === true
            ? { allowOtherWorkspaceSession: true }
            : {}),
        });
        if (generationRef.current !== generation) {
          return;
        }

        const wsUrl = buildBrowserBridgeUrl(
          bootstrap.bridgePath,
          bootstrap.token,
          bootstrap.localBridgeBaseUrl
        );
        const socket = new WebSocket(wsUrl);
        socketRef.current = socket;

        socket.addEventListener("message", (event) => {
          if (generationRef.current !== generation) {
            return;
          }

          const payloadText = decodeMessagePayload(event.data);
          if (payloadText == null) {
            return;
          }

          let payload: unknown;
          try {
            payload = JSON.parse(payloadText);
          } catch {
            return;
          }

          if (!isRecord(payload) || typeof payload.type !== "string") {
            return;
          }

          switch (payload.type) {
            case "frame": {
              const metadata = parseFrameMetadata(payload.metadata);
              const base64Data =
                typeof payload.data === "string" && payload.data.trim().length > 0
                  ? payload.data
                  : null;
              if (metadata == null || base64Data == null) {
                return;
              }

              setSession((previousSession) => {
                if (previousSession?.id !== sessionId) {
                  return previousSession;
                }

                return {
                  ...previousSession,
                  status: "live",
                  streamState: "live",
                  frameBase64: base64Data,
                  frameMetadata: metadata,
                  lastError: null,
                  streamErrorMessage: null,
                };
              });
              return;
            }
            case "status": {
              const nextState = extractStreamState(payload);
              const nextError = extractMessageError(payload);
              setSession((previousSession) => {
                if (previousSession?.id !== sessionId) {
                  return previousSession;
                }
                if (nextState == null && nextError == null) {
                  return previousSession;
                }

                return {
                  ...previousSession,
                  status: nextState === "live" ? "live" : previousSession.status,
                  streamState: nextState ?? previousSession.streamState,
                  lastError: nextState === "live" ? null : (nextError ?? previousSession.lastError),
                  streamErrorMessage:
                    nextState === "live" ? null : (nextError ?? previousSession.streamErrorMessage),
                };
              });
              return;
            }
            case "page_state": {
              const url = typeof payload.url === "string" ? payload.url : null;
              const isLoading = typeof payload.isLoading === "boolean" ? payload.isLoading : false;

              setSession((previousSession) => {
                if (previousSession?.id !== sessionId) {
                  return previousSession;
                }

                const shouldClearPendingUrl =
                  !isLoading ||
                  (previousSession.pendingUrl != null && previousSession.pendingUrl === url);
                const nextPendingUrl = shouldClearPendingUrl ? null : previousSession.pendingUrl;

                if (
                  previousSession.currentUrl === url &&
                  previousSession.isPageLoading === isLoading &&
                  previousSession.pendingUrl === nextPendingUrl
                ) {
                  return previousSession;
                }

                return {
                  ...previousSession,
                  currentUrl: url,
                  isPageLoading: isLoading,
                  pendingUrl: nextPendingUrl,
                };
              });
              return;
            }
            case "error": {
              const nextError = extractMessageError(payload) ?? "Browser preview stream failed.";
              setSession((previousSession) => {
                if (previousSession?.id !== sessionId) {
                  return previousSession;
                }

                return {
                  ...previousSession,
                  status: "error",
                  streamState: "error",
                  lastError: nextError,
                  streamErrorMessage: nextError,
                };
              });
              try {
                socket.close();
              } catch {
                // Best-effort close only.
              }
            }
          }
        });

        socket.addEventListener("close", (event) => {
          if (generationRef.current !== generation) {
            return;
          }

          socketRef.current = null;
          if (intentionalCloseGenerationRef.current === generation) {
            intentionalCloseGenerationRef.current = null;
            return;
          }

          const closeReason = event.reason.trim();
          const errorMessage =
            closeReason.length > 0
              ? closeReason
              : event.code !== 1000
                ? `Browser preview disconnected (${event.code})`
                : "Browser preview disconnected.";
          setSession((previousSession) => {
            if (previousSession?.id !== sessionId) {
              return previousSession;
            }

            return {
              ...previousSession,
              status: "error",
              streamState: "error",
              lastError: previousSession.lastError ?? errorMessage,
              streamErrorMessage: previousSession.streamErrorMessage ?? errorMessage,
            };
          });
        });
      } catch (error) {
        if (generationRef.current !== generation) {
          return;
        }

        const errorMessage =
          error instanceof Error ? error.message : "Failed to connect browser preview.";
        setSession((previousSession) => {
          if (previousSession?.id !== sessionId) {
            return previousSession;
          }

          return {
            ...previousSession,
            status: "error",
            streamState: "error",
            lastError: errorMessage,
            streamErrorMessage: errorMessage,
          };
        });
      }
    })();
  };

  const sendInput = (input: BrowserInputEvent) => {
    const socket = socketRef.current;
    if (socket == null || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(JSON.stringify(input));
    } catch {
      // Closing sockets can race with human input; fail closed and let connection status speak for itself.
    }
  };

  const setPendingUrl = (url: string | null) => {
    setSession((previousSession) => {
      if (previousSession == null || previousSession.pendingUrl === url) {
        return previousSession;
      }

      return {
        ...previousSession,
        pendingUrl: url,
      };
    });
  };

  useEffect(() => {
    return () => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      disconnectSocket(null, { intentionalCloseGeneration: generation });
    };
  }, []);

  return { session, connect, disconnect, sendInput, setPendingUrl };
}
