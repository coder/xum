import * as http from "node:http";
import type { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { log } from "@/node/services/log";
import { BrowserBridgeServer } from "./BrowserBridgeServer";
import type { BrowserBridgeTokenPayload } from "./BrowserBridgeTokenManager";
import type { PageState } from "./BrowserSessionStateHub";

const VALID_TOKEN = "valid-token";
const VALID_WORKSPACE_ID = "workspace-1";
const VALID_SESSION_NAME = "session-a";
const VALID_STREAM_PORT = 9222;

interface UpgradeHarness {
  port: number;
  close: () => Promise<void>;
}

interface UpstreamHarness {
  port: number;
  connectionPromise: Promise<WebSocket>;
  close: () => Promise<void>;
}

function normalizeMessage(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

function createAttachableConnection(sessionName: string, streamPort: number) {
  return {
    sessionName,
    pid: 101,
    cwd: "/tmp/project",
    status: "attachable" as const,
    streamPort,
  };
}

function createBridgeServer(
  options: {
    validate?: (token: string) => BrowserBridgeTokenPayload | null;
    getSessionConnection?: (
      workspaceId: string,
      sessionName: string,
      options?: { allowOtherWorkspaceSession?: boolean }
    ) => Promise<{
      sessionName: string;
      pid: number;
      cwd: string;
      status: "attachable";
      streamPort: number;
    } | null>;
    subscribe?: (
      workspaceId: string,
      sessionName: string,
      callback: (state: PageState) => void
    ) => () => void;
  } = {}
): BrowserBridgeServer {
  return new BrowserBridgeServer({
    browserBridgeTokenManager: {
      validate:
        options.validate ??
        mock((token: string) =>
          token === VALID_TOKEN
            ? {
                workspaceId: VALID_WORKSPACE_ID,
                sessionName: VALID_SESSION_NAME,
                streamPort: VALID_STREAM_PORT,
                allowOtherWorkspaceSession: false,
              }
            : null
        ),
    },
    browserSessionDiscoveryService: {
      getSessionConnection:
        options.getSessionConnection ??
        mock((workspaceId: string, sessionName: string) =>
          Promise.resolve(
            workspaceId === VALID_WORKSPACE_ID && sessionName === VALID_SESSION_NAME
              ? createAttachableConnection(sessionName, VALID_STREAM_PORT)
              : null
          )
        ),
    },
    browserSessionStateHub:
      options.subscribe == null
        ? undefined
        : {
            subscribe: options.subscribe,
          },
  });
}

type MockClientSocket = Pick<WebSocket, "readyState" | "close" | "terminate"> & {
  close: ReturnType<typeof mock>;
  terminate: ReturnType<typeof mock>;
};

interface BrowserBridgeServerPrivate {
  handleUpgradedConnection(ws: WebSocket, request: IncomingMessage): Promise<void>;
}

class MockBridgeClientSocket extends EventEmitter {
  public readyState = WebSocket.OPEN;
  public readonly close = mock();
  public readonly terminate = mock();
  public readonly send = mock();
}

function createMockClientSocket(): MockClientSocket {
  return {
    readyState: WebSocket.OPEN,
    close: mock(),
    terminate: mock(),
  };
}

async function listenUpstreamServer(): Promise<UpstreamHarness> {
  let resolveConnection: ((socket: WebSocket) => void) | null = null;
  const connectionPromise = new Promise<WebSocket>((resolve) => {
    resolveConnection = resolve;
  });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket) => {
    resolveConnection?.(socket);
  });

  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected upstream server to expose a numeric port");
  }

  return {
    port: address.port,
    connectionPromise,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function listenUpgradeServer(bridgeServer: BrowserBridgeServer): Promise<UpgradeHarness> {
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    bridgeServer.handleUpgrade(request, socket, head);
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected upgrade server to expose a numeric port");
  }

  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    ws.once("open", onOpen);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

async function closeClientWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

async function waitForMessage(ws: WebSocket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const onMessage = (data: RawData) => {
      cleanup();
      resolve(normalizeMessage(data));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before receiving a message"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    ws.once("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

describe("BrowserBridgeServer", () => {
  test("bridges raw WebSocket messages in both directions for a valid token", async () => {
    const upstreamHarness = await listenUpstreamServer();
    const bridgeServer = createBridgeServer({
      getSessionConnection: mock((workspaceId: string, sessionName: string) =>
        Promise.resolve(
          workspaceId === VALID_WORKSPACE_ID && sessionName === VALID_SESSION_NAME
            ? createAttachableConnection(sessionName, upstreamHarness.port)
            : null
        )
      ),
      validate: mock((token: string) =>
        token === VALID_TOKEN
          ? {
              workspaceId: VALID_WORKSPACE_ID,
              sessionName: VALID_SESSION_NAME,
              streamPort: upstreamHarness.port,
              allowOtherWorkspaceSession: false,
            }
          : null
      ),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
    try {
      await waitForWebSocketOpen(ws);
      const upstreamSocket = await upstreamHarness.connectionPromise;

      ws.send('{"type":"input_keyboard","eventType":"keyDown","key":"a"}');
      expect(await waitForMessage(upstreamSocket)).toBe(
        '{"type":"input_keyboard","eventType":"keyDown","key":"a"}'
      );

      upstreamSocket.send('{"type":"frame","data":"abc"}');
      expect(await waitForMessage(ws)).toBe('{"type":"frame","data":"abc"}');
    } finally {
      ws.terminate();
      await upgradeHarness.close();
      await bridgeServer.stop();
      await upstreamHarness.close();
    }
  });

  test("bridges explicit other-workspace tokens on the success path", async () => {
    const upstreamHarness = await listenUpstreamServer();
    const getSessionConnection = mock(() =>
      Promise.resolve(createAttachableConnection(VALID_SESSION_NAME, upstreamHarness.port))
    );
    const bridgeServer = createBridgeServer({
      getSessionConnection,
      validate: mock(() => ({
        workspaceId: VALID_WORKSPACE_ID,
        sessionName: VALID_SESSION_NAME,
        streamPort: upstreamHarness.port,
        allowOtherWorkspaceSession: true,
      })),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
    try {
      await waitForWebSocketOpen(ws);
      await upstreamHarness.connectionPromise;

      expect(getSessionConnection).toHaveBeenCalledWith(VALID_WORKSPACE_ID, VALID_SESSION_NAME, {
        allowOtherWorkspaceSession: true,
      });
    } finally {
      ws.terminate();
      await upgradeHarness.close();
      await bridgeServer.stop();
      await upstreamHarness.close();
    }
  });

  test("closes with 4001 for invalid or missing tokens", async () => {
    const bridgeServer = createBridgeServer({
      validate: mock(() => null),
      getSessionConnection: mock(() => Promise.resolve(null)),
    });

    const warnSpy = spyOn(log, "warn");

    try {
      // An empty first `token` hides a real one from searchParams.get (#4853).
      for (const url of ["/", "/?token=bad-token", "/?token=&token=SECRET-dup"]) {
        const ws = createMockClientSocket();
        const bridgeServerPrivate = bridgeServer as unknown as BrowserBridgeServerPrivate;
        await bridgeServerPrivate.handleUpgradedConnection(
          ws as unknown as WebSocket,
          { url } as IncomingMessage
        );
        expect(ws.close).toHaveBeenCalledWith(4001, "invalid token");
      }
      expect(warnSpy).toHaveBeenCalledWith(
        "BrowserBridgeServer: rejecting upgrade with missing token",
        { path: "/" }
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("SECRET-dup");
    } finally {
      warnSpy.mockRestore();
      await bridgeServer.stop();
    }
  });

  test("revalidates explicit other-workspace tokens with the same session scope", async () => {
    const getSessionConnection = mock(() => Promise.resolve(null));
    const bridgeServer = createBridgeServer({
      validate: mock(() => ({
        workspaceId: VALID_WORKSPACE_ID,
        sessionName: VALID_SESSION_NAME,
        streamPort: VALID_STREAM_PORT,
        allowOtherWorkspaceSession: true,
      })),
      getSessionConnection,
    });

    try {
      const ws = createMockClientSocket();
      const bridgeServerPrivate = bridgeServer as unknown as BrowserBridgeServerPrivate;
      await bridgeServerPrivate.handleUpgradedConnection(
        ws as unknown as WebSocket,
        { url: `/?token=${VALID_TOKEN}` } as IncomingMessage
      );

      expect(getSessionConnection).toHaveBeenCalledWith(VALID_WORKSPACE_ID, VALID_SESSION_NAME, {
        allowOtherWorkspaceSession: true,
      });
      expect(ws.close).toHaveBeenCalledWith(4002, "session unavailable");
    } finally {
      await bridgeServer.stop();
    }
  });

  test("closes with 4002 when the live session is missing or mismatched", async () => {
    for (const liveSession of [null, createAttachableConnection(VALID_SESSION_NAME, 9999)]) {
      const bridgeServer = createBridgeServer({
        validate: mock(() => ({
          workspaceId: VALID_WORKSPACE_ID,
          sessionName: VALID_SESSION_NAME,
          streamPort: VALID_STREAM_PORT,
          allowOtherWorkspaceSession: false,
        })),
        getSessionConnection: mock(() => Promise.resolve(liveSession)),
      });

      try {
        const ws = createMockClientSocket();
        const bridgeServerPrivate = bridgeServer as unknown as BrowserBridgeServerPrivate;
        await bridgeServerPrivate.handleUpgradedConnection(
          ws as unknown as WebSocket,
          { url: `/?token=${VALID_TOKEN}` } as IncomingMessage
        );
        expect(ws.close).toHaveBeenCalledWith(4002, "session unavailable");
      } finally {
        await bridgeServer.stop();
      }
    }
  });

  test("sends the initial page_state snapshot from the session hub on connect", async () => {
    const upstreamHarness = await listenUpstreamServer();
    const initialState: PageState = {
      type: "page_state",
      url: "https://example.com/bootstrap",
      isLoading: false,
      source: "bootstrap",
    };
    const subscribe = mock(
      (_workspaceId: string, _sessionName: string, callback: (state: PageState) => void) => {
        callback(initialState);
        return () => undefined;
      }
    );
    const bridgeServer = createBridgeServer({
      getSessionConnection: mock((workspaceId: string, sessionName: string) =>
        Promise.resolve(
          workspaceId === VALID_WORKSPACE_ID && sessionName === VALID_SESSION_NAME
            ? createAttachableConnection(sessionName, upstreamHarness.port)
            : null
        )
      ),
      validate: mock((token: string) =>
        token === VALID_TOKEN
          ? {
              workspaceId: VALID_WORKSPACE_ID,
              sessionName: VALID_SESSION_NAME,
              streamPort: upstreamHarness.port,
              allowOtherWorkspaceSession: false,
            }
          : null
      ),
      subscribe,
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
    try {
      await waitForWebSocketOpen(ws);
      await upstreamHarness.connectionPromise;

      expect(JSON.parse(await waitForMessage(ws))).toEqual(initialState);
      expect(subscribe).toHaveBeenCalledWith(
        VALID_WORKSPACE_ID,
        VALID_SESSION_NAME,
        expect.any(Function)
      );
    } finally {
      ws.terminate();
      await upgradeHarness.close();
      await bridgeServer.stop();
      await upstreamHarness.close();
    }
  });

  test("forwards page_state updates from the session hub while the bridge is connected", async () => {
    const upstreamHarness = await listenUpstreamServer();
    const updatedState: PageState = {
      type: "page_state",
      url: "https://example.com/next",
      isLoading: true,
      source: "command",
    };
    let stateCallback: ((state: PageState) => void) | null = null;
    const bridgeServer = createBridgeServer({
      getSessionConnection: mock((workspaceId: string, sessionName: string) =>
        Promise.resolve(
          workspaceId === VALID_WORKSPACE_ID && sessionName === VALID_SESSION_NAME
            ? createAttachableConnection(sessionName, upstreamHarness.port)
            : null
        )
      ),
      validate: mock((token: string) =>
        token === VALID_TOKEN
          ? {
              workspaceId: VALID_WORKSPACE_ID,
              sessionName: VALID_SESSION_NAME,
              streamPort: upstreamHarness.port,
              allowOtherWorkspaceSession: false,
            }
          : null
      ),
      subscribe: (
        _workspaceId: string,
        _sessionName: string,
        callback: (state: PageState) => void
      ) => {
        stateCallback = callback;
        return () => undefined;
      },
    });
    const clientSocket = new MockBridgeClientSocket();
    const bridgeServerPrivate = bridgeServer as unknown as BrowserBridgeServerPrivate;

    try {
      await bridgeServerPrivate.handleUpgradedConnection(
        clientSocket as unknown as WebSocket,
        { url: `/?token=${VALID_TOKEN}` } as IncomingMessage
      );
      await upstreamHarness.connectionPromise;

      if (stateCallback == null) {
        throw new Error("Expected BrowserBridgeServer to subscribe to the session state hub");
      }
      const subscribedStateCallback = stateCallback as (state: PageState) => void;
      subscribedStateCallback(updatedState);

      expect(clientSocket.send).toHaveBeenCalledWith(JSON.stringify(updatedState));
    } finally {
      clientSocket.emit("close");
      await bridgeServer.stop();
      await upstreamHarness.close();
    }
  });

  test("unsubscribes from the session hub when a bridge pair is cleaned up", async () => {
    const upstreamHarness = await listenUpstreamServer();
    let resolveUnsubscribe!: () => void;
    const unsubscribePromise = new Promise<void>((resolve) => {
      resolveUnsubscribe = resolve;
    });
    const unsubscribe = mock(() => {
      resolveUnsubscribe();
    });
    const bridgeServer = createBridgeServer({
      getSessionConnection: mock((workspaceId: string, sessionName: string) =>
        Promise.resolve(
          workspaceId === VALID_WORKSPACE_ID && sessionName === VALID_SESSION_NAME
            ? createAttachableConnection(sessionName, upstreamHarness.port)
            : null
        )
      ),
      validate: mock((token: string) =>
        token === VALID_TOKEN
          ? {
              workspaceId: VALID_WORKSPACE_ID,
              sessionName: VALID_SESSION_NAME,
              streamPort: upstreamHarness.port,
              allowOtherWorkspaceSession: false,
            }
          : null
      ),
      subscribe: () => unsubscribe,
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
    try {
      await waitForWebSocketOpen(ws);
      await upstreamHarness.connectionPromise;

      await closeClientWebSocket(ws);
      await unsubscribePromise;

      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      ws.terminate();
      await upgradeHarness.close();
      await bridgeServer.stop();
      await upstreamHarness.close();
    }
  });

  test("closes the client socket when bridge setup rejects", async () => {
    const bridgeServer = createBridgeServer({
      getSessionConnection: mock(() => Promise.reject(new Error("boom"))),
    });
    const ws = createMockClientSocket();
    const internalBridgeServer = bridgeServer as unknown as {
      wss: {
        handleUpgrade: (
          request: IncomingMessage,
          socket: unknown,
          head: Buffer,
          callback: (ws: WebSocket) => void
        ) => void;
      };
    };
    internalBridgeServer.wss.handleUpgrade = (_request, _socket, _head, callback) => {
      callback(ws as unknown as WebSocket);
    };

    const errorSpy = spyOn(log, "error");

    try {
      bridgeServer.handleUpgrade(
        { url: `/?token=${VALID_TOKEN}` } as IncomingMessage,
        {} as never,
        Buffer.alloc(0)
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(ws.close).toHaveBeenCalledWith(4002, "session unavailable");
      // The upgrade URL carries the bridge token; the failure log must not (#4853).
      expect(errorSpy).toHaveBeenCalledWith(
        "BrowserBridgeServer: bridge setup failed",
        expect.objectContaining({ path: "/" })
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(VALID_TOKEN);
    } finally {
      errorSpy.mockRestore();
      await bridgeServer.stop();
    }
  });

  test("does not log the token of an upgrade rejected while stopping", async () => {
    const bridgeServer = createBridgeServer();
    const socket = { write: mock(() => true), destroy: mock(() => undefined) };
    const debugSpy = spyOn(log, "debug");

    try {
      // stop() sets the stopping flag synchronously, before its first await.
      const stopPromise = bridgeServer.stop();
      bridgeServer.handleUpgrade(
        { url: `/browser/ws?token=${VALID_TOKEN}` } as IncomingMessage,
        socket as never,
        Buffer.alloc(0)
      );
      await stopPromise;

      expect(socket.destroy).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        "BrowserBridgeServer: rejecting upgrade while stopping",
        { path: "/browser/ws" }
      );
      expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(VALID_TOKEN);
    } finally {
      debugSpy.mockRestore();
    }
  });

  test("closes with 4003 when the upstream stream cannot be reached", async () => {
    const bridgeServer = createBridgeServer();

    try {
      const ws = createMockClientSocket();
      const bridgeServerPrivate = bridgeServer as unknown as BrowserBridgeServerPrivate;
      await bridgeServerPrivate.handleUpgradedConnection(
        ws as unknown as WebSocket,
        { url: `/?token=${VALID_TOKEN}` } as IncomingMessage
      );
      expect(ws.close).toHaveBeenCalledWith(4003, "stream connect failed");
    } finally {
      await bridgeServer.stop();
    }
  });
});
