import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import * as highlightWorkerClient from "@/browser/utils/highlighting/highlightWorkerClient";
import {
  advanceFakeTime,
  fakeHighlightedLine,
  installFakeHighlightWorkers,
} from "@/browser/utils/highlighting/highlightWorker.testHarness";
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

// #6303: when the worker did not start in time, the mounted block stayed plain text until it
// remounted or its code changed, although the next worker started fine.
test("a mounted block highlights once a worker is ready after a start time-out", async () => {
  highlightWorkerClient.__resetForTests();
  const workers = installFakeHighlightWorkers([null, 0]);
  const highlightSpy = spyOn(highlightWorkerClient, "highlightCode");
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  jest.useFakeTimers();
  try {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <HighlightedCode code="const a = 1;" language="typescript" />
      </ThemeProvider>
    );
    // A second block keeps the queue busy, so a new worker starts after the first one gave up.
    const other = render(
      <ThemeProvider forcedTheme="dark">
        <HighlightedCode code="const b = 2;" language="typescript" />
      </ThemeProvider>
    );
    await act(() =>
      advanceFakeTime(30_000, () =>
        view.container.innerHTML.includes(fakeHighlightedLine("const a = 1;"))
      )
    );
    expect(other.container.innerHTML).toContain(fakeHighlightedLine("const b = 2;"));
    expect(view.container.innerHTML).toContain(fakeHighlightedLine("const a = 1;"));
    // One request per block: the retry happens inside it, not as a new request per render.
    expect(highlightSpy).toHaveBeenCalledTimes(2);
    expect(workers.created).toHaveLength(2);
  } finally {
    jest.useRealTimers();
    highlightSpy.mockRestore();
    warnSpy.mockRestore();
    highlightWorkerClient.__resetForTests();
    workers.restore();
  }
});
