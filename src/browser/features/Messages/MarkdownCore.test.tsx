import "../../../../tests/ui/dom";

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MarkdownCore } from "./MarkdownCore";

// An earlier block holds a lone `*`. Repairing the whole text (Streamdown's own repair) would
// append a stray `*` after the last block; repairing only the last block does not.
const STREAMED = "Price is 5 * 3.\n\nAll **done";

function renderCore(renderSynchronously: boolean) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <MarkdownCore
        content={STREAMED}
        parseIncompleteMarkdown
        renderSynchronously={renderSynchronously}
      />
    </ThemeProvider>
  );
}

describe("MarkdownCore incomplete-markdown repair", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // MarkdownCore passes parseIncompleteMarkdown={false} to Streamdown and repairs the text itself.
  // This fails if a Streamdown upgrade makes that prop stop gating Streamdown's own repair.
  test.each([
    ["streaming", false],
    ["static", true],
  ])("repairs only the last block in %s mode", async (_mode, renderSynchronously) => {
    const view = renderCore(renderSynchronously);
    await waitFor(() =>
      expect(view.container.querySelector("[data-streamdown=strong]")?.textContent).toBe("done")
    );
    expect(view.container.textContent).toContain("Price is 5 * 3.");
    expect(view.container.textContent?.trimEnd()).toEndWith("All done");
  });

  // remend 1.4.0 closes an unclosed image with a placeholder URL that the URL filter renders as
  // "[Image blocked: alt]"; the repair must not let that through, and must keep later text.
  test.each([
    ["placeholder text earlier in the reply", "a ](streamdown:incomplete-image) and ![x", "and"],
    ["an image before later list items", "- ![a\n- b\n- c **d", "c **d"],
  ])("streams %s without a blocked image", async (_name, content, lastText) => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <MarkdownCore content={content} parseIncompleteMarkdown renderSynchronously />
      </ThemeProvider>
    );
    await waitFor(() => expect(view.container.textContent?.trimEnd()).toEndWith(lastText));
    expect(view.container.textContent).not.toContain("Image blocked");
  });

  test.each([
    ["streaming", true],
    ["completed", false],
  ])("renders a completed image while %s", async (_state, parseIncompleteMarkdown) => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <MarkdownCore
          content="![a](https://x/y.png) and more text."
          parseIncompleteMarkdown={parseIncompleteMarkdown}
          renderSynchronously
        />
      </ThemeProvider>
    );
    await waitFor(() =>
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe("https://x/y.png")
    );
    expect(view.container.textContent).toContain("and more text.");
  });
});
