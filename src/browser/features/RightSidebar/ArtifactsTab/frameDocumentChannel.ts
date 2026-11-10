import { useLayoutEffect, useRef } from "react";
import {
  FRAME_DOCUMENT_CHECK_CAP_MS,
  FRAME_DOCUMENT_CHECK_DEADLINE_MS,
  FRAME_DOCUMENT_CHECK_LATE_MS,
  FRAME_DOCUMENT_HEARTBEAT_MS,
} from "@/common/constants/artifactInteractions";
import assert from "@/common/utils/assert";

/**
 * The host channel of one sandboxed frame document: an HTML or SVG artifact
 * (SandboxedArtifactFrame.tsx, its bridge in artifactBridge.ts) or an MCP App view
 * (McpAppFrame.tsx, #6187).
 *
 * SECURITY AUDIT: a page the frame navigates to keeps the frame's window, so a gate on
 * `event.source` alone accepts it, and in browser mode nothing blocks the navigation (the
 * desktop app does: subframeNavigation.ts). Messages sent around the navigation are not ordered
 * either: across processes the next page can post before an unload message of the old document
 * arrives. So the host does not talk to the frame's window at all. The document's first script
 * (frameDocumentScript) creates a MessageChannel and hands one port to the host in its open
 * announcement, before any artifact or view script runs. Host and document talk only over that
 * port. The port stays with the document: a page the frame navigates to gets a fresh window
 * object and cannot reach it, and a host message posted after the navigation goes to the old
 * document's port, never to the new page.
 *
 * The open announcement carries the host's per-document nonce: an earlier document of the same
 * frame (replaced by new content or a new grant) cannot bind the new document's channel, and
 * only the first open binds it. A document that hands its port to another page gains nothing it
 * did not have.
 *
 * `check` asks the bound document to answer over its port, which only that document can do. The
 * navigation guard sends one at every load of the frame (frameNavigationGuard.tsx), so a frame
 * that holds another document closes without any help from code running in it.
 */

/** Key of the document-side announcements and checks (never a bridge or JSON-RPC message). */
const FRAME_DOCUMENT_MARKER = "xumFrameDocument";

/** Messages above this rate (per frame document, per second) are dropped unparsed. */
export const ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND = 20;

/**
 * Fixed-window limiter: allows `maxPerWindow` calls per `windowMs`. Every message from the
 * frame counts, valid or not, so a flood of junk cannot keep the parser busy.
 */
export function createBridgeRateLimiter(
  maxPerWindow = ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND,
  windowMs = 1000,
  now: () => number = Date.now
): () => boolean {
  let windowStart = now();
  let count = 0;
  return () => {
    const current = now();
    if (current - windowStart >= windowMs) {
      windowStart = current;
      count = 0;
    }
    count += 1;
    return count <= maxPerWindow;
  };
}

/** A fresh random hex value (a document nonce, a check value). Works outside secure contexts. */
export function newFrameDocumentNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Frame script (a statement, run first in the artifact bridge and the MCP App preamble, right
 * after the WebRTC removal) that opens the document's channel. No artifact or view script has
 * run yet, so none holds the real parent window, the port, or a listener ahead of these.
 *
 * It declares `frameDocument`, `{ port, send }`, where `send` is the port's own postMessage.
 * The port's listener answers the host's checks itself and hands every other host message to
 * `onHostMessage` (a function expression), so a check never reaches artifact or view code. It
 * uses addEventListener, so a view that sets `onmessage` on its port (its `window.parent`)
 * does not remove it.
 *
 * `pagehide` (the document unloads) sends `leave`, so the host can close the frame at once.
 * `document.open()` erases the window's listeners, so `Document.prototype` `open`, `write` and
 * `writeln` add the listener again after each call, through EventTarget's addEventListener as
 * it was before any artifact script ran. This is a fast path, not a security control: artifact
 * code can still keep it from running (a capturing pagehide listener that stops propagation), and
 * then the host's unanswered check closes the frame.
 */
