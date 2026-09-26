import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../tests/ui/dom";
import { App } from "./App";
import type { VscodeBridge } from "./vscodeBridge";

function createBridge(): VscodeBridge {
  return {
    traceId: "test",
    startedAtMs: 0,
    postMessage: mock(() => undefined),
    onMessage: () => () => undefined,
    debugLog: () => undefined,
  };
}

// Pins a scrollable geometry on the transcript scrollport; happy-dom has no layout, so every
// element otherwise reports 0 heights and always reads as "at the bottom".
function setScrollGeometry(element: HTMLElement, geometry: { scrollTop: number }) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 200 });
  element.scrollTop = geometry.scrollTop;
}

describe("vscode webview transcript auto-scroll", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("uses the bottom sentinel as the only scroll anchor while locked, and releases it on user scroll", async () => {
    const view = render(<App bridge={createBridge()} />);

    const sentinel = view.getByTestId("transcript-bottom-sentinel");
    const scrollport = sentinel.parentElement;
    if (!scrollport) throw new Error("sentinel must live inside the transcript scrollport");
    const content = scrollport.firstElementChild as HTMLElement | null;
    if (!content || content === sentinel)
      throw new Error("transcript content must precede the sentinel");

    // The sentinel is the scrollport's last child, so rows append above it and native scroll
    // anchoring keeps it (the bottom) pinned.
    expect(scrollport.lastElementChild).toBe(sentinel);
    expect(sentinel.style.overflowAnchor).toBe("auto");
    // Locked at the bottom: transcript content opts out so the sentinel is the only anchor.
    expect(content.style.overflowAnchor).toBe("none");

    // A user wheel followed by a scroll away from the bottom releases the lock...
    setScrollGeometry(scrollport, { scrollTop: 800 });
    await act(async () => {
      fireEvent.scroll(scrollport);
      fireEvent.wheel(scrollport, { deltaY: -120 });
      setScrollGeometry(scrollport, { scrollTop: 300 });
      fireEvent.scroll(scrollport);
      await Promise.resolve();
    });

    // ...so rows become anchor candidates again and the reading position is preserved.
    expect(content.style.overflowAnchor).toBe("");
    expect(sentinel.style.overflowAnchor).toBe("auto");
  });
});
