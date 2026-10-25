import "../../../../tests/ui/dom";

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MarkdownCore, markdownMayContainMath } from "./MarkdownCore";
import { publishKatexPlugins } from "./mathRendering";

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

describe("MarkdownCore", () => {
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

  // Every form that remark-math or rehype-katex renders. KaTeX loads lazily, so each case fails
  // if the math check misses the form or the lazy KaTeX render breaks.
  test.each([
    ["display math", "$$x^2$$"],
    ["a math fence", "```math\nx^2\n```"],
    ["a tilde math fence", "~~~ math\nx^2\n~~~"],
    ["raw language-math code", '<code class="language-math">x^2</code>'],
    ["raw math-inline code", '<code class="math-inline">x^2</code>'],
    ["an encoded raw math class", '<code class="math&#45;inline">x^2</code>'],
  ])("renders %s with KaTeX", async (_name, content) => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <MarkdownCore content={content} />
      </ThemeProvider>
    );
    await waitFor(() =>
      expect(view.container.querySelector(".katex annotation")?.textContent?.trim()).toBe("x^2")
    );
  });

  // Browser scroll anchoring holds on to a DOM node in view. If KaTeX's arrival replaced the whole
  // row's DOM (as a Suspense swap does), the rows on screen jumped. Publishing an empty list first
  // makes KaTeX arrive after the first render even when an earlier test already loaded it.
  test("keeps the row's other DOM nodes when KaTeX arrives", async () => {
    // eslint-disable-next-line no-restricted-syntax -- the lazy chunk, loaded as MarkdownCore does
    const { katexRehypePlugins } = await import("./katexRehypePlugin");
    act(() => publishKatexPlugins([]));
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <MarkdownCore content={"Intro paragraph.\n\n$$x^2$$"} />
      </ThemeProvider>
    );
    const intro = view.getByText("Intro paragraph.");
    expect(view.container.querySelector(".katex")).toBeNull();
    act(() => publishKatexPlugins(katexRehypePlugins));
    await waitFor(() => expect(view.container.querySelector(".katex")).not.toBeNull());
    expect(view.getByText("Intro paragraph.")).toBe(intro);
  });

  // remark-math leaves these as text (single-dollar math is off), so they must not load KaTeX.
  test.each([
    "A plain reply with **bold**, `code`, and a [link](https://example.com).",
    "It costs $5, or $6 with tax.",
    "Single-dollar $x$ stays text.",
    "\\(x\\) and \\[x\\] stay text.",
    "```ts\nconst mathResult = 1;\n```",
  ])("does not treat %p as math", (content) => {
    expect(markdownMayContainMath(content)).toBe(false);
  });
});
