import * as http from "node:http";
import * as net from "node:net";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { WebSocket, type RawData } from "ws";
import { DesktopBridgeServer } from "./DesktopBridgeServer";
import { DesktopTokenManager } from "./DesktopTokenManager";

const VALID_TOKEN = "valid-token";
const VALID_WORKSPACE_ID = "workspace-1";
const VALID_SESSION_ID = "desktop:workspace-1";

interface TcpHarness {
  server: net.Server;
  port: number;
  connectionPromise: Promise<net.Socket>;
  close: () => Promise<void>;
}

interface UpgradeHarness {
  port: number;
  close: () => Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((_innerResolve, innerReject) => {
    reject = innerReject;
  });
  void promise.catch(() => undefined);
  return { promise, reject };
}

function createBridgeServer(options: {
  validate?: (token: string) => { workspaceId: string; sessionId: string } | null;
  getLiveSessionConnection?:
    | ((workspaceId: string) => { sessionId: string; vncPort: number } | null)
    | (() => { sessionId: string; vncPort: number } | null);
}): DesktopBridgeServer {
  return new DesktopBridgeServer({
    desktopTokenManager: {
      validate:
        options.validate ??
        mock((token: string) =>
          token === VALID_TOKEN
            ? { workspaceId: VALID_WORKSPACE_ID, sessionId: VALID_SESSION_ID }
            : null
        ),
    },
    desktopSessionManager: {
      getLiveSessionConnection:
        options.getLiveSessionConnection ??
        mock((workspaceId: string) =>
          workspaceId === VALID_WORKSPACE_ID ? { sessionId: VALID_SESSION_ID, vncPort: 5900 } : null
        ),
    },
  });
}

async function listenTcpServer(): Promise<TcpHarness> {
  const sockets = new Set<net.Socket>();
  let resolveConnection: ((socket: net.Socket) => void) | null = null;
  const connectionPromise = new Promise<net.Socket>((resolve) => {
    resolveConnection = resolve;
  });

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    resolveConnection?.(socket);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP test server to expose a numeric port");
  }

  return {
    server,
    port: address.port,
    connectionPromise,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeTcpServer(server);
    },
  };
}

