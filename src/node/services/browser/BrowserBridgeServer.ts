import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { assert } from "@/common/utils/assert";
import { log } from "@/node/services/log";
import type { AgentBrowserSessionDiscoveryService } from "./AgentBrowserSessionDiscoveryService";
import type { BrowserBridgeTokenManager } from "./BrowserBridgeTokenManager";
import type { BrowserSessionStateHub } from "./BrowserSessionStateHub";

const INVALID_TOKEN_CLOSE_CODE = 4001;
const MISSING_SESSION_CLOSE_CODE = 4002;
const STREAM_CONNECT_FAILURE_CLOSE_CODE = 4003;
const SERVER_STOPPING_CLOSE_CODE = 1001;
const STREAM_HOST = "127.0.0.1";

interface BridgePair {
  client: WebSocket;
  upstream: WebSocket;
  closed: boolean;
}

export interface BrowserBridgeServerOptions {
  browserSessionDiscoveryService: Pick<AgentBrowserSessionDiscoveryService, "getSessionConnection">;
  browserBridgeTokenManager: Pick<BrowserBridgeTokenManager, "validate">;
  browserSessionStateHub?: Pick<BrowserSessionStateHub, "subscribe">;
}

function normalizeBinaryMessage(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.from(data);
}

function normalizeTextMessage(data: RawData): string {
  return normalizeBinaryMessage(data).toString("utf8");
}

function closeWebSocket(ws: WebSocket, code?: number, reason?: string): void {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason);
      return;
    }

    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  } catch (error) {
    log.debug("BrowserBridgeServer: WebSocket close failed", { code, reason, error });
  }
}

function rejectUpgrade(socket: Duplex): void {
  try {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
  } catch (error) {
    log.debug("BrowserBridgeServer: failed to write upgrade rejection response", { error });
  }

  try {
    socket.destroy();
  } catch (error) {
    log.debug("BrowserBridgeServer: failed to destroy rejected upgrade socket", { error });
  }
}

async function waitForWebSocketClose(ws: WebSocket, timeoutMs = 250): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    timeout.unref?.();

    const onClose = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("close", onClose);
    };

    ws.once("close", onClose);
  });
}

async function connectToStream(port: number): Promise<WebSocket> {
  assert(Number.isInteger(port), "BrowserBridgeServer stream port must be an integer");
  assert(port > 0, "BrowserBridgeServer stream port must be positive");

  return await new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const upstream = new WebSocket(`ws://${STREAM_HOST}:${port}`);

    const cleanup = () => {
      upstream.off("open", onOpen);
      upstream.off("error", onError);
      upstream.off("close", onCloseBeforeOpen);
    };

    const onOpen = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(upstream);
    };

    const onError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      closeWebSocket(upstream);
      reject(error);
    };

    const onCloseBeforeOpen = (code: number, reason: Buffer) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(
        new Error(
          reason.toString("utf8").trim() || `Upstream WebSocket closed before open (${code})`
        )
      );
    };

    upstream.once("open", onOpen);
    upstream.once("error", onError);
    upstream.once("close", onCloseBeforeOpen);
  });
}

export class BrowserBridgeServer {
  private readonly browserSessionDiscoveryService: BrowserBridgeServerOptions["browserSessionDiscoveryService"];
  private readonly browserBridgeTokenManager: BrowserBridgeServerOptions["browserBridgeTokenManager"];
  private readonly browserSessionStateHub: BrowserBridgeServerOptions["browserSessionStateHub"];
  private readonly wss: WebSocketServer;
  private readonly activePairs = new Set<BridgePair>();
  private readonly pairStateUnsubscribers = new Map<BridgePair, () => void>();
  private isStopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(options: BrowserBridgeServerOptions) {
    assert(
      options.browserSessionDiscoveryService,
      "BrowserBridgeServer requires a browserSessionDiscoveryService"
    );
    assert(
      options.browserBridgeTokenManager,
      "BrowserBridgeServer requires a BrowserBridgeTokenManager"
    );

    this.browserSessionDiscoveryService = options.browserSessionDiscoveryService;
    this.browserBridgeTokenManager = options.browserBridgeTokenManager;
    this.browserSessionStateHub = options.browserSessionStateHub;
    this.wss = new WebSocketServer({ noServer: true });
  }

