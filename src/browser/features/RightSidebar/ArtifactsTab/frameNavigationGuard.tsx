import { useRef, useState } from "react";
import { Notice } from "./SourceText";

/**
 * SECURITY AUDIT: a sandboxed srcdoc frame can still navigate itself (`location.href = ...`, a
 * clicked link): CSP does not cover navigation, and the remote page keeps the same
 * contentWindow, so it would pass the source-window gate and inherit the bridge without the
 * srcdoc's CSP. The desktop app blocks such subframe navigations (main.ts
 * will-frame-navigate); this guard covers every host: the first load of a srcdoc is the
 * document we built, and any later load means the frame left it. From then on the frame gets
 * no messages, its messages are dropped, and it is unmounted until the user reloads it.
 *
 * Accepted risk in browser/server mode (phones included), chosen by the product owner so that
 * previews, `window.xum` interactions and MCP App views work there: no web API can cancel a
 * frame navigation before it starts, and a navigated page keeps the frame's window. So that
 * page can send one request with what the frame held and can use the bridge (send asks the
 * user to confirm, setState, annotate pins, MCP tool calls that need no consent): until the
 * second load after a navigation the user started (a tapped link), and for as long as it stays
 * open when the artifact itself redirects while its srcdoc is still loading (then the
 * destination's load is the first one seen here). Such a redirect target also receives what the
 * host keeps sending to the frame: for an MCP App view, the `ui/initialize` reply, the tool input
 * and result sent once the view initializes, and the results of its later tool calls. The desktop
 * app blocks the navigation itself.
 */
export function useFrameNavigationGuard(srcDoc: string | null) {
  // Loads seen for the srcdoc currently in the frame; a new srcdoc or a reload starts over.
  const loads = useRef<{ srcDoc: string | null; frameKey: number; count: number }>({
    srcDoc: null,
    frameKey: 0,
    count: 0,
  });
  const [frameKey, setFrameKey] = useState(0);
  // Sticky until Reload, even if the content changes meanwhile.
  const [navigated, setNavigated] = useState(false);
  // Message handlers and posts read this synchronously, ahead of the re-render.
  const navigatedRef = useRef(false);

  return {
    /** Changes on Reload: use it as the iframe's key so a fresh frame gets the srcdoc. */
    frameKey,
    navigated,
    /** Stable; `.current` is true once the frame left its srcdoc: drop messages, stop posts. */
    navigatedRef,
    /** The iframe's onLoad. Returns false for a load after the first (a navigation). */
    onLoad: (): boolean => {
      if (srcDoc == null) return false;
      const current = loads.current;
      if (current.srcDoc !== srcDoc || current.frameKey !== frameKey) {
        loads.current = { srcDoc, frameKey, count: 1 };
        return true;
      }
      current.count += 1;
      navigatedRef.current = true;
      setNavigated(true);
      return false;
    },
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
        className="text-accent focus-visible:ring-accent rounded-sm underline underline-offset-2 focus-visible:ring-1"
      >
        Reload
      </button>
    </Notice>
  );
}