async function closeTcpServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function listenUpgradeServer(bridgeServer: DesktopBridgeServer): Promise<UpgradeHarness> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  server.on("upgrade", (request, socket, head) => {
    bridgeServer.handleUpgrade(request, socket, head);
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected upgrade test server to expose a numeric port");
  }

  return {
    port: address.port,
    close: async () => {
      server.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
  };
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };

    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function waitForWebSocketClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return await new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      resolve({ code, reason: reason.toString() });
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
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

async function waitForWebSocketMessage(ws: WebSocket): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const onMessage = (data: RawData, isBinary: boolean) => {
      cleanup();
      if (!isBinary) {
        reject(new Error("Expected a binary WebSocket message"));
        return;
      }
      resolve(normalizeBinaryMessage(data));
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

async function waitForTcpData(socket: net.Socket, timeoutMs = 2_000): Promise<Buffer | null> {
  return await new Promise<Buffer | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("TCP socket closed before receiving data"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };

    socket.once("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

describe("DesktopBridgeServer", () => {
  test("shared tokens authorize the requester and bind its owner's session", async () => {
    const tcpHarness = await listenTcpServer();
    const tokens = new DesktopTokenManager();
    const token = tokens.mint("child", "owner-session");
    const getLiveSessionConnection = mock((workspaceId: string) =>
      workspaceId === "child" ? { sessionId: "owner-session", vncPort: tcpHarness.port } : null
    );
    const bridgeServer = new DesktopBridgeServer({
      desktopTokenManager: tokens,
      desktopSessionManager: { getLiveSessionConnection },
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${token}&workspaceId=owner`);
      await waitForWebSocketOpen(ws);
      const tcpSocket = await tcpHarness.connectionPromise;
      ws.send(Buffer.from([1, 2, 3]));
      expect(await waitForTcpData(tcpSocket)).toEqual(Buffer.from([1, 2, 3]));
      expect(getLiveSessionConnection.mock.calls.map((call) => call[0])).toEqual([
        "child",
        "child",
      ]);
      const replay = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${token}`);
      expect((await waitForWebSocketClose(replay)).code).toBe(4001);
    } finally {
      if (ws) await closeWebSocket(ws);
      tokens.dispose();
      await upgradeHarness.close();
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });

  test("refuses a requester whose target disappears while connecting to VNC", async () => {
    const tcpHarness = await listenTcpServer();
    let checks = 0;
    const bridgeServer = createBridgeServer({
      getLiveSessionConnection: () => {
        checks += 1;
        return checks === 1 ? { sessionId: VALID_SESSION_ID, vncPort: tcpHarness.port } : null;
      },
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      expect((await waitForWebSocketClose(ws)).code).toBe(4002);
      expect(checks).toBe(2);
    } finally {
      await upgradeHarness.close();
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });

  test("handleUpgrade bridges binary traffic when mounted on an external HTTP server", async () => {
    const tcpHarness = await listenTcpServer();
    const bridgeServer = createBridgeServer({
      getLiveSessionConnection: mock((workspaceId: string) =>
        workspaceId === VALID_WORKSPACE_ID
          ? { sessionId: VALID_SESSION_ID, vncPort: tcpHarness.port }
          : null
      ),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      await waitForWebSocketOpen(ws);

      const tcpSocket = await tcpHarness.connectionPromise;
      ws.send(Buffer.from([0x01, 0x02, 0x03]));
      const forwarded = await waitForTcpData(tcpSocket);
      expect(forwarded).toEqual(Buffer.from([0x01, 0x02, 0x03]));

      tcpSocket.write(Buffer.from([0x0a, 0x0b, 0x0c]));
      expect(await waitForWebSocketMessage(ws)).toEqual(Buffer.from([0x0a, 0x0b, 0x0c]));
    } finally {
      if (ws) {
        await closeWebSocket(ws);
      }
      await upgradeHarness.close();
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });

  test("bridges binary traffic in both directions for a valid token", async () => {
    const tcpHarness = await listenTcpServer();
    const bridgeServer = createBridgeServer({
      getLiveSessionConnection: mock((workspaceId: string) =>
        workspaceId === VALID_WORKSPACE_ID
          ? { sessionId: VALID_SESSION_ID, vncPort: tcpHarness.port }
          : null
      ),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      await waitForWebSocketOpen(ws);

      const tcpSocket = await tcpHarness.connectionPromise;
      ws.send(Buffer.from([0x01, 0x02, 0x03]));
      const forwarded = await waitForTcpData(tcpSocket);
      expect(forwarded).toEqual(Buffer.from([0x01, 0x02, 0x03]));

      tcpSocket.write(Buffer.from([0x0a, 0x0b, 0x0c]));
      expect(await waitForWebSocketMessage(ws)).toEqual(Buffer.from([0x0a, 0x0b, 0x0c]));
    } finally {
      if (ws) {
        await closeWebSocket(ws);
      }
      await upgradeHarness.close();
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });

  test("closes with 4001 for invalid or missing tokens", async () => {
    const bridgeServer = createBridgeServer({
      validate: mock(() => null),
      getLiveSessionConnection: mock(() => null),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    try {
      for (const suffix of ["", "/?token=bad-token"]) {
        const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}${suffix}`);
        const closeEvent = await waitForWebSocketClose(ws);
        expect(closeEvent.code).toBe(4001);
        expect(closeEvent.reason).toBe("invalid token");
      }
    } finally {
      await upgradeHarness.close();
      await bridgeServer.stop();
    }
  });

  test("closes with 4002 when the live session is missing or mismatched", async () => {
    const scenarios = [
      { name: "missing session", liveSession: null },
      {
        name: "mismatched session",
        liveSession: { sessionId: "desktop:other-workspace", vncPort: 5900 },
      },
    ];

    for (const scenario of scenarios) {
      const bridgeServer = createBridgeServer({
        validate: mock(() => ({ workspaceId: VALID_WORKSPACE_ID, sessionId: VALID_SESSION_ID })),
        getLiveSessionConnection: mock(() => scenario.liveSession),
      });
      const upgradeHarness = await listenUpgradeServer(bridgeServer);

      try {
        const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
        const closeEvent = await waitForWebSocketClose(ws);
        expect(closeEvent.code).toBe(4002);
        expect(closeEvent.reason).toBe("session unavailable");
      } finally {
        await upgradeHarness.close();
        await bridgeServer.stop();
      }
    }
  });

  test("closes with 4003 when the VNC endpoint cannot be reached", async () => {
    const deadServer = await listenTcpServer();
    const deadPort = deadServer.port;
    await deadServer.close();

    const bridgeServer = createBridgeServer({
      validate: mock(() => ({ workspaceId: VALID_WORKSPACE_ID, sessionId: VALID_SESSION_ID })),
      getLiveSessionConnection: mock(() => ({
        sessionId: VALID_SESSION_ID,
        vncPort: deadPort,
      })),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      const closeEvent = await waitForWebSocketClose(ws);
      expect(closeEvent.code).toBe(4003);
      expect(closeEvent.reason).toBe("vnc connect failed");
    } finally {
      await upgradeHarness.close();
      await bridgeServer.stop();
    }
  });

  test("stop closes active connections and is idempotent", async () => {
    const tcpHarness = await listenTcpServer();
    const bridgeServer = createBridgeServer({
      validate: mock(() => ({ workspaceId: VALID_WORKSPACE_ID, sessionId: VALID_SESSION_ID })),
      getLiveSessionConnection: mock(() => ({
        sessionId: VALID_SESSION_ID,
        vncPort: tcpHarness.port,
      })),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);
    const hangingConnect = createDeferred<net.Socket>();

    interface PrivateBridgeServer {
      connectToVnc: (port: number) => Promise<net.Socket>;
    }

    let activeWs: WebSocket | null = null;
    let orphanWs: WebSocket | null = null;
    const connectToVncSpy = spyOn(bridgeServer as unknown as PrivateBridgeServer, "connectToVnc");

    try {
      connectToVncSpy.mockRestore();

      activeWs = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      await waitForWebSocketOpen(activeWs);
      await tcpHarness.connectionPromise;

      connectToVncSpy.mockImplementation(() => hangingConnect.promise);
      orphanWs = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      await waitForWebSocketOpen(orphanWs);

      const activeClosePromise = waitForWebSocketClose(activeWs);
      const orphanClosePromise = waitForWebSocketClose(orphanWs);
      await bridgeServer.stop();

      const activeCloseEvent = await activeClosePromise;
      expect([1000, 1001]).toContain(activeCloseEvent.code);
      expect(activeCloseEvent.reason).toBe("server stopping");

      const orphanCloseEvent = await orphanClosePromise;
      expect([1000, 1001]).toContain(orphanCloseEvent.code);
      expect(orphanCloseEvent.reason).toBe("server stopping");

      hangingConnect.reject(new Error("stop test cleanup"));
      await bridgeServer.stop();
    } finally {
      hangingConnect.reject(new Error("stop test cleanup"));
      connectToVncSpy.mockRestore();
      if (activeWs && activeWs.readyState !== WebSocket.CLOSED) {
        await closeWebSocket(activeWs);
      }
      if (orphanWs && orphanWs.readyState !== WebSocket.CLOSED) {
        await closeWebSocket(orphanWs);
      }
      await upgradeHarness.close();
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });

  test("ignores text frames without breaking later binary traffic", async () => {
    const tcpHarness = await listenTcpServer();
    const bridgeServer = createBridgeServer({
      validate: mock(() => ({ workspaceId: VALID_WORKSPACE_ID, sessionId: VALID_SESSION_ID })),
      getLiveSessionConnection: mock(() => ({
        sessionId: VALID_SESSION_ID,
        vncPort: tcpHarness.port,
      })),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      await waitForWebSocketOpen(ws);

      const tcpSocket = await tcpHarness.connectionPromise;
      ws.send("ignored text frame");
      expect(await waitForTcpData(tcpSocket, 200)).toBeNull();

      ws.send(Buffer.from([0xde, 0xad]));
      expect(await waitForTcpData(tcpSocket)).toEqual(Buffer.from([0xde, 0xad]));
    } finally {
      if (ws) {
        await closeWebSocket(ws);
      }
      await upgradeHarness.close();
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });
});
