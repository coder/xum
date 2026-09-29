import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { HIGHLIGHT_CACHE_MAX_ENTRIES } from "./MarkdownComponents";
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

  test("keeps every block of the reply highlighted when many other highlights land first", async () => {
    // Older rows mounting during the backfill highlight their own code blocks, and the reply's
    // growing block is re-highlighted after each chunk. Neither may push the reply's finished
    // block out of the highlight results its remount reads.
    const historyRows = Array.from({ length: 16 }, (_, index) => (
      <TypewriterMarkdown
        key={index}
        content={"```ts\nconst history" + index + " = " + index + ";\n```"}
        isComplete={true}
      />
    ));
    const renderScene = (content: string, isTranscriptBackfilling: boolean) =>
      flushSync(() => {
        root?.render(
          <ThemeProvider forcedTheme="dark">
            <TranscriptBackfillContext.Provider value={isTranscriptBackfilling}>
              {historyRows}
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
    const allHighlighted = () =>
      Array.from(container.querySelectorAll(".code-line")).every(
        (line) => line.querySelector("span") !== null
      );
    const waitForHighlights = async () => {
      for (let i = 0; i < 300 && !allHighlighted(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(allHighlighted()).toBe(true);
    };

    // The growing block starts out identical to the finished block, so the two can't be told apart
    // by content until it grows.
    let content = "```ts\nconst finished = 1;\n```\n\n```ts\nconst finished = 1;";
    renderScene(content, true);
    await waitForHighlights();
    for (let chunk = 0; chunk < 16; chunk++) {
      content += `\ngrowing += ${chunk};`;
      renderScene(content, true);
      await waitForHighlights();
    }
    await tick();
    const duringBackfill = normalizedMarkup();

    renderScene(content, false);
    expect(normalizedMarkup()).toBe(duringBackfill);
  });

  test("a remounted growing block retires its old highlight, so a full cache keeps the reply's blocks (#4677)", async () => {
    // Exactly as many fences as the cache holds: the finished block first, the growing block last.
    const otherFences = Array.from(
      { length: HIGHLIGHT_CACHE_MAX_ENTRIES - 2 },
      (_, index) => "```ts\nconst reply" + index + " = " + index + ";\n```\n\n"
    ).join("");
    const renderReply = (content: string, isTranscriptBackfilling: boolean, isComplete: boolean) =>
      flushSync(() => {
        root?.render(
          <ThemeProvider forcedTheme="dark">
            <TranscriptBackfillContext.Provider value={isTranscriptBackfilling}>
              <TypewriterMarkdown
                content={content}
                isComplete={isComplete}
                streamKey="in-flight"
                streamSource="replay"
              />
            </TranscriptBackfillContext.Provider>
          </ThemeProvider>
        );
      });
    const allHighlighted = () => {
      const lines = Array.from(container.querySelectorAll(".code-line"));
      return lines.length > 0 && lines.every((line) => line.querySelector("span") !== null);
    };
    const waitForHighlights = async () => {
      for (let i = 0; i < 500 && !allHighlighted(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(allHighlighted()).toBe(true);
    };

    let content =
      "```ts\nconst finishedFirst = 1;\n```\n\n" + otherFences + "```ts\nconst growingLast = 0;";
    renderReply(content, true, false);
    await waitForHighlights();
    expect(container.querySelectorAll(".code-block-container")).toHaveLength(
      HIGHLIGHT_CACHE_MAX_ENTRIES
    );

    // Backfill ends: every block remounts and paints from the cache.
    renderReply(content, false, false);
    await waitForHighlights();

    // The remounted growing block highlights its next chunk. Its pre-remount highlight is stale
    // now; if it stayed cached, this write would push the cache over its bound and evict the
    // finished block, the oldest entry.
    content += "\ngrowingLast += 1;";
    renderReply(content, false, false);
    await waitForHighlights();
    for (let i = 0; i < 5; i++) await tick();

    // Stream completes: the reply remounts once more and every block must paint highlighted in
    // the commit that mounts it.
    renderReply(content, false, true);
    expect(allHighlighted()).toBe(true);
  });
});
