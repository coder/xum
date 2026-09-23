import { describe, expect, it } from "bun:test";
import {
  MEMORY_INTUITION_EVAL_MAX_CHUNKS,
  MEMORY_INTUITION_MAX_EXCERPT_CHARS,
} from "@/common/constants/memory";
import { chunkMemoryText, pickChunks } from "./memoryIntuitionEvaluation";

describe("chunkMemoryText", () => {
  it("splits paragraphs and top-level bullets, carrying lone headings into the next block", () => {
    const text = [
      "# Title",
      "",
      "First paragraph",
      "continues here.",
      "",
      "- top bullet",
      "  - nested detail",
      "- second bullet",
      "1. numbered item",
      "",
      "## Alice",
      "",
      "### Contact",
      "- Lives in Paris",
      "",
      "## Heading with text",
      "Body under heading.",
      "",
      "## Trailing heading",
    ].join("\n");
    const chunks = chunkMemoryText(text);
    expect(chunks).toEqual([
      "# Title\n\nFirst paragraph\ncontinues here.",
      "- top bullet\n  - nested detail",
      "- second bullet",
      "1. numbered item",
      "## Alice\n\n### Contact\n\n- Lives in Paris",
      "## Heading with text\nBody under heading.",
    ]);
    // Joined headings still match the source up to whitespace, so excerpt checks accept them.
    const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
    for (const chunk of chunks) expect(normalize(text)).toContain(normalize(chunk));
  });

  it("windows long blocks at whitespace so text past the excerpt cap stays reachable", () => {
    const words = Array.from({ length: 700 }, (_, i) => `w${i}`);
    words[600] = "needle-passage";
    const block = `- ${words.join(" ")}`;
    expect(block.length).toBeGreaterThan(2 * MEMORY_INTUITION_MAX_EXCERPT_CHARS);
    const chunks = chunkMemoryText(`intro\n\n${block}`);
    expect(chunks[0]).toBe("intro");
    const windows = chunks.slice(1);
    expect(windows.length).toBeGreaterThan(2);
    for (const window of windows) {
      expect(window.length).toBeLessThanOrEqual(MEMORY_INTUITION_MAX_EXCERPT_CHARS);
      expect(block).toContain(window);
    }
    // Contiguous: consecutive windows rebuild the block, losing only the whitespace at cuts.
    expect(windows.join(" ")).toBe(block);
    const needleWindow = windows.findIndex((window) => window.includes("needle-passage"));
    expect(needleWindow).toBeGreaterThan(0);
    expect(block.indexOf("needle-passage")).toBeGreaterThan(MEMORY_INTUITION_MAX_EXCERPT_CHARS);
  });

  it("hard-cuts whitespace-free text without splitting a surrogate pair", () => {
    const block = "x".repeat(MEMORY_INTUITION_MAX_EXCERPT_CHARS - 1) + "😀" + "y".repeat(10);
    const chunks = chunkMemoryText(block);
    expect(chunks).toEqual([
      "x".repeat(MEMORY_INTUITION_MAX_EXCERPT_CHARS - 1),
      "😀" + "y".repeat(10),
    ]);
  });
});

describe("pickChunks", () => {
  const score = (text: string) => (text.includes("hit") ? 1 : 0);

  it("ranks each file's chunks by score with stable ties, then shares slots round-robin", () => {
    const picked = pickChunks(
      [
        { path: "/a", chunks: ["a0", "a1 hit", "a2"] },
        { path: "/b", chunks: ["b0"] },
        { path: "/c", chunks: ["c0", "c1"] },
      ],
      score
    );
    expect(picked).toEqual([
      { path: "/a", text: "a1 hit" },
      { path: "/b", text: "b0" },
      { path: "/c", text: "c0" },
      { path: "/a", text: "a0" },
      { path: "/c", text: "c1" },
      { path: "/a", text: "a2" },
    ]);
  });

  it("caps the total so a single large file cannot starve the others", () => {
    const big = Array.from({ length: 100 }, (_, i) => `big${i}`);
    const picked = pickChunks(
      [
        { path: "/big", chunks: big },
        { path: "/small", chunks: ["small hit"] },
      ],
      score
    );
    expect(picked).toHaveLength(MEMORY_INTUITION_EVAL_MAX_CHUNKS);
    expect(picked[1]).toEqual({ path: "/small", text: "small hit" });
    expect(picked.filter((chunk) => chunk.path === "/big").map((chunk) => chunk.text)).toEqual(
      big.slice(0, MEMORY_INTUITION_EVAL_MAX_CHUNKS - 1)
    );
  });
});
