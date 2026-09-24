import "../../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";
import * as RealAPIModule from "@/browser/contexts/API";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

const getBootstrapMock = mock(() =>
  Promise.resolve({
    bridgePath: "/browser/ws",
    token: "token-1",
    localBridgeBaseUrl: "http://localhost:8123",
  })
);

// Later full-app suites must not inherit this partial API client.
restoreModulesAfterSuite([["@/browser/contexts/API", { ...RealAPIModule }]]);
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      browser: {
        getBootstrap: getBootstrapMock,
      },
    },
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import type { useBrowserBridgeConnection as UseBrowserBridgeConnection } from "./useBrowserBridgeConnection";
import { useBrowserBridgeConnection as untypedUseBrowserBridgeConnection } from "./useBrowserBridgeConnection.ts?test-isolation=static";

const useBrowserBridgeConnection =
  untypedUseBrowserBridgeConnection as unknown as typeof UseBrowserBridgeConnection;

interface FakeWebSocketEvent {
  data?: string;
  code?: number;
  reason?: string;
}

type FakeWebSocketListener = (event: FakeWebSocketEvent) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly send = mock();
  private readonly listeners = new Map<string, Set<FakeWebSocketListener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: FakeWebSocketListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeWebSocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string, event: FakeWebSocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code: 1000, reason: "" });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  emitMessage(payload: unknown) {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }

  emitClose(code: number, reason: string) {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code, reason });
  }
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function connectHook() {
  const result = renderHook(() => useBrowserBridgeConnection("workspace-1"));

  act(() => {
    result.result.current.connect("session-a");
  });
  await flushAsyncWork();

  const socket = FakeWebSocket.instances.at(-1);
  expect(socket).toBeDefined();
  return { result: result.result, socket: socket! };
}

describe("useBrowserBridgeConnection", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalWebSocket = globalThis.WebSocket;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;
    window.WebSocket = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    getBootstrapMock.mockReset();
    getBootstrapMock.mockResolvedValue({
      bridgePath: "/browser/ws",
      token: "token-1",
      localBridgeBaseUrl: "http://localhost:8123",
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.WebSocket = originalWebSocket;
  });

  test("bootstraps the mux bridge and surfaces live frame state", async () => {
    const { result, socket } = await connectHook();

    expect(getBootstrapMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionName: "session-a",
    });
    expect(socket.url).toBe("ws://localhost/browser/ws?token=token-1");

    act(() => {
      socket.open();
      socket.emitMessage({
        type: "frame",
        data: "abc123",
        metadata: {
          deviceWidth: 1280,
          deviceHeight: 720,
          pageScaleFactor: 1,
          offsetTop: 0,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
      });
    });
    await flushAsyncWork();

    expect(result.current.session?.status).toBe("live");
    expect(result.current.session?.sessionName).toBe("session-a");
    expect(result.current.session?.frameBase64).toBe("abc123");
    expect(result.current.session?.frameMetadata?.deviceWidth).toBe(1280);
  });

  test("passes explicit other-workspace scope to browser bootstrap", async () => {
    const result = renderHook(() => useBrowserBridgeConnection("workspace-1"));

    act(() => {
      result.result.current.connect("session-a", { allowOtherWorkspaceSession: true });
    });
    await flushAsyncWork();

    expect(getBootstrapMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionName: "session-a",
      allowOtherWorkspaceSession: true,
    });
  });

  test("initializes new sessions with page state defaults", async () => {
    const { result } = await connectHook();

    expect(result.current.session).not.toBeNull();
    expect(result.current.session?.currentUrl).toBeNull();
    expect(result.current.session?.isPageLoading).toBe(false);
    expect(result.current.session?.pendingUrl).toBeNull();
  });

  test("updates currentUrl and isPageLoading from page_state messages", async () => {
    const { result, socket } = await connectHook();

    act(() => {
      socket.emitMessage({
        type: "page_state",
        url: "https://example.com",
        isLoading: true,
        source: "poll",
      });
    });
    await flushAsyncWork();

    expect(result.current.session?.currentUrl).toBe("https://example.com");
    expect(result.current.session?.isPageLoading).toBe(true);
  });

  test("clears pendingUrl after the confirmed page_state finishes loading", async () => {
    const { result, socket } = await connectHook();

    act(() => {
      result.current.setPendingUrl("https://example.com/next");
    });

    expect(result.current.session?.pendingUrl).toBe("https://example.com/next");

    act(() => {
      socket.emitMessage({
        type: "page_state",
        url: "https://example.com/next",
        isLoading: false,
        source: "command",
      });
    });
    await flushAsyncWork();

    expect(result.current.session?.currentUrl).toBe("https://example.com/next");
    expect(result.current.session?.isPageLoading).toBe(false);
    expect(result.current.session?.pendingUrl).toBeNull();
  });

  test("preserves pendingUrl while a different page_state is still loading", async () => {
    const { result, socket } = await connectHook();

    act(() => {
      result.current.setPendingUrl("https://next.example.com");
    });

    act(() => {
      socket.emitMessage({
        type: "page_state",
        url: "https://current.example.com",
        isLoading: true,
        source: "poll",
      });
    });
    await flushAsyncWork();

    expect(result.current.session?.currentUrl).toBe("https://current.example.com");
    expect(result.current.session?.isPageLoading).toBe(true);
    expect(result.current.session?.pendingUrl).toBe("https://next.example.com");
  });

  test("setPendingUrl stores an optimistic navigation target", async () => {
    const { result } = await connectHook();

    act(() => {
      result.current.setPendingUrl("https://pending.example.com");
    });

    expect(result.current.session?.pendingUrl).toBe("https://pending.example.com");
  });

  test("disconnect resets the local session state", async () => {
    const { result } = await connectHook();

    act(() => {
      result.current.disconnect();
    });
    await flushAsyncWork();

    expect(result.current.session).toBeNull();
  });

  test("surfaces close errors from the bridged socket", async () => {
    const { result, socket } = await connectHook();

    act(() => {
      socket.emitClose(1011, "bridge exploded");
    });
    await flushAsyncWork();

    expect(result.current.session?.status).toBe("error");
    expect(result.current.session?.lastError).toBe("bridge exploded");
  });
});
