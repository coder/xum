import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { TranscriptBackfillContext } from "./TranscriptBackfillContext";
import { TypewriterMarkdown } from "./TypewriterMarkdown";

// Real MarkdownCore/Streamdown on purpose: the contract is that a streaming row paints its text
// in the commit that mounts it while the transcript backfill runs. Each reveal step preempts
// React transitions in the app, so text that only a later transition publishes stays blank for
// the whole backfill. flushSync commits without ever running a transition, which makes that
// failure deterministic here.
describe("TypewriterMarkdown during a transcript backfill", () => {
  let cleanupDom: (() => void) | null = null;
  let root: Root | null = null;
  let container: HTMLElement;

  beforeEach(() => {
    cleanupDom = installDom();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderStreamingRow(content: string, isTranscriptBackfilling: boolean): void {
    flushSync(() => {
      root?.render(
        // CodeBlock reads the theme to pick its Shiki palette.
        <ThemeProvider forcedTheme="dark">
          <TranscriptBackfillContext.Provider value={isTranscriptBackfilling}>
            <TypewriterMarkdown
              content={content}
              isComplete={false}
              streamKey="in-flight"
              streamSource="replay"
            />
          </TranscriptBackfillContext.Provider>
        </ThemeProvider>
      );
    });
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  // Static and streaming Streamdown emit different whitespace text nodes between blocks; only
  // the rendered elements and text matter to the reader.
  const normalizedMarkup = () => container.innerHTML.replace(/>\s+</g, "><");

  test("paints streaming text without a transition and keeps it when the backfill ends", async () => {
    renderStreamingRow("First streamed paragraph", true);
    expect(container.textContent).toContain("First streamed paragraph");

    // Let the static render's ordinary (non-transition) follow-up work commit, as the frames
    // between the last delta and the end of the backfill do in the app.
    await tick();

    // Backfill done: back to Streamdown's streaming mode. Its blocks must already hold the
    // text, or the row blanks until the next transition commits.
    renderStreamingRow("First streamed paragraph and more", false);
    expect(container.textContent).toContain("First streamed paragraph");
  });

  // The in-flight reply must look the same before and after the backfill flag flips back, or it
  // visibly restyles ~1-2 s after a mid-stream return (#4608).
  test.each([
    // The flip remounts Streamdown's subtree; an open code block must stay highlighted instead of
    // dropping to plain text until Shiki answers again.
    [
      "an open code fence",
      "Intro\n\n```ts\nconst x = 1;\nconst y = 2",
      (root: HTMLElement) => root.querySelector(".code-line span") !== null,
    ],
    // Incomplete-markdown repair must apply during the backfill too, or the tail renders as
    // literal `**` until the flip.
    [
      "an inline tail",
      "Intro paragraph with **bold tail",
      (root: HTMLElement) =>
        root.textContent?.includes("bold tail") === true && !root.textContent.includes("**"),
    ],
  ])(
    "renders %s identically before and after the backfill ends",
    async (_name, content, isReady) => {
      renderStreamingRow(content, true);
      for (let i = 0; i < 200 && !isReady(container); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(isReady(container)).toBe(true);
      await tick();
      const duringBackfill = normalizedMarkup();

      renderStreamingRow(content, false);
      expect(normalizedMarkup()).toBe(duringBackfill);

      // Streamdown's streaming mode republishes its blocks in a transition after the flip.
      for (let i = 0; i < 5; i++) await tick();
      expect(normalizedMarkup()).toBe(duringBackfill);
    }
  );
});
