import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import * as highlightWorkerClient from "@/browser/utils/highlighting/highlightWorkerClient";
import { HighlightedCode } from "./HighlightedCode";

let cleanupDom: (() => void) | null = null;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  cleanup();
  cleanupDom?.();
  cleanupDom = null;
});

test("aborts the highlight request of superseded or unmounted code without warning", async () => {
  const signals: AbortSignal[] = [];
  // Pending until aborted, like a request queued behind a busy worker.
  const highlightSpy = spyOn(highlightWorkerClient, "highlightCode").mockImplementation(
    (_code, _language, _theme, signal) => {
      if (!signal) throw new Error("HighlightedCode must pass an AbortSignal");
      signals.push(signal);
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason as Error));
      });
    }
  );
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const highlighted = (code: string) => (
      <ThemeProvider forcedTheme="dark">
        <HighlightedCode code={code} language="json" />
      </ThemeProvider>
    );
    const view = render(highlighted('{"a": 1}'));
    expect(signals).toHaveLength(1);

    view.rerender(highlighted('{"a": 2}'));
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);

    view.unmount();
    expect(signals[1].aborted).toBe(true);
    // Let the rejected requests settle before checking for warnings.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnSpy).not.toHaveBeenCalled();
  } finally {
    highlightSpy.mockRestore();
    warnSpy.mockRestore();
  }
});