  public ensureReady(): void {
    assert(this.wss, "BrowserBridgeServer WebSocketServer must be initialized");
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.ensureReady();
    if (this.isStopping) {
      // Log only the path: the upgrade URL carries the bridge token as `?token=` (#4853).
      log.debug("BrowserBridgeServer: rejecting upgrade while stopping", {
        path: request.url?.split("?", 1)[0],
      });
      rejectUpgrade(socket);
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleUpgradedConnection(ws, request).catch((error: unknown) => {
        log.error("BrowserBridgeServer: bridge setup failed", {
          path: request.url?.split("?", 1)[0],
          error,
        });
        closeWebSocket(ws, MISSING_SESSION_CLOSE_CODE, "session unavailable");
      });
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    this.isStopping = true;
    const stopPromise = (async () => {
      const activePairs = Array.from(this.activePairs);
      const trackedWebSockets = new Set(
        activePairs.flatMap((pair) => [pair.client, pair.upstream])
      );
      const activePairClosePromises = activePairs.flatMap((pair) => [
        waitForWebSocketClose(pair.client),
        waitForWebSocketClose(pair.upstream),
      ]);

      for (const pair of activePairs) {
        this.cleanupPair(pair, {
          closeCode: SERVER_STOPPING_CLOSE_CODE,
          closeReason: "server stopping",
        });
      }
      await Promise.allSettled(activePairClosePromises);

      const orphanClientClosePromises: Array<Promise<void>> = [];
      for (const ws of this.wss.clients) {
        if (trackedWebSockets.has(ws)) {
          continue;
        }

        orphanClientClosePromises.push(waitForWebSocketClose(ws));
        closeWebSocket(ws, SERVER_STOPPING_CLOSE_CODE, "server stopping");
      }
      await Promise.allSettled(orphanClientClosePromises);

      for (const ws of this.wss.clients) {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
      }

      this.activePairs.clear();
    })();
    this.stopPromise = stopPromise;

    try {
      await stopPromise;
    } finally {
      this.stopPromise = null;
      this.isStopping = false;
    }
  }

  private async handleUpgradedConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", `http://${STREAM_HOST}`);
    const token = requestUrl.searchParams.get("token");
    if (!token) {
      // Path only: `?token=&token=<real>` reaches this branch with a token in the URL (#4853).
      log.warn("BrowserBridgeServer: rejecting upgrade with missing token", {
        path: requestUrl.pathname,
      });
      closeWebSocket(ws, INVALID_TOKEN_CLOSE_CODE, "invalid token");
      return;
    }

    const payload = this.browserBridgeTokenManager.validate(token);
    if (!payload) {
      log.warn("BrowserBridgeServer: rejecting upgrade with invalid token", {
        tokenPrefix: token.slice(0, 8),
      });
      closeWebSocket(ws, INVALID_TOKEN_CLOSE_CODE, "invalid token");
      return;
    }

    const liveSession = await this.browserSessionDiscoveryService.getSessionConnection(
      payload.workspaceId,
      payload.sessionName,
      { allowOtherWorkspaceSession: payload.allowOtherWorkspaceSession }
    );
    if (
      !liveSession ||
      liveSession.sessionName !== payload.sessionName ||
      liveSession.streamPort !== payload.streamPort
    ) {
      log.warn("BrowserBridgeServer: rejecting upgrade with missing or mismatched session", {
        workspaceId: payload.workspaceId,
        expectedSessionName: payload.sessionName,
        actualSessionName: liveSession?.sessionName,
        expectedStreamPort: payload.streamPort,
        actualStreamPort: liveSession?.streamPort,
      });
      closeWebSocket(ws, MISSING_SESSION_CLOSE_CODE, "session unavailable");
      return;
    }

    try {
      const upstream = await connectToStream(liveSession.streamPort);
      const pair: BridgePair = { client: ws, upstream, closed: false };
      this.attachBridgeListeners(pair, payload.workspaceId, liveSession.sessionName);
      this.activePairs.add(pair);
      if (this.browserSessionStateHub) {
        const unsubscribe = this.browserSessionStateHub.subscribe(
          payload.workspaceId,
          liveSession.sessionName,
          (state) => {
            if (pair.closed) {
              return;
            }

            try {
              pair.client.send(JSON.stringify(state));
            } catch {
              // Best-effort page state delivery should never take down the bridge.
            }
          }
        );
        this.pairStateUnsubscribers.set(pair, unsubscribe);
      }
      if (ws.readyState !== WebSocket.OPEN) {
        this.cleanupPair(pair, { closeReason: "websocket closed before bridge finished" });
      }
    } catch (error) {
      log.warn("BrowserBridgeServer: failed to connect to stream endpoint", {
        workspaceId: payload.workspaceId,
        sessionName: payload.sessionName,
        streamPort: payload.streamPort,
        error,
      });
      closeWebSocket(ws, STREAM_CONNECT_FAILURE_CLOSE_CODE, "stream connect failed");
    }
  }

