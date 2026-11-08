// Test harness: run a sandboxed frame's document (an HTML artifact or an MCP App view) from the
// srcdoc the host built, so tests drive the real bridge script instead of forging its messages.
import { act } from "@testing-library/react";
import { Window as HappyWindow } from "happy-dom";
import assert from "@/common/utils/assert";

/** What the document's script sees as `window.parent`. */
export interface FrameParent {
  postMessage: (data: unknown, targetOrigin: string, transfer?: MessagePort[]) => void;
}

/** One document run from a frame's srcdoc, in its own happy-dom window. */
export interface FrameDocument {
  /** The document's window: the bridge put `window.xum` on it, the MCP preamble its parent. */
  win: HappyWindow & { xum?: ArtifactBridgeApi };
  /** Fire a window event (pagehide) in the document. */
  dispatch: (type: string) => void;
  /** Send `data` over the document's own port, as its script does, and wait for delivery. */
  post: (data: unknown) => Promise<void>;
  /** Every message the host sent over the document's port, its checks included. */
  received: unknown[];
  /**
   * The document goes away without a word: its port goes silent both ways, so it answers no
   * check (a renderer that died, or a leave the artifact's own code blocked, then navigated).
   */
  kill: () => void;
}

/** `window.xum`, as the artifact's own code calls it. */
interface ArtifactBridgeApi {
  send: (text: string, data?: unknown) => void;
  setState: (state: unknown) => void;
  openWorkspace: (workspaceId: string) => void;
}

/** The srcdoc's first script: the artifact bridge, or the MCP App view preamble. */
function firstScriptOf(srcdoc: string): string {
  const parsed = new window.DOMParser().parseFromString(srcdoc, "text/html");
  const script = parsed.querySelector("script")?.textContent;
  assert(script != null && script.length > 0, "the srcdoc has no script");
  return script;
}