export function frameDocumentScript(nonce: string, onHostMessage: string): string {
  assert(/^[0-9a-f]+$/.test(nonce), "frame document nonce must be hex");
  return `var frameDocument = (function (onHostMessage) {
    var documentParent = window.parent;
    var channel = new MessageChannel();
    var port = channel.port1;
    var send = port.postMessage.bind(port);
    var addListener = EventTarget.prototype.addEventListener;
    port.addEventListener("message", function (event) {
      var data = event.data;
      if (data && typeof data === "object" && data.${FRAME_DOCUMENT_MARKER} === 1 && data.type === "check") {
        send({ ${FRAME_DOCUMENT_MARKER}: 1, type: "checked", value: data.value });
      } else {
        onHostMessage(data);
      }
    });
    port.start();
    function announceLeave() {
      send({ ${FRAME_DOCUMENT_MARKER}: 1, type: "leave" });
    }
    function listenForLeave() {
      addListener.call(window, "pagehide", announceLeave, true);
    }
    listenForLeave();
    ["open", "write", "writeln"].forEach(function (name) {
      var original = Document.prototype[name];
      if (typeof original !== "function") return;
      Document.prototype[name] = function () {
        try {
          return original.apply(this, arguments);
        } finally {
          listenForLeave();
        }
      };
    });
    documentParent.postMessage({ ${FRAME_DOCUMENT_MARKER}: 1, type: "open", nonce: "${nonce}" }, "*", [channel.port2]);
    return { port: port, send: send };
  })(${onHostMessage});`;
}

/**
 * Preamble part (mcpAppPreambleScript) that opens an MCP App view's channel
 * (frameDocumentScript) and makes its port the view's `window.parent`, so views written for the
 * plain window channel keep working: `parent.postMessage(message, "*")` goes over the port, and
 * the host's messages arrive as `message` events whose `source` is `window.parent` (the check
 * the MCP Apps SDK's PostMessageTransport makes). A view that posts to `window.top` instead
 * reaches no host.
 *
 * Escape, or Shift+F outside a text field, that the view did not handle (no preventDefault,
 * read once every listener ran) is announced as `exit`:
 * keys inside the frame never reach the app, and a maximized app tab (#6165) restores on it.
 * The view's script can post `exit` without a key press too, so the host only ever restores on
 * it, never maximizes.
 */
export function mcpAppDocumentChannelScript(nonce: string): string {
  return `(function () {
    var MessageEventCtor = window.MessageEvent;
    var dispatch = window.dispatchEvent.bind(window);
    ${frameDocumentScript(
      nonce,
      `function (data) { dispatch(new MessageEventCtor("message", { data: data, source: frameDocument.port })); }`
    )}
    var port = frameDocument.port;
    var send = frameDocument.send;
    // The view calls parent.postMessage(message, "*"): a MessagePort takes no target origin.
    port.postMessage = function (message) { send(message); };
    window.addEventListener("keydown", function (event) {
      // The innermost target: an input inside an open shadow root retargets event.target to
      // its host element.
      var target = typeof event.composedPath === "function" ? event.composedPath()[0] || event.target : event.target;
      var editable = !!target && target.nodeType === 1 && (target.isContentEditable ||
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      var plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      var exit = event.key === "Escape" || (plain && event.shiftKey && !editable &&
        (event.key === "F" || event.key === "f"));
      if (!exit) return;
      // After the view's own listeners (also window-level ones added later): setTimeout reads
      // the event's final defaultPrevented, as the Artifacts bridge does. Not a timing guess.
      window.setTimeout(function () {
        if (!event.defaultPrevented) send({ ${FRAME_DOCUMENT_MARKER}: 1, type: "exit" });
      }, 0);
    });
    Object.defineProperty(window, "parent", { value: port, configurable: true, writable: true });
  })();`;
}

type Announcement = "leave" | "exit" | "checked";

function isAnnouncement(data: unknown, type: "open" | Announcement): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    FRAME_DOCUMENT_MARKER in data &&
    (data as { type?: unknown }).type === type
  );
}

/** Which document-side announcement `data` is, or null for a bridge or view message. */
function announcementOf(data: unknown): Announcement | null {
  const types: Announcement[] = ["leave", "exit", "checked"];
  return types.find((type) => isAnnouncement(data, type)) ?? null;
}

/** The port of `event` when it is the open announcement of the document with `nonce`. */
function openedPort(event: Pick<MessageEvent, "data" | "ports">, nonce: string) {
  if (!isAnnouncement(event.data, "open")) return null;
  const matches = (event.data as { nonce?: unknown }).nonce === nonce;
  return matches && event.ports.length === 1 ? event.ports[0] : null;
}

export interface FrameDocumentReceiver {
  message: (data: unknown) => void;
  /** The document unloaded (it navigated away). */
  leave: () => void;
  /** Escape or Shift+F inside an MCP App view, which the view did not handle. Only restores. */
  exit?: () => void;
}

export interface FrameDocumentChannel {
  /**
   * A `message` event the frame's window sent to the app window: binds the channel when it is
   * this document's first open announcement. Returns whether it bound the channel.
   */
  acceptOpen: (event: Pick<MessageEvent, "data" | "ports">) => boolean;
  /** Who gets the document's messages; null drops them (no host is mounted). */
  setReceiver: (receiver: FrameDocumentReceiver | null) => void;
  /** To the document only; dropped before it opened and after close. */
  post: (message: unknown) => void;
  /**
   * Asks the bound document to answer a fresh value over its port. `onMissed` runs when
   * FRAME_DOCUMENT_CHECK_DEADLINE_MS passes, from the first check no answer has cleared, without
   * an answer to the latest check. A deadline whose window saw the app's thread blocked is
   * extended instead, up to FRAME_DOCUMENT_CHECK_CAP_MS after that first check.
   */
  check: (onMissed: () => void) => void;
  /** Closes the port and stops the deadline. */
  close: () => void;
}

