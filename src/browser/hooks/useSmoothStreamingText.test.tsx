import { installDom } from "../../../tests/ui/dom";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  useSmoothStreamingText,
  type UseSmoothStreamingTextOptions,
  type UseSmoothStreamingTextResult,
} from "./useSmoothStreamingText";

const FRAME_MS = 16;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeEnds(text: string): Set<number> {
  const ends = new Set([0]);
  for (const segment of graphemeSegmenter.segment(text)) {
    ends.add(segment.index + segment.segment.length);
  }
  return ends;
}

function expectGraphemePrefixOf(visibleText: string, text: string): void {
  expect(text.startsWith(visibleText)).toBe(true);
  expect(graphemeEnds(text).has(visibleText.length)).toBe(true);
}

// Every common multi-code-unit grapheme shape, mixed with ASCII.
const MIXED_GRAPHEMES = [
  "Hi ",
  "e\u0301",
  "👍🏽",
  " 👨‍👩‍👧",
  "🏳️‍🌈",
  "🇩🇪🇫🇷",
  "🇩",
  "\r\n",
  "\u1100\u1161\u11a8",
  "क्ष",
  "☺️",
  " ok",
].join("");

describe("useSmoothStreamingText", () => {
  let cleanupDom: (() => void) | undefined;
  let rafHandleCounter = 0;
  let currentTimeMs = 0;
  const rafCallbacks = new Map<number, FrameRequestCallback>();

  beforeEach(() => {
    cleanupDom = installDom();

    rafHandleCounter = 0;
    currentTimeMs = 0;
    rafCallbacks.clear();

    const requestAnimationFrameMock: typeof requestAnimationFrame = (callback) => {
      rafHandleCounter += 1;
      rafCallbacks.set(rafHandleCounter, callback);
      return rafHandleCounter;
    };

    const cancelAnimationFrameMock: typeof cancelAnimationFrame = (handle) => {
      rafCallbacks.delete(handle);
    };

    globalThis.requestAnimationFrame = requestAnimationFrameMock;
    globalThis.cancelAnimationFrame = cancelAnimationFrameMock;
    globalThis.window.requestAnimationFrame = requestAnimationFrameMock;
    globalThis.window.cancelAnimationFrame = cancelAnimationFrameMock;
  });

  afterEach(() => {
    cleanup();

    rafCallbacks.clear();

    // Preserve the shared DOM so later Bun suites can initialize DOM-dependent modules.
    cleanupDom?.();
    cleanupDom = undefined;
  });

  function advanceFrames(frameCount: number): void {
    act(() => {
      for (let i = 0; i < frameCount; i++) {
        currentTimeMs += FRAME_MS;

        const callbacks = Array.from(rafCallbacks.values());
        rafCallbacks.clear();

        for (const callback of callbacks) {
          callback(currentTimeMs);
        }
      }
    });
  }

  /**
   * Text present at mount is shown at once (#5555), so smoothing tests mount empty and then
   * stream the text in, as a fresh reply does.
   */
  function mountThenStream(fullText: string, streamKey: string) {
    const view = renderHook(
      (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
      { initialProps: streamingProps("", streamKey) }
    );
    act(() => {
      view.rerender(streamingProps(fullText, streamKey));
    });
    return view;
  }

  function hasLoneSurrogate(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      const isHigh = code >= 0xd800 && code <= 0xdbff;
      const isLow = code >= 0xdc00 && code <= 0xdfff;

      if (isHigh) {
        const next = value.charCodeAt(i + 1);
        const nextIsLow = next >= 0xdc00 && next <= 0xdfff;
        if (!nextIsLow) {
          return true;
        }
        i += 1;
        continue;
      }

      if (isLow) {
        return true;
      }
    }

    return false;
  }

  it("keeps RAF progress stable while fullText updates rapidly", () => {
    const { result, rerender } = renderHook(
      (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
      {
        initialProps: {
          fullText: "x".repeat(20),
          isStreaming: true,
          bypassSmoothing: false,
          streamKey: "stream-rapid",
        },
      }
    );

    for (let i = 0; i < 12; i++) {
      act(() => {
        rerender({
          fullText: "x".repeat(20 + i),
          isStreaming: true,
          bypassSmoothing: false,
          streamKey: "stream-rapid",
        });
      });

      advanceFrames(1);
    }

    expect(result.current.visibleText.length).toBeGreaterThan(0);
  });

  it("does not emit partial surrogate pairs while smoothing", () => {
    const { result } = mountThenStream("🙂🙂🙂", "stream-grapheme");

    for (let i = 0; i < 10; i++) {
      advanceFrames(1);
      expect(hasLoneSurrogate(result.current.visibleText)).toBe(false);
    }
  });

  it("reveals text progressively while streaming", () => {
    const initialProps: UseSmoothStreamingTextOptions = {
      fullText: "x".repeat(220),
      isStreaming: true,
      bypassSmoothing: false,
      streamKey: "stream-1",
    };

    const { result } = mountThenStream(initialProps.fullText, initialProps.streamKey);

    const initialLength = result.current.visibleText.length;
    expect(initialLength).toBeLessThan(initialProps.fullText.length);

    advanceFrames(8);

    const progressedLength = result.current.visibleText.length;
    expect(progressedLength).toBeGreaterThan(initialLength);
    expect(progressedLength).toBeLessThan(initialProps.fullText.length);
  });

  it("resets reveal progress when stream key changes", () => {
    const firstStreamText = "a".repeat(200);
    const secondStreamText = "b".repeat(140);

    const { result, rerender } = mountThenStream(firstStreamText, "stream-1");

    advanceFrames(12);

    const firstStreamProgress = result.current.visibleText.length;
    expect(firstStreamProgress).toBeGreaterThan(0);

    act(() => {
      rerender({
        fullText: secondStreamText,
        isStreaming: true,
        bypassSmoothing: false,
        streamKey: "stream-2",
      });
    });

    const resetLength = result.current.visibleText.length;
    expect(resetLength).toBeLessThan(firstStreamProgress);
    expect(resetLength).toBeLessThan(secondStreamText.length);

    advanceFrames(6);

    expect(result.current.visibleText.length).toBeGreaterThan(resetLength);
  });

  it("re-arms smoothing after catch-up when new deltas arrive", () => {
    const shortText = "x".repeat(40);
    const longerText = "x".repeat(200);

    const { result, rerender } = renderHook(
      (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
      {
        initialProps: {
          fullText: shortText,
          isStreaming: true,
          bypassSmoothing: false,
          streamKey: "stream-rearm",
        },
      }
    );

    // Advance until fully caught up with the short text.
    advanceFrames(60);
    expect(result.current.isCaughtUp).toBe(true);
    const caughtUpLength = result.current.visibleText.length;
    expect(caughtUpLength).toBe(shortText.length);

    // Simulate new deltas arriving (same stream, longer text).
    act(() => {
      rerender({
        fullText: longerText,
        isStreaming: true,
        bypassSmoothing: false,
        streamKey: "stream-rearm",
      });
    });

    // The hook should re-arm and start revealing the new text.
    advanceFrames(4);
    expect(result.current.visibleText.length).toBeGreaterThan(caughtUpLength);
    expect(result.current.visibleText.length).toBeLessThan(longerText.length);
  });

  function streamingProps(fullText: string, streamKey: string): UseSmoothStreamingTextOptions {
    return { fullText, isStreaming: true, bypassSmoothing: false, streamKey };
  }

  it("reveals appended mixed-grapheme text only at grapheme boundaries, never shrinking", () => {
    const fullText = MIXED_GRAPHEMES.repeat(4);
    // Append in uneven chunks cut at grapheme boundaries of the final text, so no
    // append extends the previous chunk's last grapheme.
    const cuts = [...graphemeEnds(fullText)].filter((end, i) => end > 0 && i % 3 === 0);
    cuts.push(fullText.length);

    const { result, rerender } = renderHook(
      (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
      { initialProps: streamingProps(fullText.slice(0, cuts[0]), "stream-mixed") }
    );

    let previousLength = 0;
    const checkVisible = (currentText: string) => {
      const visibleText = result.current.visibleText;
      expectGraphemePrefixOf(visibleText, currentText);
      expect(visibleText.length).toBeGreaterThanOrEqual(previousLength);
      previousLength = visibleText.length;
    };

    for (const cut of cuts) {
      const currentText = fullText.slice(0, cut);
      act(() => {
        rerender(streamingProps(currentText, "stream-mixed"));
      });
      checkVisible(currentText);
      for (let frame = 0; frame < 2; frame++) {
        advanceFrames(1);
        checkVisible(currentText);
      }
    }

    for (let frame = 0; frame < 200 && !result.current.isCaughtUp; frame++) {
      advanceFrames(1);
      checkVisible(fullText);
    }
    expect(result.current.visibleText).toBe(fullText);
  });

  it("hides a grapheme while an append extends it, then reveals the whole grapheme", () => {
    const cases = [
      { before: "ab👍", after: "ab👍🏽" },
      { before: "ab🇩", after: "ab🇩🇪" },
      { before: "abe", after: "abe\u0301" },
      { before: "ab👨", after: "ab👨‍👩" },
    ];

    for (const { before, after } of cases) {
      const { result, rerender, unmount } = renderHook(
        (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
        { initialProps: streamingProps(before, `extend-${after}`) }
      );
      advanceFrames(60);
      expect(result.current.visibleText).toBe(before);

      act(() => {
        rerender(streamingProps(after, `extend-${after}`));
      });
      // The revealed code units now sit inside a longer grapheme, so it is held back.
      expect(result.current.visibleText).toBe("ab");

      advanceFrames(60);
      expect(result.current.visibleText).toBe(after);
      unmount();
    }
  });

  it("keeps a grapheme-boundary prefix when the same stream's text is replaced or shortened", () => {
    const { result, rerender } = renderHook(
      (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
      { initialProps: streamingProps(MIXED_GRAPHEMES.repeat(4), "stream-replace") }
    );
    advanceFrames(10);
    const revealedLength = result.current.visibleText.length;
    expect(revealedLength).toBeGreaterThan(10);

    // A different text whose ZWJ family spans the revealed length, then a text shorter
    // than what is already revealed. Neither extends the previous text.
    const replaced = `${"y".repeat(revealedLength - 3)}👨‍👩‍👧 tail`;
    const shortened = "short";

    const catchUpTo = (text: string) => {
      for (let frame = 0; frame < 200 && !result.current.isCaughtUp; frame++) {
        expectGraphemePrefixOf(result.current.visibleText, text);
        advanceFrames(1);
      }
      expect(result.current.visibleText).toBe(text);
    };

    act(() => {
      rerender(streamingProps(replaced, "stream-replace"));
    });
    expect(result.current.visibleText).toBe("y".repeat(revealedLength - 3));
    catchUpTo(replaced);

    act(() => {
      rerender(streamingProps(shortened, "stream-replace"));
    });
    catchUpTo(shortened);
  });

  // #5555: a chat switch-back (or a bundle toggle) remounts a row that is still streaming. Its
  // text was already shown before the remount, so it must not be re-typed from empty.
  it("shows the text present at mount at once and smooths only later growth", () => {
    const mounted = "x".repeat(300);
    const grown = mounted + "y".repeat(300);
    const renders: string[] = [];
    const { result, rerender } = renderHook(
      (hookProps: UseSmoothStreamingTextOptions) => {
        const hookResult = useSmoothStreamingText(hookProps);
        renders.push(hookResult.visibleText);
        return hookResult;
      },
      { initialProps: streamingProps(mounted, "stream-remount") }
    );
    // Every render, including the very first, already shows the mounted text.
    for (const visibleText of renders) expect(visibleText).toBe(mounted);

    act(() => {
      rerender(streamingProps(grown, "stream-remount"));
    });
    expect(result.current.visibleText).toBe(mounted);
    let previousLength = mounted.length;
    advanceFrames(2);
    expect(result.current.visibleText.length).toBeGreaterThan(mounted.length);
    expect(result.current.visibleText.length).toBeLessThan(grown.length);
    for (let frame = 0; frame < 200 && !result.current.isCaughtUp; frame++) {
      expect(result.current.visibleText.length).toBeGreaterThanOrEqual(previousLength);
      previousLength = result.current.visibleText.length;
      advanceFrames(1);
    }
    expect(result.current.visibleText).toBe(grown);
  });

  it("seeds only on first mount: a later stream key change still reveals from empty", () => {
    const { result, rerender } = renderHook(
      (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
      { initialProps: streamingProps("a".repeat(200), "stream-a") }
    );
    expect(result.current.visibleText).toBe("a".repeat(200));

    const next = "b".repeat(200);
    act(() => {
      rerender(streamingProps(next, "stream-b"));
    });
    expect(result.current.visibleText).toBe("");
    advanceFrames(4);
    expect(result.current.visibleText.length).toBeGreaterThan(0);
    expect(result.current.visibleText.length).toBeLessThan(next.length);
  });

  it("never splits a grapheme that the first growth after mount extends", () => {
    const cases = [
      { mounted: "ab👨\u200d", grown: "ab👨\u200d👩\u200d👧 and more text" },
      { mounted: "cafe", grown: "cafe\u0301 au lait, and more text" },
    ];
    for (const { mounted, grown } of cases) {
      const { result, rerender, unmount } = renderHook(
        (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
        { initialProps: streamingProps(mounted, `seed-${grown}`) }
      );
      expect(result.current.visibleText).toBe(mounted);
      act(() => {
        rerender(streamingProps(grown, `seed-${grown}`));
      });
      for (let frame = 0; frame < 200 && !result.current.isCaughtUp; frame++) {
        expectGraphemePrefixOf(result.current.visibleText, grown);
        advanceFrames(1);
      }
      expect(result.current.visibleText).toBe(grown);
      unmount();
    }
  });

  it("mounting a replayed or finished row shows its full text, and live growth continues from it", () => {
    const fullText = MIXED_GRAPHEMES.repeat(4);
    const cases: Array<Pick<UseSmoothStreamingTextOptions, "isStreaming" | "bypassSmoothing">> = [
      { isStreaming: false, bypassSmoothing: false },
      { isStreaming: true, bypassSmoothing: true },
    ];
    for (const flags of cases) {
      const renders: string[] = [];
      const { result, rerender, unmount } = renderHook(
        (hookProps: UseSmoothStreamingTextOptions) => {
          const hookResult = useSmoothStreamingText(hookProps);
          renders.push(hookResult.visibleText);
          return hookResult;
        },
        { initialProps: { ...streamingProps(fullText, "stream-mount-flags"), ...flags } }
      );
      for (const visibleText of renders) expect(visibleText).toBe(fullText);

      // Replay catch-up followed by the first live delta: no regression below the shown text.
      const grown = fullText + "z".repeat(200);
      act(() => {
        rerender(streamingProps(grown, "stream-mount-flags"));
      });
      expect(result.current.visibleText).toBe(fullText);
      advanceFrames(2);
      expect(result.current.visibleText.length).toBeGreaterThan(fullText.length);
      expect(result.current.visibleText.length).toBeLessThan(grown.length);
      unmount();
    }
  });

  it("returns the full text at once when streaming ends or smoothing is bypassed", () => {
    const fullText = MIXED_GRAPHEMES.repeat(4);
    const cases: Array<Pick<UseSmoothStreamingTextOptions, "isStreaming" | "bypassSmoothing">> = [
      { isStreaming: false, bypassSmoothing: false },
      { isStreaming: true, bypassSmoothing: true },
    ];

    for (const flags of cases) {
      // Record every render: result.current only shows the last one, after effects re-render.
      const renders: UseSmoothStreamingTextResult[] = [];
      const { result, rerender, unmount } = renderHook(
        (hookProps: UseSmoothStreamingTextOptions) => {
          const hookResult = useSmoothStreamingText(hookProps);
          renders.push(hookResult);
          return hookResult;
        },
        { initialProps: streamingProps("", "stream-flush") }
      );
      act(() => {
        rerender(streamingProps(fullText, "stream-flush"));
      });
      advanceFrames(2);
      expect(result.current.visibleText.length).toBeLessThan(fullText.length);

      const firstRenderAfterFlip = renders.length;
      act(() => {
        rerender({ ...streamingProps(fullText, "stream-flush"), ...flags });
      });
      // The very first render after the flip already shows everything: no one-frame lag.
      const rendersAfterFlip = renders.slice(firstRenderAfterFlip);
      expect(rendersAfterFlip.length).toBeGreaterThan(0);
      for (const hookResult of rendersAfterFlip) {
        expect(hookResult).toEqual({ visibleText: fullText, isCaughtUp: true });
      }
      unmount();
    }
  });
});
