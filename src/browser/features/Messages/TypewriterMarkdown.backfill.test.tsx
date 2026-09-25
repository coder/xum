import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "../../../../tests/ui/dom";
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
        <TranscriptBackfillContext.Provider value={isTranscriptBackfilling}>
          <TypewriterMarkdown
            content={content}
            isComplete={false}
            streamKey="in-flight"
            streamSource="replay"
          />
        </TranscriptBackfillContext.Provider>
      );
    });
  }

  test("paints streaming text without a transition and keeps it when the backfill ends", async () => {
    renderStreamingRow("First streamed paragraph", true);
    expect(container.textContent).toContain("First streamed paragraph");

    // Let the static render's ordinary (non-transition) follow-up work commit, as the frames
    // between the last delta and the end of the backfill do in the app.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Backfill done: back to Streamdown's streaming mode. Its blocks must already hold the
    // text, or the row blanks until the next transition commits.
    renderStreamingRow("First streamed paragraph and more", false);
    expect(container.textContent).toContain("First streamed paragraph");
  });
});
