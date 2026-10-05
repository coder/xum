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
});
