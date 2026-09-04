import * as net from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { assert } from "@/common/utils/assert";
import { log } from "@/node/services/log";
import type { DesktopSessionManager } from "./DesktopSessionManager";
import type { DesktopTokenManager } from "./DesktopTokenManager";

const INVALID_TOKEN_CLOSE_CODE = 4001;
const MISSING_SESSION_CLOSE_CODE = 4002;
const VNC_CONNECT_FAILURE_CLOSE_CODE = 4003;
const SERVER_STOPPING_CLOSE_CODE = 1001;
const VNC_HOST = "127.0.0.1";

interface BridgePair {
  ws: WebSocket;
  tcp: net.Socket;
  closed: boolean;
}

export interface DesktopBridgeServerOptions {
  desktopSessionManager: Pick<DesktopSessionManager, "getLiveSessionConnection">;
  desktopTokenManager: Pick<DesktopTokenManager, "validate">;
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

function closeWebSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason);
      return;
    }

    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  } catch (error) {
    log.debug("DesktopBridgeServer: WebSocket close failed", { code, reason, error });
  }
}

function rejectUpgrade(socket: Duplex): void {
  try {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
  } catch (error) {
    log.debug("DesktopBridgeServer: failed to write upgrade rejection response", { error });
  }

  try {
    socket.destroy();
  } catch (error) {
    log.debug("DesktopBridgeServer: failed to destroy rejected upgrade socket", { error });
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

export class DesktopBridgeServer {
  private readonly desktopSessionManager: Pick<DesktopSessionManager, "getLiveSessionConnection">;
  private readonly desktopTokenManager: Pick<DesktopTokenManager, "validate">;
  private readonly wss: WebSocketServer;
  private readonly activePairs = new Set<BridgePair>();
  // Keep upgrade rejection aligned with stop() so httpServer.close() cannot hang on sockets
  // that reconnect after shutdown snapshots the current bridge clients.
  private isStopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(options: DesktopBridgeServerOptions) {
    assert(options.desktopSessionManager, "DesktopBridgeServer requires a DesktopSessionManager");
    assert(options.desktopTokenManager, "DesktopBridgeServer requires a DesktopTokenManager");

    this.desktopSessionManager = options.desktopSessionManager;
    this.desktopTokenManager = options.desktopTokenManager;
    this.wss = new WebSocketServer({ noServer: true });
  }

  public ensureReady(): void {
    assert(this.wss, "DesktopBridgeServer WebSocketServer must be initialized");
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.ensureReady();
    if (this.isStopping) {
      log.debug("DesktopBridgeServer: rejecting upgrade while stopping", { url: request.url });
      rejectUpgrade(socket);
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      void this.handleUpgradedConnection(ws, request);
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
      const trackedWebSockets = new Set(activePairs.map((pair) => pair.ws));
      const activePairClosePromises = activePairs.map((pair) => waitForWebSocketClose(pair.ws));

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

      if (activePairs.length > 0 || orphanClientClosePromises.length > 0) {
        log.debug("DesktopBridgeServer: stopped", {
          activePairs: activePairs.length,
          orphanClients: orphanClientClosePromises.length,
        });
      }
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
    const requestUrl = new URL(request.url ?? "/", `http://${VNC_HOST}`);
    const token = requestUrl.searchParams.get("token");
    if (!token) {
      log.warn("DesktopBridgeServer: rejecting upgrade with missing token", { url: request.url });
      closeWebSocket(ws, INVALID_TOKEN_CLOSE_CODE, "invalid token");
      return;
    }

    const payload = this.desktopTokenManager.validate(token);
    if (!payload) {
      log.warn("DesktopBridgeServer: rejecting upgrade with invalid token", {
        tokenPrefix: token.slice(0, 8),
      });
      closeWebSocket(ws, INVALID_TOKEN_CLOSE_CODE, "invalid token");
      return;
    }

    const liveSession = this.desktopSessionManager.getLiveSessionConnection(payload.workspaceId);
    if (!liveSession || liveSession.sessionId !== payload.sessionId) {
      log.warn("DesktopBridgeServer: rejecting upgrade with missing or mismatched session", {
        workspaceId: payload.workspaceId,
        expectedSessionId: payload.sessionId,
        actualSessionId: liveSession?.sessionId,
      });
      closeWebSocket(ws, MISSING_SESSION_CLOSE_CODE, "session unavailable");
      return;
    }

    try {
      const tcp = await this.connectToVnc(liveSession.vncPort);
      // Tokens name the requester, not the owner: revalidate the current relationship after
      // connecting too, so an archive/removal during TCP setup cannot attach a stale borrower.
      const currentSession = this.desktopSessionManager.getLiveSessionConnection(
        payload.workspaceId
      );
      if (
        currentSession?.sessionId !== payload.sessionId ||
        currentSession.vncPort !== liveSession.vncPort
      ) {
        tcp.destroy();
        closeWebSocket(ws, MISSING_SESSION_CLOSE_CODE, "session unavailable");
        return;
      }
      const pair: BridgePair = { ws, tcp, closed: false };
      this.attachBridgeListeners(pair, payload.workspaceId, liveSession.sessionId);
      this.activePairs.add(pair);
      log.debug("DesktopBridgeServer: bridged desktop session", {
        workspaceId: payload.workspaceId,
        sessionId: liveSession.sessionId,
        vncPort: liveSession.vncPort,
      });

      if (ws.readyState !== WebSocket.OPEN) {
        this.cleanupPair(pair, { closeReason: "websocket closed before bridge finished" });
      }
    } catch (error) {
      log.warn("DesktopBridgeServer: failed to connect to VNC endpoint", {
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        vncPort: liveSession.vncPort,
        error,
      });
      closeWebSocket(ws, VNC_CONNECT_FAILURE_CLOSE_CODE, "vnc connect failed");
    }
  }

  private async connectToVnc(port: number): Promise<net.Socket> {
    assert(Number.isInteger(port), "DesktopBridgeServer VNC port must be an integer");
    assert(port > 0, "DesktopBridgeServer VNC port must be positive");

    return await new Promise<net.Socket>((resolve, reject) => {
      const tcp = net.createConnection({ host: VNC_HOST, port });
      let settled = false;

      const cleanup = () => {
        tcp.off("connect", onConnect);
        tcp.off("error", onError);
        tcp.off("close", onCloseBeforeConnect);
      };

      const onConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(tcp);
      };

      const onError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        tcp.destroy();
        reject(error);
      };

      const onCloseBeforeConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error("VNC socket closed before connecting"));
      };

      tcp.once("connect", onConnect);
      tcp.once("error", onError);
      tcp.once("close", onCloseBeforeConnect);
    });
  }

  private attachBridgeListeners(pair: BridgePair, workspaceId: string, sessionId: string): void {
    pair.ws.on("message", (data, isBinary) => {
      if (pair.closed) {
        return;
      }

      if (!isBinary) {
        log.debug("DesktopBridgeServer: ignoring non-binary WebSocket frame", {
          workspaceId,
          sessionId,
        });
        return;
      }

      try {
        pair.tcp.write(normalizeBinaryMessage(data));
      } catch (error) {
        log.error("DesktopBridgeServer: failed to forward client frame to VNC", {
          workspaceId,
          sessionId,
          error,
        });
        this.cleanupPair(pair, { closeReason: "tcp write failed" });
      }
    });

    pair.ws.on("close", () => {
      this.cleanupPair(pair, { closeReason: "websocket closed" });
    });

    pair.ws.on("error", (error) => {
      log.error("DesktopBridgeServer: WebSocket bridge failed", { workspaceId, sessionId, error });
      this.cleanupPair(pair, { closeReason: "websocket error" });
    });

    pair.tcp.on("data", (chunk) => {
      if (pair.closed) {
        return;
      }

      if (pair.ws.readyState !== WebSocket.OPEN) {
        this.cleanupPair(pair, { closeReason: "websocket unavailable for tcp data" });
        return;
      }

      try {
        pair.ws.send(chunk, { binary: true });
      } catch (error) {
        log.error("DesktopBridgeServer: failed to forward VNC frame to WebSocket", {
          workspaceId,
          sessionId,
          error,
        });
        this.cleanupPair(pair, { closeReason: "websocket send failed" });
      }
    });

    pair.tcp.on("end", () => {
      this.cleanupPair(pair, { closeReason: "tcp ended" });
    });

    pair.tcp.on("close", () => {
      this.cleanupPair(pair, { closeReason: "tcp closed" });
    });

    pair.tcp.on("error", (error) => {
      log.error("DesktopBridgeServer: TCP bridge failed", { workspaceId, sessionId, error });
      this.cleanupPair(pair, { closeReason: "tcp error" });
    });
  }

  private cleanupPair(
    pair: BridgePair,
    options: { closeCode?: number; closeReason?: string } = {}
  ): void {
    if (pair.closed) {
      return;
    }

    pair.closed = true;
    this.activePairs.delete(pair);

    if (!pair.tcp.destroyed) {
      try {
        pair.tcp.destroy();
      } catch (error) {
        log.debug("DesktopBridgeServer: TCP cleanup failed", {
          error,
          reason: options.closeReason,
        });
      }
    }

    if (options.closeCode != null) {
      closeWebSocket(pair.ws, options.closeCode, options.closeReason ?? "closing");
      return;
    }

    try {
      if (pair.ws.readyState === WebSocket.OPEN || pair.ws.readyState === WebSocket.CONNECTING) {
        pair.ws.close();
        return;
      }

      if (pair.ws.readyState !== WebSocket.CLOSED) {
        pair.ws.terminate();
      }
    } catch (error) {
      log.debug("DesktopBridgeServer: WebSocket cleanup failed", {
        error,
        reason: options.closeReason,
      });
    }
  }
}