  private attachBridgeListeners(pair: BridgePair, workspaceId: string, sessionId: string): void {
    pair.client.on("message", (data, isBinary) => {
      if (pair.closed) {
        return;
      }

      try {
        pair.upstream.send(isBinary ? normalizeBinaryMessage(data) : normalizeTextMessage(data), {
          binary: isBinary,
        });
      } catch (error) {
        log.error("BrowserBridgeServer: failed to forward client frame to upstream", {
          workspaceId,
          sessionId,
          error,
        });
        this.cleanupPair(pair, { closeReason: "upstream write failed" });
      }
    });

    pair.client.on("close", () => {
      this.cleanupPair(pair, { closeReason: "client websocket closed" });
    });

    pair.client.on("error", (error) => {
      log.error("BrowserBridgeServer: client WebSocket bridge failed", {
        workspaceId,
        sessionId,
        error,
      });
      this.cleanupPair(pair, { closeReason: "client websocket error" });
    });

    pair.upstream.on("message", (data, isBinary) => {
      if (pair.closed) {
        return;
      }

      try {
        pair.client.send(isBinary ? normalizeBinaryMessage(data) : normalizeTextMessage(data), {
          binary: isBinary,
        });
      } catch (error) {
        log.error("BrowserBridgeServer: failed to forward upstream frame to client", {
          workspaceId,
          sessionId,
          error,
        });
        this.cleanupPair(pair, { closeReason: "client write failed" });
      }
    });

    pair.upstream.on("close", () => {
      this.cleanupPair(pair, { closeReason: "upstream websocket closed" });
    });

    pair.upstream.on("error", (error) => {
      log.error("BrowserBridgeServer: upstream WebSocket bridge failed", {
        workspaceId,
        sessionId,
        error,
      });
      this.cleanupPair(pair, { closeReason: "upstream websocket error" });
    });
  }

  private cleanupPair(
    pair: BridgePair,
    options?: {
      closeCode?: number;
      closeReason?: string;
    }
  ): void {
    if (pair.closed) {
      return;
    }

    const unsubscribe = this.pairStateUnsubscribers.get(pair);
    if (unsubscribe) {
      unsubscribe();
      this.pairStateUnsubscribers.delete(pair);
    }

    pair.closed = true;
    this.activePairs.delete(pair);

    closeWebSocket(pair.upstream, options?.closeCode, options?.closeReason);
    closeWebSocket(pair.client, options?.closeCode, options?.closeReason);
  }
}
