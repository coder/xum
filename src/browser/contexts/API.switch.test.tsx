import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { isConnectionLostError } from "./connectionLink";
import type { APIProvider as APIProviderType, UseAPIResult } from "./API";

// Other suites mock this module (and bun module mocks leak between files): the query string
// gives the real one. This suite also runs the real oRPC client and WebSocket link.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const RealAPIModule: {
  APIProvider: typeof APIProviderType;
  useAPI: () => UseAPIResult;
} = require("./API?real=switch");
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const { APIProvider, useAPI } = RealAPIModule;

/**
 * One fake socket per connect, wired to a real oRPC server handler in this process. Server N
 * answers ping(x) with `N:x`, so a test can see which socket served a call.
 */
class ServerSocket {
  static all: ServerSocket[] = [];
  readyState = 0; // CONNECTING
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  private readonly server: { send: (data: string | Uint8Array<ArrayBuffer>) => void };
  private readonly handler: RPCHandler<Record<never, never>>;
  /** While set, the server does not answer pings (a stalled backend). */
  hold = false;

  constructor(readonly id: number) {
    ServerSocket.all.push(this);
    const router = {
      general: {
        ping: os.handler(async ({ input }) => {
          while (this.hold) await new Promise((resolve) => setTimeout(resolve, 5));
          return `${id}:${String(input)}`;
        }),
      },
    };
    this.handler = new RPCHandler(router);
    this.server = {
      send: (data) => setTimeout(() => this.emit("message", { data }), 0),
    };
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
    );
  }
  send(data: string) {
    setTimeout(() => void this.handler.message(this.server, data), 0);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
  /** The socket dies; 1006 is an abnormal closure without a close frame. */
  drop(code = 1006) {
    this.readyState = 3;
    this.emit("close", { code });
  }
  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const createWebSocket = () => new ServerSocket(ServerSocket.all.length + 1) as unknown as WebSocket;

let states: UseAPIResult[] = [];
function Observer() {
  states.push(useAPI());
  return null;
}

async function connectSocket(socket: ServerSocket | undefined) {
  expect(socket).toBeDefined();
  await act(async () => {
    socket!.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await waitFor(() => expect(states.at(-1)?.status).toBe("connected"));
  return states.at(-1)!.api!;
}

describe("APIProvider keeps the last client while it reconnects", () => {
  beforeEach(() => {
    saveDomGlobals();
    const happyWindow = new GlobalWindow({ url: "https://xum.example.com/" });
    globalThis.window = happyWindow as unknown as Window & typeof globalThis;
    globalThis.document = happyWindow.document as unknown as Document;
    ServerSocket.all = [];
    states = [];
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("the client stays while reconnecting, fails fast, then reaches the new socket", async () => {
    render(
      <APIProvider createWebSocket={createWebSocket}>
        <Observer />
      </APIProvider>
    );
    // Before the first connect there is no client.
    expect(states.at(-1)?.api).toBeNull();
    const first = await connectSocket(ServerSocket.all[0]);
    expect(await first.general.ping("a")).toBe("1:a");

    act(() => ServerSocket.all[0].drop());
    expect(states.at(-1)?.status).toBe("reconnecting");
    expect(states.at(-1)?.api).toBe(first);
    // Offline, a call fails within one macrotask instead of hanging.
    let offline: unknown = "pending";
    void first.general.ping("b").catch((error: unknown) => (offline = error));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isConnectionLostError(offline)).toBe(true);

    await waitFor(() => expect(ServerSocket.all).toHaveLength(2));
    const second = await connectSocket(ServerSocket.all[1]);
    // A new object, so effects with the client in their deps run again.
    expect(second).not.toBe(first);
    // A handler or ref that kept the old client reaches the new socket.
    expect(await first.general.ping("c")).toBe("2:c");
  });

  test("retry() rejects pending calls at once, before any close event", async () => {
    render(
      <APIProvider createWebSocket={createWebSocket}>
        <Observer />
      </APIProvider>
    );
    const first = await connectSocket(ServerSocket.all[0]);
    ServerSocket.all[0].hold = true;
    let pending: unknown = "pending";
    void first.general.ping("slow").catch((error: unknown) => (pending = error));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pending).toBe("pending");

    act(() => states.at(-1)!.retry());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isConnectionLostError(pending)).toBe(true);
    // The old socket never fired close, and the next one is still handshaking.
    expect(states.at(-1)?.status).toBe("reconnecting");
    expect(states.at(-1)?.api).toBe(first);
  });

  test("a session that needs a new token drops the last client", async () => {
    render(
      <APIProvider createWebSocket={createWebSocket}>
        <Observer />
      </APIProvider>
    );
    await connectSocket(ServerSocket.all[0]);
    act(() => ServerSocket.all[0].drop(4401));
    await waitFor(() => expect(states.at(-1)?.status).toBe("auth_required"));
    expect(states.at(-1)?.api).toBeNull();
  });
});
