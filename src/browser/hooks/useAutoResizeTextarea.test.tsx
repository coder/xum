import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { RefObject } from "react";
import { useAutoResizeTextarea } from "./useAutoResizeTextarea";

function createFakeTextarea(initialScrollHeight: number): {
  ref: RefObject<HTMLTextAreaElement>;
  assignments: string[];
  setScrollHeight: (value: number) => void;
  setInlineHeight: (value: string) => void;
  scrollHeightReads: () => number;
} {
  let height = "";
  let scrollHeight = initialScrollHeight;
  let scrollHeightReads = 0;
  const assignments: string[] = [];
  const style = {
    get height() {
      return height;
    },
    set height(value: string) {
      height = value;
      assignments.push(value);
    },
  };

  const textarea = {
    style,
    get scrollHeight() {
      scrollHeightReads += 1;
      return scrollHeight;
    },
  } as unknown as HTMLTextAreaElement;

  return {
    ref: { current: textarea },
    assignments,
    setScrollHeight: (value) => {
      scrollHeight = value;
    },
    setInlineHeight: (value) => {
      height = value;
    },
    scrollHeightReads: () => scrollHeightReads,
  };
}

describe("useAutoResizeTextarea", () => {
  beforeEach(() => {
    saveDomGlobals();
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    Object.defineProperty(globalThis.window, "innerHeight", {
      configurable: true,
      value: 1000,
    });
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  it("skips measurement entirely while the value is empty", () => {
    const textarea = createFakeTextarea(40);
    renderHook(({ value }) => useAutoResizeTextarea(textarea.ref, value, 50), {
      initialProps: { value: "" },
    });

    // This is the hot path for switching to a workspace with an empty draft: reading
    // scrollHeight inside the commit phase would force a synchronous reflow of the
    // freshly mounted transcript, so the hook must not measure or write any height.
    expect(textarea.assignments).toEqual([]);
    expect(textarea.scrollHeightReads()).toBe(0);
  });

  it("clears the inline height when the draft becomes empty", () => {
    const textarea = createFakeTextarea(800);
    const { rerender } = renderHook(({ value }) => useAutoResizeTextarea(textarea.ref, value, 50), {
      initialProps: { value: "line one\nline two" },
    });
    expect(textarea.assignments).toEqual(["auto", "500px"]);
    textarea.assignments.length = 0;

    rerender({ value: "" });

    // Empty drafts (e.g. after send) fall back to CSS sizing without measuring.
    expect(textarea.assignments).toEqual([""]);
  });

  it("does not reset height to auto for pure typing that does not change composer height", () => {
    const textarea = createFakeTextarea(40);
    const { rerender } = renderHook(({ value }) => useAutoResizeTextarea(textarea.ref, value, 50), {
      initialProps: { value: "" },
    });

    // First keystroke after the unmeasured empty state grows from scrollHeight
    // without the shrink-to-auto reset.
    rerender({ value: "a" });
    expect(textarea.assignments).toEqual(["40px"]);
    textarea.assignments.length = 0;

    // This is the hot path for typing in a large chat: keep the existing height when
    // scrollHeight is unchanged so the transcript flex sibling does not get re-laid out.
    rerender({ value: "ab" });

    expect(textarea.assignments).toEqual([]);
  });

  it("grows on insertion without the shrink-to-auto reset, but still shrinks on deletion", () => {
    const textarea = createFakeTextarea(40);
    const { rerender } = renderHook(({ value }) => useAutoResizeTextarea(textarea.ref, value, 50), {
      initialProps: { value: "" },
    });
    textarea.assignments.length = 0;

    textarea.setScrollHeight(64);
    rerender({ value: "line one\nline two" });

    expect(textarea.assignments).toEqual(["64px"]);
    textarea.assignments.length = 0;

    textarea.setScrollHeight(40);
    rerender({ value: "line one" });

    expect(textarea.assignments).toEqual(["auto", "40px"]);
  });

  it("restores the capped height when a deletion keeps the same measured height", () => {
    const textarea = createFakeTextarea(800);
    const { rerender } = renderHook(({ value }) => useAutoResizeTextarea(textarea.ref, value, 50), {
      initialProps: { value: "line one\nline two\nline three" },
    });
    expect(textarea.assignments).toEqual(["auto", "500px"]);
    textarea.assignments.length = 0;

    rerender({ value: "line one\nline two" });

    expect(textarea.assignments).toEqual(["auto", "500px"]);
  });

  it("repairs the inline height after another caller clears it", () => {
    const textarea = createFakeTextarea(800);
    const { rerender } = renderHook(({ value }) => useAutoResizeTextarea(textarea.ref, value, 50), {
      initialProps: { value: "line one\nline two" },
    });
    expect(textarea.assignments).toEqual(["auto", "500px"]);
    textarea.assignments.length = 0;

    textarea.setInlineHeight("");
    rerender({ value: "line one\nline two!" });

    expect(textarea.assignments).toEqual(["500px"]);
  });

  it("remeasures when the sizing key changes but the draft does not", () => {
    const textarea = createFakeTextarea(88);
    const { rerender } = renderHook(
      ({ value, sizingKey }) => useAutoResizeTextarea(textarea.ref, value, 50, sizingKey),
      { initialProps: { value: "line one", sizingKey: "min-h-22" } }
    );
    expect(textarea.assignments).toEqual(["auto", "88px"]);
    textarea.assignments.length = 0;

    // Crossing into the phone layout lowers the CSS floor the draft was measured against.
    textarea.setScrollHeight(36);
    rerender({ value: "line one", sizingKey: "min-h-9" });

    expect(textarea.assignments).toEqual(["auto", "36px"]);
  });

  it("shrinks when a longer replacement does not preserve the previous text", () => {
    const textarea = createFakeTextarea(84);
    const { rerender } = renderHook(({ value }) => useAutoResizeTextarea(textarea.ref, value, 50), {
      initialProps: { value: "line one\nline two\nline three" },
    });
    textarea.assignments.length = 0;

    textarea.setScrollHeight(40);
    rerender({ value: "one visually shorter replacement" });

    expect(textarea.assignments).toEqual(["auto", "40px"]);
  });
});
