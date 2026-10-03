import { installDom } from "../../../tests/ui/dom";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  useSmoothStreamingText,
  type UseSmoothStreamingTextOptions,
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
    const { result } = renderHook(
      (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
      {
        initialProps: {
          fullText: "🙂🙂🙂",
          isStreaming: true,
          bypassSmoothing: false,
          streamKey: "stream-grapheme",
        },
      }
    );

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

    const { result } = renderHook(
      (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
      {
        initialProps,
      }
    );

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

    const { result, rerender } = renderHook(
      (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
      {
        initialProps: {
          fullText: firstStreamText,
          isStreaming: true,
          bypassSmoothing: false,
          streamKey: "stream-1",
        },
      }
    );

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
      expect(currentText.startsWith(visibleText)).toBe(true);
      expect(graphemeEnds(currentText).has(visibleText.length)).toBe(true);
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

  it("returns the full text at once when streaming ends or smoothing is bypassed", () => {
    const fullText = MIXED_GRAPHEMES.repeat(4);
    const cases: Array<Pick<UseSmoothStreamingTextOptions, "isStreaming" | "bypassSmoothing">> = [
      { isStreaming: false, bypassSmoothing: false },
      { isStreaming: true, bypassSmoothing: true },
    ];

    for (const flags of cases) {
      const { result, rerender, unmount } = renderHook(
        (hookProps: UseSmoothStreamingTextOptions) => useSmoothStreamingText(hookProps),
        { initialProps: streamingProps(fullText, "stream-flush") }
      );
      advanceFrames(2);
      expect(result.current.visibleText.length).toBeLessThan(fullText.length);

      act(() => {
        rerender({ ...streamingProps(fullText, "stream-flush"), ...flags });
      });
      expect(result.current).toEqual({ visibleText: fullText, isCaughtUp: true });
      unmount();
    }
  });
});
