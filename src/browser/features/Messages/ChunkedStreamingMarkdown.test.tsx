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

// One huge top-level list of about `total` chars.
function hugeList(total: number, line: (k: number) => string): string {
  let out = "";
  for (let k = 1; out.length < total; k++) out += line(k);
  return out;
}

const bulletLine = (k: number) => `- item ${k} with **bold ${k}** and \`code ${k}\`\n`;

const TABLE_HEAD = "| n | value | code |\n|---:|:---|---|\n";
const tableRow = (k: number) => `| ${k} | **v${k}** and [l](https://x/${k}) | \`c${k}\` |\n`;

// One huge table of about `total` chars, `prefix` before each row's cells (a container marker).
function hugeTable(total: number, row = tableRow, prefix = ""): string {
  let out = TABLE_HEAD.replace(/^/gm, prefix).replace(new RegExp(`${prefix}$`), "");
  for (let k = 1; out.length < total; k++) out += prefix + row(k);
  return out;
}

describe("MarkdownChunker", () => {
  test("cuts a huge streaming list at item starts, so the open chunk stays small", () => {
    const full = hugeList(50_000, bulletLine);
    const chunker = new MarkdownChunker(2_000);
    let previous: readonly string[] = [];
    for (let end = 400; end < full.length + 997; end += 997) {
      const text = full.slice(0, Math.min(end, full.length));
      const chunks = chunker.update(text);
      expect(chunks.join("")).toBe(text);
      for (let i = 0; i < previous.length - 1; i++) expect(chunks[i]).toBe(previous[i]);
      expect(chunks.at(-1)!.length).toBeLessThanOrEqual(2_000);
      // Every chunk starts at an item.
      for (const chunk of chunks) expect(chunk.startsWith("- item ")).toBe(true);
      previous = chunks;
    }
    expect(previous.length).toBeGreaterThan(20);
    // Fed the prefixes in order, it cuts the same ranges as a chunker that sees the whole text.
    expect(new MarkdownChunker(2_000).update(full)).toEqual(previous);
    // Once complete, the list is one chunk again.
    expect(chunker.completedChunks()).toEqual([full]);
  });

  test("completed chunks join only the cut list and keep the other chunks", () => {
    const list = hugeList(8_000, bulletLine);
    const text = denseReply(8) + "\n\n" + list + "\nAfter the list.\n\n" + denseReply(8);
    const chunker = new MarkdownChunker(2_000);
    const chunks = chunker.update(text);
    const completed = chunker.completedChunks();
    expect(completed.join("")).toBe(text);
    expect(completed.length).toBeLessThan(chunks.length);
    const merged = completed.find((chunk) => chunk.includes("- item 1 ") && chunk.includes(list));
    expect(merged).toBeDefined();
    // Chunks that hold no list range are the same strings in both.
    const listChunks = chunks.filter((chunk) => chunk.includes("- item "));
    for (const chunk of chunks) {
      if (!listChunks.includes(chunk)) expect(completed).toContain(chunk);
    }
  });

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

  test("an open last block stays in the open chunk until a later block follows it", () => {
    const chunker = new MarkdownChunker(100);
    const intro = "Intro paragraph.\n\n";
    const fence = "```ts\n" + "const x = 1;\n".repeat(30);
    // The open fence is longer than a chunk but is still the last block: nothing after it seals.
    let chunks = chunker.update(intro + fence);
    expect(chunks.at(-1)).toContain("```ts");
    expect(chunks.at(-1)?.endsWith("const x = 1;\n")).toBe(true);

    const closed = intro + fence + "```\n\nAfter the fence.";
    chunks = chunker.update(closed);
    // Closed and followed by a paragraph: the fence is sealed, the paragraph is open.
    expect(chunks.at(-1)?.trim()).toBe("After the fence.");
    expect(chunks.slice(0, -1).join("").trimEnd().endsWith("```")).toBe(true);
    expect(chunks.join("")).toBe(closed);
  });

  // A container starts the block, so the block is not a table. Streamdown merges a footnote or
  // `$$` block with later blocks, so the block can hold more than the table. Both stay one chunk.
  test.each([
    ["inside a list item", `- item\n\n${hugeTable(6_000, tableRow, "  ")}`],
    ["inside a blockquote", hugeTable(6_000, tableRow, "> ")],
    ["inside an HTML block", `<div>\n${hugeTable(6_000)}</div>\n`],
    ["with a footnote", hugeTable(6_000, (k) => `| ${k} | v${k}[^1] | c |\n`) + "\n[^1]: Note.\n"],
    ["with $$", hugeTable(6_000, (k) => `| ${k} | $$x_${k}$$ | c |\n`)],
  ])("a table %s stays whole", (_where, text) => {
    for (let end = 200; end < text.length + 499; end += 499) {
      const prefix = text.slice(0, Math.min(end, text.length));
      expect(new MarkdownChunker(2_000).update(prefix)).toEqual([prefix]);
    }
  });

  test("a block whose text differs from the input is never sealed", () => {
    // Streamdown's blocks turn CRLF into LF, so they no longer match the input.
    const text = Array.from({ length: 20 }, (_, k) => `Paragraph ${k} text.`).join("\r\n\r\n");
    expect(new MarkdownChunker(40).update(text).join("")).toBe(text);
  });

  // #5664: a partial marker (`…\n\n30` before its `.`) must not seal the list before it, even when
  // the open range is close to the chunk size. Every chunk size puts some marker near a limit.
  test("a partial ordered marker at a chunk limit does not split the list", () => {
    const full = Array.from({ length: 40 }, (_, k) => `${k + 1}. Item ${k + 1} text`).join("\n\n");
    for (let maxChars = 60; maxChars <= 140; maxChars++) {
      const chunker = new MarkdownChunker(maxChars);
      for (let end = 1; end <= full.length; end++) chunker.update(full.slice(0, end));
      expect(chunker.completedChunks()).toEqual([full]);
    }
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

  test("a completed chunked reply with a huge table renders like one static render", async () => {
    const reply = `${denseReply(4)}\n\n${hugeTable(9_000)}\nAfter the table.\n\n${denseReply(4)}`;
    for (let end = 500; end < reply.length; end += 700) renderRow(reply.slice(0, end), true);
    renderRow(reply, false);
    await waitForText("Section 0");
    const single = renderSingle(reply);
    const rows = (element: Element) =>
      [...element.querySelectorAll("tr")].map((tr) => tr.textContent);
    expect(rows(single).length).toBeGreaterThan(100);
    expect(container.querySelectorAll("table")).toHaveLength(9);
    expect(rows(container)).toEqual(rows(single));
    expect(blockOutline(container)).toEqual(blockOutline(single));
  });

  // Tags, ordered starts and checkbox states: the structure a reader sees, minus chunk wrappers.
  function listOutline(element: Element): string[] {
    return [...element.querySelectorAll("ol, ul, li, li > p, input")].map((node) =>
      node.tagName === "INPUT"
        ? `INPUT:${(node as HTMLInputElement).checked}`
        : `${node.tagName}${node.getAttribute("start") ?? ""}`
    );
  }

  // Lists that are not nested inside another list's item.
  function topLevelLists(element: Element): Element[] {
    return [...element.querySelectorAll("ol, ul")].filter(
      (list) => list.parentElement?.closest("li") == null
    );
  }

  function renderRow(content: string, isStreaming: boolean) {
    flushSync(() =>
      root?.render(
        <ThemeProvider forcedTheme="dark">
          <ChunkedStreamingMarkdown content={content} isStreaming={isStreaming} />
        </ThemeProvider>
      )
    );
  }

  function renderSingle(content: string): HTMLElement {
    const single = document.createElement("div");
    document.body.appendChild(single);
    const singleRoot = createRoot(single);
    flushSync(() =>
      singleRoot.render(
        <ThemeProvider forcedTheme="dark">
          <MarkdownCore content={content} />
        </ThemeProvider>
      )
    );
    const copy = single.cloneNode(true) as HTMLElement;
    flushSync(() => singleRoot.unmount());
    single.remove();
    return copy;
  }

  async function waitForText(text: string) {
    for (let i = 0; i < 100 && !container.textContent?.includes(text); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  test("a huge list that mounts mid-stream shows its newest items in the first commit", () => {
    const list = hugeList(30_000, bulletLine);
    const lastItem = list
      .trimEnd()
      .split("\n")
      .at(-1)!
      .replace(/^- /, "")
      .replace(/\*\*|`/g, "");
    renderRow(list, true);
    expect(container.textContent).toContain(lastItem);
  });

  test("ordered ranges keep their numbers while the list streams", async () => {
    const list = hugeList(8_000, (k) => `${k + 6}. item ${k} with *em*\n`);
    renderRow(list, true);
    await waitForText("item 1 with");
    const lists = topLevelLists(container);
    expect(lists.length).toBeGreaterThan(1);
    // Each range starts where the one before it stopped.
    let next = 7;
    for (const ol of lists) {
      expect(ol.tagName).toBe("OL");
      expect(Number(ol.getAttribute("start") ?? "1")).toBe(next);
      next += ol.querySelectorAll(":scope > li").length;
    }
  });

  test.each([
    ["bullet", bulletLine],
    ["ordered from 7", (k: number) => `${k + 6}. item ${k} with *em*\n`],
    ["loose", (k: number) => `${k}. item ${k} paragraph text, lorem ipsum dolor\n\n`],
    ["nested", (k: number) => `- item ${k}\n  - child ${k}a\n    1. deep ${k}\n  - child ${k}b\n`],
    ["task", (k: number) => `- [${k % 3 === 0 ? "x" : " "}] task ${k} with **bold**\n`],
    // Every marker is `1.`: while streaming, each cut restarts at 1; once complete, one list.
    ["repeated-marker", (k: number) => `1. item ${k} with *em*\n`],
  ])(
    "a %s list cut while streaming renders as one list like a single render once complete",
    async (_kind, line) => {
      const list = hugeList(9_000, line);
      for (let end = 300; end < list.length; end += 450) renderRow(list.slice(0, end), true);
      renderRow(list, true);
      expect(topLevelLists(container).length).toBeGreaterThan(1);
      renderRow(list, false);
      await waitForText("item 1 ");

      const single = renderSingle(list);
      expect(topLevelLists(container)).toHaveLength(1);
      expect(listOutline(container)).toEqual(listOutline(single));
      expect(container.textContent?.replace(/\s+/g, "")).toBe(
        single.textContent?.replace(/\s+/g, "")
      );
    }
  );

  test("completion remounts the cut list but keeps the other chunks' DOM", async () => {
    const reply = denseReply(10) + "\n\nThe list:\n\n" + hugeList(8_000, bulletLine);
    renderRow(reply, true);
    await waitForText("Section 0");
    const firstHeading = container.querySelector("h2");
    expect(firstHeading?.textContent).toBe("Section 0");
    const firstListItem = [...container.querySelectorAll("li")].find((li) =>
      li.textContent?.startsWith("item 1 with")
    );
    expect(firstListItem).toBeDefined();

    renderRow(reply, false);
    await waitForText("item 1 with");
    expect(container.querySelector("h2")).toBe(firstHeading);
    expect(firstListItem!.isConnected).toBe(false);
    expect(
      topLevelLists(container).filter((list) => list.textContent?.includes("item 1 with"))
    ).toHaveLength(1);
  });

  // The stream ends while older chunks are still mounting, a few per frame. Completion joins the
  // cut list into one chunk, so every chunk after it moves to a lower index.
  test.each([
    // At least one sealed chunk after the list is mounted, but no list item yet.
    ["after the cut list", (row: Element) => row.children.length > 1 && !row.querySelector("li")],
    // Some ranges of the list are mounted, but not its first item.
    [
      "inside the cut list",
      (row: Element) => row.querySelector("li") !== null && !row.textContent?.includes("item 1 "),
    ],
  ])(
    "completion during the backfill, with the oldest mounted chunk %s, unmounts nothing",
    (_where, isOldestMounted) => {
      const paragraph = (k: number) =>
        `Paragraph ${k}: ${"lorem ipsum dolor sit amet ".repeat(24)}`;
      const after = Array.from({ length: 16 }, (_, k) => paragraph(k)).join("\n\n");
      const reply = `Intro.\n\n${hugeList(14_000, bulletLine)}\n${after}`;
      const frames: FrameRequestCallback[] = [];
      const originalRequest = globalThis.requestAnimationFrame;
      const originalCancel = globalThis.cancelAnimationFrame;
      globalThis.requestAnimationFrame = (callback) => frames.push(callback);
      globalThis.cancelAnimationFrame = (id) => {
        frames[id - 1] = () => undefined;
      };
      try {
        renderRow(reply, true);
        for (let next = 0; !isOldestMounted(container.firstElementChild!); next++) {
          expect(next).toBeLessThan(frames.length);
          flushSync(() => frames[next](0));
        }
        // Every mounted chunk but the open last one, which remounts when the stream ends (#5664).
        const visible = [...container.firstElementChild!.children].slice(0, -1);
        const sealedAfterList = visible.filter((chunk) => !chunk.querySelector("li"));
        expect(sealedAfterList.length).toBeGreaterThan(0);

        renderRow(reply, false);
        const text = container.textContent?.replace(/\s+/g, "");
        for (const chunk of visible) {
          expect(text).toContain(chunk.textContent.replace(/\s+/g, ""));
        }
        for (const chunk of sealedAfterList) expect(chunk.isConnected).toBe(true);
      } finally {
        globalThis.requestAnimationFrame = originalRequest;
        globalThis.cancelAnimationFrame = originalCancel;
      }
    }
  );

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
