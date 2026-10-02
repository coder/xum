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
        className="text-accent underline underline-offset-2"
      >
        Reload
      </button>
    </Notice>
  );
}