/**
 * The host side for the document built with `nonce`. Lives as long as that document is in the
 * frame, across host rebuilds (the document announces itself once). Rate limited per document,
 * so a burst of an earlier document cannot drop this one's messages.
 */
interface PendingCheck {
  value: string;
  firstSentAt: number;
  dueAt: number;
  timer: ReturnType<typeof setTimeout>;
  blocked: boolean;
  /** When the current deadline window began: a beat due before it belongs to an earlier one. */
  windowStartedAt: number;
  heartbeat: ReturnType<typeof setTimeout>;
}

class DocumentChannel implements FrameDocumentChannel {
  // Bound once by the document's open announcement; the port is never replaced.
  private port: MessagePort | null = null;
  private closed = false;
  private receiver: FrameDocumentReceiver | null = null;
  private readonly allowMessage = createBridgeRateLimiter();
  // The latest check no answer has cleared, when the first of them went out (the cap counts from
  // there), its deadline, and whether the heartbeat saw the app's thread blocked since that
  // deadline was armed. An answer to an older check (sent just before the document died) clears
  // nothing.
  private pending: PendingCheck | null = null;

  constructor(
    private readonly nonce: string,
    /** Monotonic milliseconds: a deadline timer's lateness is measured on it. */
    private readonly now: () => number
  ) {}

  acceptOpen = (event: Pick<MessageEvent, "data" | "ports">): boolean => {
    if (this.port != null || this.closed) return false;
    const opened = openedPort(event, this.nonce);
    if (opened == null) return false;
    this.port = opened;
    opened.onmessage = (message) => this.receive(message.data);
    return true;
  };

  setReceiver = (next: FrameDocumentReceiver | null): void => {
    this.receiver = next;
  };

  post = (message: unknown): void => {
    if (!this.closed) this.port?.postMessage(message);
  };

  check = (onMissed: () => void): void => {
    if (this.closed) return;
    assert(this.port != null, "only a bound frame document channel can check its document");
    const value = newFrameDocumentNonce();
    if (this.pending == null) {
      const sentAt = this.now();
      this.pending = {
        value,
        firstSentAt: sentAt,
        blocked: false,
        windowStartedAt: sentAt,
        heartbeat: this.beatAfter(() => this.pending),
        ...this.armDeadline(sentAt + FRAME_DOCUMENT_CHECK_DEADLINE_MS, onMissed),
      };
    } else {
      // A later load keeps the deadline: a page that reloads itself cannot push it out.
      this.pending.value = value;
    }
    this.port.postMessage({ [FRAME_DOCUMENT_MARKER]: 1, type: "check", value });
  };

  close = (): void => {
    this.closed = true;
    this.port?.close();
    this.clearPending();
  };

  private clearPending(): void {
    if (this.pending == null) return;
    clearTimeout(this.pending.timer);
    clearTimeout(this.pending.heartbeat);
    this.pending = null;
  }

  /**
   * One beat of the heartbeat that runs while a check is pending: a beat that fires more than
   * FRAME_DOCUMENT_CHECK_LATE_MS late marks the pending check's window as blocked.
   */
  private beatAfter(current: () => PendingCheck | null): ReturnType<typeof setTimeout> {
    const dueAt = this.now() + FRAME_DOCUMENT_HEARTBEAT_MS;
    return setTimeout(() => {
      const pending = current();
      // clearPending() stops the heartbeat with its check, so a beat always finds it pending.
      if (pending == null) return;
      // A block across a deadline also holds back a beat that fires after the extension; it marks
      // the window it was due in, not the new one.
      if (dueAt >= pending.windowStartedAt && this.now() - dueAt > FRAME_DOCUMENT_CHECK_LATE_MS) {
        pending.blocked = true;
      }
      pending.heartbeat = this.beatAfter(current);
    }, FRAME_DOCUMENT_HEARTBEAT_MS);
  }

  private armDeadline(dueAt: number, onMissed: () => void) {
    const timer = setTimeout(() => this.deadlinePassed(onMissed), dueAt - this.now());
    return { dueAt, timer };
  }

