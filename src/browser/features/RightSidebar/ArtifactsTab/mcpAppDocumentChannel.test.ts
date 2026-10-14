import { describe, expect, test } from "bun:test";
import { createMcpAppDocumentChannel, mcpAppDocumentChannelScript } from "./mcpAppDocumentChannel";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Run the preamble part in a stand-in document window; returns that document's view side. */
/** The app window as the preamble sees it: postMessage(data, targetOrigin, transfer). */
interface HostWindow {
  postMessage: (data: unknown, origin: unknown, ports?: MessagePort[]) => unknown;
}

function openDocument(nonce: string, hostWindow: HostWindow) {
  const events: unknown[] = [];
  const listeners = new Map<string, () => void>();
  const documentWindow: Record<string, unknown> = {
    parent: hostWindow,
    MessageEvent: class {
      constructor(
        readonly type: string,
        readonly init: { data: unknown; source: unknown }
      ) {}
    },
    dispatchEvent: (event: { init: { data: unknown; source: unknown } }) => {
      events.push(event.init);
      return true;
    },
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs our own generated script
  (new Function("window", mcpAppDocumentChannelScript(nonce)) as (w: unknown) => void)(
    documentWindow
  );
  const parent = documentWindow.parent as {
    postMessage: (message: unknown, origin: string) => void;
  };
  return { parent, events, hide: () => listeners.get("pagehide")?.() };
}

/** A host window that hands each announcement to `channel` like McpAppFrame does. */
function hostFor(channel: ReturnType<typeof createMcpAppDocumentChannel>): HostWindow {
  return {
    postMessage: (data: unknown, _origin: unknown, ports: MessagePort[] = []) =>
      channel.acceptOpen({ data, ports }),
  };
}

describe("MCP App document channel", () => {
  test("view and host talk only over the port of the document that opened it", async () => {
    const channel = createMcpAppDocumentChannel("ab12");
    const received: unknown[] = [];
    channel.setReceiver({ message: (data) => received.push(data), leave: () => undefined });
    const view = openDocument("ab12", hostFor(channel));

    view.parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ping" }, "*");
    channel.post({ jsonrpc: "2.0", id: 1, result: {} });
    await tick();
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    // The host's message arrives from window.parent, the source the MCP Apps SDK checks.
    expect(view.events).toEqual([
      { data: { jsonrpc: "2.0", id: 1, result: {} }, source: view.parent },
    ]);
  });

  test("only the first open with the document's nonce binds the channel", async () => {
    const channel = createMcpAppDocumentChannel("ab12");
    const received: unknown[] = [];
    channel.setReceiver({ message: (data) => received.push(data), leave: () => undefined });
    const host = hostFor(channel);
    // An earlier document of the frame does not know this document's nonce.
    const earlier = openDocument("cd34", host);
    const view = openDocument("ab12", host);
    // A page the view navigated to cannot rebind it, even with the nonce.
    const next = openDocument("ab12", host);

    for (const page of [earlier, view, next]) {
      page.parent.postMessage(
        { jsonrpc: "2.0", method: "from", params: { page: page === view } },
        "*"
      );
    }
    channel.post({ jsonrpc: "2.0", method: "to-view" });
    await tick();
    expect(received).toEqual([{ jsonrpc: "2.0", method: "from", params: { page: true } }]);
    expect(earlier.events).toEqual([]);
    expect(next.events).toEqual([]);
  });

  test("an unloading document closes its frame; a closed channel carries nothing", async () => {
    const channel = createMcpAppDocumentChannel("ab12");
    const received: unknown[] = [];
    let left = 0;
    channel.setReceiver({ message: (data) => received.push(data), leave: () => left++ });
    const view = openDocument("ab12", hostFor(channel));

    view.hide();
    await tick();
    expect(left).toBe(1);

    channel.close();
    view.parent.postMessage({ jsonrpc: "2.0", id: 2, method: "ping" }, "*");
    channel.post({ jsonrpc: "2.0", method: "late" });
    await tick();
    expect(received).toEqual([]);
    expect(view.events).toEqual([]);
  });
});
