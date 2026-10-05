import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { ChunkedStreamingMarkdown, MarkdownChunker } from "./ChunkedStreamingMarkdown";
import { MarkdownCore } from "./MarkdownCore";

// Code-heavy reply, like the dense switch-back fixture: prose, a fenced block and a table per section.
function denseReply(sections: number): string {
  return Array.from(
    { length: sections },
    (_, i) =>
      `## Section ${i}\n\nSome **bold** prose with \`code\` and a [link](https://example.com/${i}).\n\n` +
      "```ts\nconst value" +
      i +
      " = compute(" +
      i +
      ");\nconsole.log(value" +
      i +
      ");\n```\n\n" +
      `| key | value |\n|---|---|\n| ${i} | v${i} |\n\n- item ${i}a\n- item ${i}b`
  ).join("\n\n");
}

describe("MarkdownChunker", () => {
  test("chunks join back to the text, and sealed chunks never change while it grows", () => {
    const full = denseReply(40);
    const chunker = new MarkdownChunker(500);
    let previous: readonly string[] = [];
    for (let end = 50; end <= full.length; end += 37) {
      const text = full.slice(0, end);
      const chunks = chunker.update(text);
      expect(chunks.join("")).toBe(text);
      // Every chunk but the previous last one is sealed and must stay identical.
      for (let i = 0; i < previous.length - 1; i++) expect(chunks[i]).toBe(previous[i]);
      previous = chunks;
    }
    expect(previous.length).toBeGreaterThan(10);
  });

  test("an open last block stays in the open chunk until two later blocks follow it", () => {
    const chunker = new MarkdownChunker(100);
    const intro = "Intro paragraph.\n\n";
    const fence = "```ts\n" + "const x = 1;\n".repeat(30);
    // The open fence is longer than a chunk but is still the last block: nothing after it seals.
    let chunks = chunker.update(intro + fence);
    expect(chunks.at(-1)).toContain("```ts");
    expect(chunks.at(-1)?.endsWith("const x = 1;\n")).toBe(true);

    // Closed and followed by one paragraph: that last block could still join the fence's
    // block, so the fence stays open too.
    chunks = chunker.update(intro + fence + "```\n\nAfter the fence.");
    expect(chunks.at(-1)).toContain("```ts");

    const closed = intro + fence + "```\n\nAfter the fence.\n\nMore.";
    chunks = chunker.update(closed);
    // A second block follows: the fence is sealed, the paragraphs are open.
    expect(chunks.at(-1)?.trim()).toBe("After the fence.\n\nMore.");
    expect(chunks.slice(0, -1).join("").trimEnd().endsWith("```")).toBe(true);
    expect(chunks.join("")).toBe(closed);
  });

  test("replaced text starts over instead of keeping a stale sealed prefix", () => {
    const chunker = new MarkdownChunker(20);
    chunker.update("First paragraph here.\n\nSecond paragraph here.\n\nThird.");
    const chunks = chunker.update("Other text.\n\nMore.");
    expect(chunks.join("")).toBe("Other text.\n\nMore.");
  });
});

describe("ChunkedStreamingMarkdown", () => {
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

  // The rendered blocks in order, by tag and text: what a reader sees, minus chunk wrappers.
  function blockOutline(element: Element): string[] {
    const blocks: string[] = [];
    for (const rootDiv of element.querySelectorAll(":scope > div, :scope > div > div")) {
      if (!rootDiv.className.includes("whitespace-normal")) continue;
      for (const block of rootDiv.children) {
        blocks.push(`${block.tagName}:${(block.textContent ?? "").replace(/\s+/g, " ").trim()}`);
      }
    }
    return blocks;
  }

  test("a completed chunked reply renders the same blocks as one static render", async () => {
    const reply = denseReply(30);
    flushSync(() =>
      root?.render(
        <ThemeProvider forcedTheme="dark">
          <ChunkedStreamingMarkdown content={reply} isStreaming={false} />
        </ThemeProvider>
      )
    );
    for (let i = 0; i < 100 && !container.textContent?.includes("Section 0"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const chunked = blockOutline(container);

    const single = document.createElement("div");
    document.body.appendChild(single);
    const singleRoot = createRoot(single);
    flushSync(() =>
      singleRoot.render(
        <ThemeProvider forcedTheme="dark">
          <MarkdownCore content={reply} />
        </ThemeProvider>
      )
    );
    const expected = blockOutline(single);
    flushSync(() => singleRoot.unmount());

    expect(expected.length).toBeGreaterThan(100);
    expect(chunked).toEqual(expected);
  });

  // #5664: a loose list longer than a chunk, streamed item by item. Some frames end mid-marker
  // (`…\n\n30` before the `.`), where the partial marker parses as a paragraph after the list.
  test.each([
    ["ordered", (k: number) => `${k}.`],
    ["bullet", () => "-"],
  ])(
    "a loose %s list streamed across chunks renders like one static render",
    async (_kind, marker) => {
      const items = Array.from(
        { length: 60 },
        (_, i) =>
          `${marker(i + 1)} Item ${i + 1} with **bold** and more words, lorem ipsum dolor sit.`
      );
      const reply = items.join("\n\n");
      const renderRow = (content: string, isStreaming: boolean) =>
        flushSync(() =>
          root?.render(
            <ThemeProvider forcedTheme="dark">
              <ChunkedStreamingMarkdown content={content} isStreaming={isStreaming} />
            </ThemeProvider>
          )
        );
      let text = "";
      for (const item of items) {
        if (text.length > 0) {
          text += "\n\n";
          // Every partial marker is its own frame, then the whole item.
          const space = item.indexOf(" ");
          for (let end = 1; end <= space; end++) renderRow(text + item.slice(0, end), true);
        }
        text += item;
        renderRow(text, true);
      }
      renderRow(reply, false);
      for (let i = 0; i < 100 && !container.textContent?.includes("Item 1 with"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Structure, not just text: one list with a <p> in every item, exactly as one render.
      const outline = (element: Element) =>
        [...element.querySelectorAll("ol, ul, li, li > p")].map(
          (node) => `${node.tagName}${node.getAttribute("start") ?? ""}`
        );
      const single = document.createElement("div");
      document.body.appendChild(single);
      const singleRoot = createRoot(single);
      flushSync(() =>
        singleRoot.render(
          <ThemeProvider forcedTheme="dark">
            <MarkdownCore content={reply} />
          </ThemeProvider>
        )
      );
      const expected = outline(single);
      const expectedText = single.textContent?.replace(/\s+/g, "");
      flushSync(() => singleRoot.unmount());

      expect(expected.filter((tag) => tag === "LI")).toHaveLength(60);
      expect(outline(container)).toEqual(expected);
      expect(container.textContent?.replace(/\s+/g, "")).toBe(expectedText);
    }
  );
});