  /**
   * The pending check's deadline timer fired. If the app's thread ran freely since the deadline
   * was armed, the document missed it: the frame closes.
   *
   * If the thread was blocked meanwhile (the deadline timer, or a beat of the heartbeat, fired
   * more than FRAME_DOCUMENT_CHECK_LATE_MS late), the deadline says nothing about the document.
   * WebKit runs the frame on that thread too. After a 6 s block right after a check, it ran the
   * overdue timer before the document's queued answer. An artifact that runs chained 2.5 s tasks
   * answers two tasks after a check, and its answer reaches the host one task later, so the
   * deadline fired on time at a task boundary with the answer still on its way. In both cases a
   * live artifact closed. So the pending check gets one more deadline, from now, but never later
   * than FRAME_DOCUMENT_CHECK_CAP_MS after its first unanswered check. No fresh check goes out:
   * only an answer to the latest value clears it, as before.
   *
   * SECURITY AUDIT: a page the frame navigated to cannot answer, so this only delays its close. A
   * dead document closes at the first deadline whose window saw no block. A page that keeps the
   * shared thread busy (WebKit, in-process Chromium) makes every window blocked, and stays shown,
   * without the bridge, until the cap passes and its current block ends (24.16 to 24.26 s measured
   * in WebKit with 6 s blocks, against 12.4 s with no extension). It freezes the whole app
   * meanwhile.
   */
  private deadlinePassed(onMissed: () => void): void {
    const pending = this.pending;
    // mutation-equivalent: a firing timer always finds its check pending on an open channel.
    // close() and an answer clear the timer, and an extension replaces only the one that fired.
    if (pending == null || this.closed) return;
    const now = this.now();
    const capAt = pending.firstSentAt + FRAME_DOCUMENT_CHECK_CAP_MS;
    const blocked = pending.blocked || now - pending.dueAt > FRAME_DOCUMENT_CHECK_LATE_MS;
    if (blocked && now < capAt) {
      // The next window asks again: a block it does not see cannot extend it.
      pending.blocked = false;
      pending.windowStartedAt = now;
      Object.assign(
        pending,
        this.armDeadline(Math.min(now + FRAME_DOCUMENT_CHECK_DEADLINE_MS, capAt), onMissed)
      );
      return;
    }
    this.clearPending();
    onMissed();
  }

  private answered(value: unknown): void {
    if (this.pending == null || value !== this.pending.value) return;
    this.clearPending();
  }

  private receive(data: unknown): void {
    if (this.closed) return;
    // Announcements are not rate limited: a burst must neither hide the unload nor leave a check
    // unanswered, and each one can only close, restore or keep the document's own frame.
    const announced = announcementOf(data);
    if (announced === "checked") {
      this.answered((data as { value?: unknown }).value);
      return;
    }
    const receiver = this.receiver;
    if (receiver == null) return;
    if (announced === "leave") receiver.leave();
    else if (announced === "exit") receiver.exit?.();
    else if (this.allowMessage()) receiver.message(data);
  }
}

export function createFrameDocumentChannel(
  nonce: string,
  now: () => number = () => performance.now()
): FrameDocumentChannel {
  return new DocumentChannel(nonce, now);
}

/**
 * The app window's `message` listener that opens `channel`. SECURITY: only an event whose source
 * is the frame's current window (`frameWindow`, null once the frame left its document) may bind
 * it, and only its first open announcement with the document's nonce does. `onOpened` runs when
 * it bound the channel.
 */
export function frameDocumentOpenListener(
  channel: FrameDocumentChannel,
  frameWindow: () => Window | null | undefined,
  onOpened: (channel: FrameDocumentChannel) => void
): (event: MessageEvent) => void {
  return (event) => {
    const source = frameWindow();
    if (source == null || event.source !== source) return;
    if (channel.acceptOpen(event)) onOpened(channel);
  };
}

/**
 * Close the channel of a document that left the frame: a new one replaced it, it navigated away
 * (the frame is removed until Reload, which loads a new document), or the view unmounted. The
 * HTML standard asks to close discarded ports. StrictMode replays effects (setup, cleanup,
 * setup) synchronously, so the cleanup closes only in a microtask, and only if no setup took
 * the same document back by then. The host's own cleanup runs before it, so its teardown still
 * went out on the channel.
 */
export function useCloseDiscardedDocumentChannel(
  viewDocument: { channel: FrameDocumentChannel } | null,
  frameMounted: boolean
) {
  const mountedDocument = useRef<typeof viewDocument>(null);
  useLayoutEffect(() => {
    if (viewDocument == null || !frameMounted) return;
    mountedDocument.current = viewDocument;
    return () => {
      mountedDocument.current = null;
      queueMicrotask(() => {
        if (mountedDocument.current !== viewDocument) viewDocument.channel.close();
      });
    };
  }, [viewDocument, frameMounted]);
}