/** Two macrotask turns: a port message, and the host's answer to it, are delivered. */
export async function deliverFrameMessages(): Promise<void> {
  // setImmediate, not setTimeout: fake timers leave it real (testFakeClock.ts).
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

/**
 * Run `script` as the first script of a fresh document whose parent window is `parent`. Its
 * window is a happy-dom window of its own, so the script's listeners and globals stay off the
 * app window. The globals the frame scripts use are that window's, as in a real frame, except
 * MessageChannel (happy-dom has none): the runtime's, so the host gets a real port.
 */
export function runFrameDocument(script: string, parent: FrameParent): FrameDocument {
  const win = new HappyWindow({ url: "about:srcdoc" }) as FrameDocument["win"];
  Object.defineProperty(win, "parent", { value: parent, configurable: true, writable: true });
  const channels: MessageChannel[] = [];
  class DocumentMessageChannel extends MessageChannel {
    constructor() {
      super();
      channels.push(this);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the host's own frame script
  const run = new Function(
    "window",
    "document",
    "CustomEvent",
    "MessageChannel",
    "EventTarget",
    "Document",
    script
  ) as (...globals: unknown[]) => void;
  run(win, win.document, win.CustomEvent, DocumentMessageChannel, win.EventTarget, win.Document);
  const port = channels[0]?.port1;
  const received: unknown[] = [];
  port?.addEventListener("message", (event) => received.push(event.data));
  return {
    win,
    dispatch: (type) => {
      act(() => {
        win.dispatchEvent(new win.Event(type));
      });
    },
    post: async (data) => {
      assert(port != null, "the document opened no channel");
      port.postMessage(data);
      await deliverFrameMessages();
    },
    received,
    kill: () => port?.close(),
  };
}

/**
 * Post from the frame's window to the app window: what the frame's current document can do,
 * whichever document that is (one the frame navigated to included).
 */
export function postFromFrameWindow(
  frame: HTMLIFrameElement,
  data: unknown,
  ports: readonly MessagePort[] = []
): void {
  const event = new window.Event("message");
  Object.defineProperty(event, "data", { value: data });
  Object.defineProperty(event, "source", { value: frame.contentWindow });
  Object.defineProperty(event, "ports", { value: ports });
  act(() => {
    window.dispatchEvent(event);
  });
}

const bootedDocuments = new WeakMap<HTMLIFrameElement, { srcdoc: string; doc: FrameDocument }>();

/** Run the document the frame's srcdoc holds, as the frame would load it. */
export function bootFrameDocument(frame: HTMLIFrameElement): FrameDocument {
  const srcdoc = frame.getAttribute("srcdoc");
  assert(srcdoc != null, "the frame has no srcdoc");
  const doc = runFrameDocument(firstScriptOf(srcdoc), {
    postMessage: (data, _targetOrigin, transfer = []) => postFromFrameWindow(frame, data, transfer),
  });
  bootedDocuments.set(frame, { srcdoc, doc });
  return doc;
}

/** The document the frame holds: the one booted from its current srcdoc, booted if need be. */
export function frameDocumentOf(frame: HTMLIFrameElement): FrameDocument {
  const booted = bootedDocuments.get(frame);
  return booted?.srcdoc === frame.getAttribute("srcdoc") ? booted.doc : bootFrameDocument(frame);
}

/** Deliver a bridge message as the frame's document sends it: over its own port. */
export function postFromFrameDocument(frame: HTMLIFrameElement, data: unknown): Promise<void> {
  return frameDocumentOf(frame).post(data);
}

/** A port end that delivers to its peer at once (SyncMessageChannel). */
class SyncMessagePort {
  peer: SyncMessagePort | null = null;
  closed = false;
  private readonly listeners: Array<(event: { data: unknown }) => void> = [];
  postMessage(data: unknown) {
    const peer = this.peer;
    if (this.closed || peer == null || peer.closed) return;
    for (const listener of peer.listeners) listener({ data });
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    if (type === "message") this.listeners.push(listener);
  }
  start() {
    // Delivery starts at once: nothing to start.
  }
  close() {
    this.closed = true;
  }
}

class SyncMessageChannel {
  readonly port1 = new SyncMessagePort();
  readonly port2 = new SyncMessagePort();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

/** The page's window, document and CustomEvent a frame script runs with in runFrameScript. */
export interface FrameScriptGlobals {
  window: object;
  document: unknown;
  CustomEvent: unknown;
  /** The window's EventTarget and Document classes; stand-ins for a plain object window. */
  EventTarget?: unknown;
  Document?: unknown;
}

/**
 * Run a frame script (the artifact bridge, or the MCP preamble) against `globals`, for unit
 * tests of the script itself. Its document channel's ports deliver at once, so a test reads what
 * the script sent right after the event that sent it. `posted` holds what it sent the host over
 * its port (answers to checks included), `windowPosts` what it posted to its parent window, and
 * `toFrame` sends it a host message over the port.
 */
export function runFrameScript(script: string, globals: FrameScriptGlobals) {
  const windowPosts: Array<{ data: unknown; ports: unknown[] }> = [];
  const parent = {
    postMessage: (data: unknown, _targetOrigin: string, ports: unknown[] = []) =>
      windowPosts.push({ data, ports }),
  };
  Object.defineProperty(globals.window, "parent", {
    value: parent,
    configurable: true,
    writable: true,
  });
  const channels: SyncMessageChannel[] = [];
  class Channel extends SyncMessageChannel {
    constructor() {
      super();
      channels.push(this);
    }
  }
  // A plain object window has no EventTarget: forward to its own addEventListener.
  const eventTarget = globals.EventTarget ?? {
    prototype: {
      addEventListener(
        this: { addEventListener: (...args: unknown[]) => void },
        ...args: unknown[]
      ) {
        this.addEventListener(...args);
      },
    },
  };
  // A fresh class per run: the script wraps its prototype's open, write and writeln.
  const documentClass =
    globals.Document ??
    class {
      open() {
        // A plain object window has no document state to reset.
      }
      write() {
        // Nothing to parse.
      }
      writeln() {
        // Nothing to parse.
      }
    };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the host's own frame script
  const run = new Function(
    "window",
    "document",
    "CustomEvent",
    "MessageChannel",
    "EventTarget",
    "Document",
    script
  ) as (...args: unknown[]) => void;
  run(globals.window, globals.document, globals.CustomEvent, Channel, eventTarget, documentClass);
  const host = channels[0]?.port2;
  const posted: unknown[] = [];
  host?.addEventListener("message", (event) => posted.push(event.data));
  return {
    posted,
    windowPosts,
    toFrame: (data: unknown) => {
      assert(host != null, "the script opened no channel");
      host.postMessage(data);
    },
  };
}
