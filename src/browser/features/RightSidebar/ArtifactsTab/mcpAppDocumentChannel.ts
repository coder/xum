import assert from "@/common/utils/assert";
import { createBridgeRateLimiter } from "./artifactBridge";

/**
 * The host channel of one MCP App view document (#6187).
 *
 * SECURITY AUDIT: a page the frame navigates to keeps the frame's window, so a gate on
 * `event.source` alone accepts it, and in browser mode nothing blocks the navigation (the
 * desktop app does: subframeNavigation.ts). Messages sent around the navigation are not ordered
 * either: across processes the next page can post before an unload message of the old document
 * arrives. So the host does not talk to the frame's window at all. The view document's preamble
 * creates a MessageChannel and hands one port to the host in its open announcement, before any
 * view script runs. Host and view talk only over that port. The port stays with the document:
 * a page the frame navigates to gets a fresh window object and cannot reach it, and a host
 * message posted after the navigation goes to the old document's port, never to the new page.
 *
 * The preamble makes that port the view's `window.parent`, so views written for the plain
 * window channel keep working: `parent.postMessage(message, "*")` goes over the port, and the
 * host's messages arrive as `message` events whose `source` is `window.parent` (the check the
 * MCP Apps SDK's PostMessageTransport makes). A view that posts to `window.top` instead reaches
 * no host.
 *
 * The open announcement carries the host's per-document nonce: an earlier document of the same
 * frame (replaced by a new grant) cannot bind the new document's channel, and only the first
 * open binds it. A view that hands its port to another page gains nothing it did not have.
 */

/** Key of the preamble's document announcements (never a JSON-RPC message). */
const MCP_APP_DOCUMENT_MARKER = "xumMcpAppDocument";

/** A fresh nonce for one view document. getRandomValues also works outside secure contexts. */
export function newMcpAppDocumentNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Preamble part (mcpAppPreambleScript) that opens the document's channel. It runs before any
 * view script, so no view script holds the real parent window or a listener ahead of it. A
 * `pagehide` (the document unloads: it navigated away) is announced over the port, so the host
 * can close the frame early. That is cleanup only: the port already keeps the next page out.
 */
export function mcpAppDocumentChannelScript(nonce: string): string {
  assert(/^[0-9a-f]+$/.test(nonce), "MCP App document nonce must be hex");
  return `(function () {
    var host = window.parent;
    var MessageEventCtor = window.MessageEvent;
    var dispatch = window.dispatchEvent.bind(window);
    var channel = new MessageChannel();
    var port = channel.port1;
    var send = port.postMessage.bind(port);
    // The view calls parent.postMessage(message, "*"): a MessagePort takes no target origin.
    port.postMessage = function (message) { send(message); };
    port.onmessage = function (event) {
      dispatch(new MessageEventCtor("message", { data: event.data, source: port }));
    };
    window.addEventListener("pagehide", function () {
      send({ ${MCP_APP_DOCUMENT_MARKER}: 1, type: "leave" });
    }, true);
    Object.defineProperty(window, "parent", { value: port, configurable: true, writable: true });
    host.postMessage({ ${MCP_APP_DOCUMENT_MARKER}: 1, type: "open", nonce: "${nonce}" }, "*", [channel.port2]);
  })();`;
}

function isAnnouncement(data: unknown, type: "open" | "leave"): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    MCP_APP_DOCUMENT_MARKER in data &&
    (data as { type?: unknown }).type === type
  );
}

export interface McpAppDocumentReceiver {
  message: (data: unknown) => void;
  /** The document unloaded (it navigated away). */
  leave: () => void;
}

export interface McpAppDocumentChannel {
  /**
   * A `message` event the frame's window sent to the app window: binds the channel when it is
   * this document's first open announcement. Returns whether it bound the channel.
   */
  acceptOpen: (event: Pick<MessageEvent, "data" | "ports">) => boolean;
  /** Who gets the document's messages; null drops them (no host is mounted). */
  setReceiver: (receiver: McpAppDocumentReceiver | null) => void;
  /** To the document only; dropped before it opened and after close. */
  post: (message: unknown) => void;
  close: () => void;
}

/**
 * The host side for the document built with `nonce`. Lives as long as that document is in the
 * frame, across host rebuilds (the document announces itself once). Rate limited per document,
 * so a burst of an earlier document cannot drop this one's messages.
 */
export function createMcpAppDocumentChannel(nonce: string): McpAppDocumentChannel {
  let port: MessagePort | null = null;
  let closed = false;
  let receiver: McpAppDocumentReceiver | null = null;
  const allowMessage = createBridgeRateLimiter();
  const receive = (data: unknown) => {
    if (closed || receiver == null || !allowMessage()) return;
    if (isAnnouncement(data, "leave")) receiver.leave();
    else receiver.message(data);
  };
  return {
    acceptOpen: (event) => {
      if (port != null || closed || !isAnnouncement(event.data, "open")) return false;
      if ((event.data as { nonce?: unknown }).nonce !== nonce || event.ports.length !== 1) {
        return false;
      }
      port = event.ports[0];
      port.onmessage = (message) => receive(message.data);
      return true;
    },
    setReceiver: (next) => {
      receiver = next;
    },
    post: (message) => {
      if (!closed) port?.postMessage(message);
    },
    close: () => {
      closed = true;
      port?.close();
    },
  };
}
