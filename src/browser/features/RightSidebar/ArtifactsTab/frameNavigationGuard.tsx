import { useRef, useState } from "react";
import type { FrameDocumentChannel } from "./frameDocumentChannel";
import { Notice } from "./SourceText";

/**
 * Where a frame's document is in its lifecycle. Unbound: its first script has not opened its
 * channel yet, so a second load means the frame left it. Bound: the host holds the document's
 * port (frameDocumentChannel.ts), and every load asks the document to answer over it.
 */
type FrameLifecycle =
  | { kind: "unbound"; loads: number }
  | { kind: "bound"; channel: FrameDocumentChannel };

/**
 * SECURITY AUDIT: a sandboxed srcdoc frame can still navigate itself (`location.href = ...`, a
 * clicked link, a redirect, `location.reload()`): CSP does not cover navigation, and the next
 * page keeps the frame's window without the srcdoc's CSP. The desktop app refuses such subframe
 * navigations (subframeNavigation.ts); this guard covers every host, browser and phones
 * included. It closes the frame (unmounted until the user reloads it, no message in or out)
 * whenever the frame holds a document other than the one the host built.
 *
 * A load event cannot tell which document loaded: WebKit fires one for `location.hash` and every
 * history traversal, Chromium for a `history.back()` to the srcdoc's first entry, and both for
 * `document.open()`, while the document stays.
 * So loads never grant anything; they only trigger checks. Once the document's channel is bound
 * (`opened`), every load sends a check over its port with a fresh value, and only the bound
 * document can answer it: a page the frame navigated to gets a fresh realm without the port.
 * No answer to the latest check within FRAME_DOCUMENT_CHECK_DEADLINE_MS of the first unanswered
 * one closes the frame, so neither an old answer nor a page that keeps reloading itself keeps it
 * open. A deadline whose window saw the app's own thread blocked (a timer of the channel fired
 * late, so the document may not have been able to answer either) gives the check one more
 * deadline, never past FRAME_DOCUMENT_CHECK_CAP_MS after its first unanswered check
 * (frameDocumentChannel.ts). The document's `pagehide` leave closes it at once (a fast path its
 * own code can block).
 * Before the bind, the second load closes the frame. All bridge traffic, both ways, goes over the
 * bound port only (frameDocumentChannel.ts).
 *
 * Residual risks, browser mode:
 * 1. A destination page whose load never completes, after artifact code blocked the leave on
 *    purpose, stays shown (without the bridge) until the user leaves the tab: no load, no check.
 * 2. A navigation can carry one request with whatever the artifact put in its URL.
 * 3. When the leave is missing, a destination page shows (without the bridge) from its commit
 *    until the deadline after its load completes.
 * 4. The srcdoc document's open announcement must reach the host before any load or message of
 *    a destination page; the first script posts it before any artifact or view script runs.
 * 5. An MCP App view holds its own port, so it can break its own channel (close it, answer
 *    nothing). Its next load then closes its frame; it cannot keep a destination page open.
 * 6. A destination page that keeps the shared thread busy (WebKit, in-process Chromium) blocks
 *    each deadline's window, so it stays shown (without the bridge) until the cap passes and its
 *    current block ends.
 */
export function useFrameNavigationGuard(documentKey: string | null) {
  // The lifecycle of the document currently in the frame; a new document or a reload starts over.
  const lifecycle = useRef<{
    documentKey: string | null;
    frameKey: number;
    state: FrameLifecycle;
  }>({ documentKey: null, frameKey: 0, state: { kind: "unbound", loads: 0 } });
  const [frameKey, setFrameKey] = useState(0);
  // Sticky until Reload, even if the content changes meanwhile.
  const [navigated, setNavigated] = useState(false);
  // Message handlers and posts read this synchronously, ahead of the re-render.
  const navigatedRef = useRef(false);
  const leave = () => {
    navigatedRef.current = true;
    setNavigated(true);
  };
  /** The lifecycle record of this render's document, started over for a new one. */
  const currentDocument = () => {
    if (documentKey == null) return null;
    const record = lifecycle.current;
    if (record.documentKey === documentKey && record.frameKey === frameKey) return record;
    lifecycle.current = { documentKey, frameKey, state: { kind: "unbound", loads: 0 } };
    return lifecycle.current;
  };

  return {
    /** Changes on Reload: use it as the iframe's key so a fresh frame gets the srcdoc. */
    frameKey,
    navigated,
    /** Stable; `.current` is true once the frame left its srcdoc: drop messages, stop posts. */
    navigatedRef,
    /**
     * The iframe's onLoad. Checks a bound document at every load, and closes the frame at an
     * unbound document's second load.
     */
    onLoad: () => {
      const state = currentDocument()?.state;
      if (state == null) return;
      if (state.kind === "bound") {
        state.channel.check(leave);
        return;
      }
      state.loads += 1;
      if (state.loads > 1) leave();
    },
    /** The document's channel bound (its open announcement arrived): loads now check it. */
    opened: (channel: FrameDocumentChannel) => {
      const record = currentDocument();
      if (record != null) record.state = { kind: "bound", channel };
    },
    /** The frame's document unloaded, or it missed a check (frameDocumentChannel.ts). */
    leave,
    reload: () => {
      navigatedRef.current = false;
      setNavigated(false);
      setFrameKey((key) => key + 1);
    },
  };
}

export function FrameNavigatedNotice(props: { onReload: () => void }) {
  return (
    <Notice>
      <span>This artifact navigated away, so it was closed. </span>
      <button
        type="button"
        onClick={props.onReload}
        className="text-accent-text focus-visible:ring-accent rounded-sm underline underline-offset-2 focus-visible:ring-1"
      >
        Reload
      </button>
    </Notice>
  );
}
