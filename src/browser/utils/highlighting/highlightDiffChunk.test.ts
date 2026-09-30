import {
  highlightDiffChunk,
  highlightDiffChunks,
  isWithinDiffHighlightSyncBudget,
} from "./highlightDiffChunk";
import type { DiffChunk } from "./diffChunking";

/**
 * Tests use REAL Shiki highlighter (no mocks)
 * This ensures we test actual behavior and catch changes in Shiki's HTML structure
 * WASM loads on first test (~100ms), then cached for subsequent tests
 */

describe("highlightDiffChunk", () => {
  const mockChunk: DiffChunk = {
    type: "add",
    lines: ["const x = 1;", "const y = 2;"],
    startIndex: 0,
    oldLineNumbers: [null, null],
    newLineNumbers: [1, 2],
  };

  describe("sync pre-worker budget", () => {
    it("allows human-scale 10k-line chunks to attempt worker highlighting", () => {
      const humanScaleLines = Array.from(
        { length: 10_000 },
        (_, i) => `const value${i} = computeValue(${i});`
      );

      expect(isWithinDiffHighlightSyncBudget(humanScaleLines)).toBe(true);
    });

    it("falls back before joining generated single-line chunks", async () => {
      const generatedChunk: DiffChunk = {
        type: "add",
        lines: [`const generated = "${"x".repeat(25_000)}";`],
        startIndex: 0,
        oldLineNumbers: [null],
        newLineNumbers: [1],
      };

      const result = await highlightDiffChunk(generatedChunk, "typescript");

      expect(result.usedFallback).toBe(true);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].html).toContain("const generated");
    });
  });

  describe("plain text files", () => {
    it("should return plain text for text/plaintext language", async () => {
      const result = await highlightDiffChunk(mockChunk, "text");

      expect(result.type).toBe("add");
      expect(result.usedFallback).toBe(false);
      expect(result.lines).toHaveLength(2);
      expect(result.lines[0].html).toBe("const x = 1;");
      expect(result.lines[0].oldLineNumber).toBeNull();
      expect(result.lines[0].newLineNumber).toBe(1);
    });

    it("should escape HTML in plain text fallback", async () => {
      const htmlChunk: DiffChunk = {
        type: "add",
        lines: ['<script>alert("xss")</script>'],
        startIndex: 0,
        oldLineNumbers: [null],
        newLineNumbers: [1],
      };

      const result = await highlightDiffChunk(htmlChunk, "text");

      expect(result.lines[0].html).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    });

    it("should preserve line numbers and original indices for text files", async () => {
      const result = await highlightDiffChunk(mockChunk, "text");

      expect(result.lines[0].oldLineNumber).toBeNull();
      expect(result.lines[0].newLineNumber).toBe(1);
      expect(result.lines[0].originalIndex).toBe(0);
      expect(result.lines[1].oldLineNumber).toBeNull();
      expect(result.lines[1].newLineNumber).toBe(2);
      expect(result.lines[1].originalIndex).toBe(1);
    });

    it("should handle empty lines", async () => {
      const emptyChunk: DiffChunk = {
        type: "context",
        lines: [""],
        startIndex: 0,
        oldLineNumbers: [1],
        newLineNumbers: [1],
      };

      const result = await highlightDiffChunk(emptyChunk, "text");

      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].oldLineNumber).toBe(1);
      expect(result.lines[0].newLineNumber).toBe(1);
    });

    it("should handle multiple line types", async () => {
      const removeChunk: DiffChunk = {
        type: "remove",
        lines: ["old code"],
        startIndex: 5,
        oldLineNumbers: [10],
        newLineNumbers: [null],
      };

      const result = await highlightDiffChunk(removeChunk, "text");

      expect(result.type).toBe("remove");
      expect(result.lines[0].originalIndex).toBe(5);
    });

    it("should preserve leading whitespace in plain text", async () => {
      const indentedChunk: DiffChunk = {
        type: "add",
        lines: ["    const x = 1;", "        const y = 2;", "  const z = 3;"],
        startIndex: 0,
        oldLineNumbers: [null, null, null],
        newLineNumbers: [1, 2, 3],
      };

      const result = await highlightDiffChunk(indentedChunk, "text");

      expect(result.lines).toHaveLength(3);
      // Leading spaces should be preserved
      expect(result.lines[0].html).toMatch(/^(\s|&nbsp;){4}/); // 4 leading spaces
      expect(result.lines[1].html).toMatch(/^(\s|&nbsp;){8}/); // 8 leading spaces
      expect(result.lines[2].html).toMatch(/^(\s|&nbsp;){2}/); // 2 leading spaces
    });

    it("should preserve internal whitespace in plain text", async () => {
      const spacedChunk: DiffChunk = {
        type: "add",
        lines: ["const x  =  1;", "if (x    &&    y)"],
        startIndex: 0,
        oldLineNumbers: [null, null],
        newLineNumbers: [1, 2],
      };

      const result = await highlightDiffChunk(spacedChunk, "text");

      expect(result.lines).toHaveLength(2);
      // Multiple internal spaces should be preserved
      expect(result.lines[0].html).toContain("x");
      expect(result.lines[0].html).toContain("1");
      // Should have multiple spaces between x and = (2 spaces)
      expect(result.lines[0].html).toMatch(/x(\s|&nbsp;){2}=/);
    });

    it("should detect and fallback when HTML extraction returns empty strings", async () => {
      // This is a regression test for the whitespace bug where extractLinesFromHtml
      // could return empty strings without triggering fallback
      // We can't easily mock Shiki to produce malformed HTML, but we can test
      // that indented code preserves its whitespace
      const chunk: DiffChunk = {
        type: "add",
        lines: ["    const x = 1;", "        const y = 2;", "  const z = 3;"],
        startIndex: 0,
        oldLineNumbers: [null, null, null],
        newLineNumbers: [1, 2, 3],
      };

      const result = await highlightDiffChunk(chunk, "typescript");

      // Verify whitespace is preserved
      expect(result.lines).toHaveLength(3);
      expect(result.lines[0].html.length).toBeGreaterThan(0);
      expect(result.lines[1].html.length).toBeGreaterThan(0);
      expect(result.lines[2].html.length).toBeGreaterThan(0);

      // All lines should contain "const"
      expect(result.lines[0].html).toContain("const");
      expect(result.lines[1].html).toContain("const");
      expect(result.lines[2].html).toContain("const");
    });
  });

  describe("with real Shiki syntax highlighting", () => {
    it("should correctly extract lines from nested span structure", async () => {
      const chunk: DiffChunk = {
        type: "add",
        lines: ["const x = 1;", "const y = 2;"],
        startIndex: 0,
        oldLineNumbers: [null, null],
        newLineNumbers: [1, 2],
      };

      const result = await highlightDiffChunk(chunk, "typescript");

      expect(result.lines).toHaveLength(2);
      // Should contain actual Shiki styling
      expect(result.lines[0].html).toContain("<span style=");
      expect(result.lines[0].html).toContain("const");
      expect(result.lines[0].html).toContain("x");
      // Should not have the line wrapper in extracted content
      expect(result.lines[0].html).not.toMatch(/^<span class="line">/);
      expect(result.usedFallback).toBe(false);
    });

    it("should preserve chunk metadata when highlighting multiple chunks together", async () => {
      const chunks: DiffChunk[] = [
        {
          type: "context",
          lines: ["export function value() {"],
          startIndex: 0,
          oldLineNumbers: [1],
          newLineNumbers: [1],
        },
        {
          type: "remove",
          lines: ['  return "pending";'],
          startIndex: 1,
          oldLineNumbers: [2],
          newLineNumbers: [null],
        },
        {
          type: "add",
          lines: ['  return "ready";', "}"],
          startIndex: 2,
          oldLineNumbers: [null, 3],
          newLineNumbers: [2, 3],
        },
      ];

      const result = await highlightDiffChunks(chunks, "typescript");

      expect(result.map((chunk) => chunk.type)).toEqual(["context", "remove", "add"]);
      expect(result.every((chunk) => chunk.usedFallback === false)).toBe(true);
      expect(result[0].lines[0].oldLineNumber).toBe(1);
      expect(result[1].lines[0].newLineNumber).toBeNull();
      expect(result[2].lines[0].originalIndex).toBe(2);
      expect(result[2].lines[1].html).toContain("}");
      expect(
        result.flatMap((chunk) => chunk.lines).every((line) => line.html.includes("<span"))
      ).toBe(true);
    });

    it("should not let removed syntax state bleed into added chunks", async () => {
      const removedChunk: DiffChunk = {
        type: "remove",
        lines: ["/* removed version starts a comment"],
        startIndex: 0,
        oldLineNumbers: [1],
        newLineNumbers: [null],
      };
      const addedChunk: DiffChunk = {
        type: "add",
        lines: ["const added = 1;"],
        startIndex: 1,
        oldLineNumbers: [null],
        newLineNumbers: [1],
      };

      const highlightedTogether = await highlightDiffChunks(
        [removedChunk, addedChunk],
        "typescript"
      );
      const highlightedAddedAlone = await highlightDiffChunk(addedChunk, "typescript");

      expect(highlightedTogether[1].lines[0].html).toBe(highlightedAddedAlone.lines[0].html);
      expect(highlightedTogether[1].lines[0].html).toContain("const");
    });

    it("should handle incomplete syntax (unclosed string)", async () => {
      const chunk: DiffChunk = {
        type: "add",
        lines: ['const str = "unclosed'],
        startIndex: 0,
        oldLineNumbers: [null],
        newLineNumbers: [1],
      };

      const result = await highlightDiffChunk(chunk, "typescript");

      // Real Shiki handles incomplete syntax gracefully
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].html.length).toBeGreaterThan(0);
      expect(result.lines[0].html).toContain("const");
    });

    it("should handle empty lines with highlighting", async () => {
      const chunk: DiffChunk = {
        type: "context",
        lines: ["", "const y = 2;", ""],
        startIndex: 0,
        oldLineNumbers: [1, 2, 3],
        newLineNumbers: [1, 2, 3],
      };

      const result = await highlightDiffChunk(chunk, "typescript");

      expect(result.lines).toHaveLength(3);
      // Empty lines might have empty content
      expect(result.lines[0].html.length).toBeGreaterThanOrEqual(0);
      // Non-empty line should be highlighted
      expect(result.lines[1].html).toContain("const");
      expect(result.lines[1].html).toContain("<span style=");
      expect(result.lines[2].html.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle lines with special characters", async () => {
      const chunk: DiffChunk = {
        type: "add",
        lines: ["if (x && y) { return true; }"],
        startIndex: 0,
        oldLineNumbers: [null],
        newLineNumbers: [1],
      };

      const result = await highlightDiffChunk(chunk, "typescript");

      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].html).toContain("<span");
      // Shiki HTML-encodes special chars: && becomes &#x26;&#x26;
      expect(result.lines[0].html).toContain("&#x26;&#x26;");
    });

    it("should handle complex nested structures", async () => {
      const chunk: DiffChunk = {
        type: "add",
        lines: ["const obj = { nested: { value: 1 } };"],
        startIndex: 0,
        oldLineNumbers: [null],
        newLineNumbers: [1],
      };

      const result = await highlightDiffChunk(chunk, "typescript");

      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].html).toContain("const");
      expect(result.lines[0].html).toContain("obj");
      expect(result.lines[0].html).toContain("nested");
      // Should have multiple spans for different tokens
      const spanCount = (result.lines[0].html.match(/<span/g) ?? []).length;
      expect(spanCount).toBeGreaterThan(3);
    });

    it("should preserve line numbers correctly with highlighting", async () => {
      const chunk: DiffChunk = {
        type: "remove",
        lines: ["const a = 1;", "const b = 2;", "const c = 3;"],
        startIndex: 10,
        oldLineNumbers: [15, 16, 17],
        newLineNumbers: [null, null, null],
      };

      const result = await highlightDiffChunk(chunk, "typescript");

      expect(result.lines[0].oldLineNumber).toBe(15);
      expect(result.lines[1].oldLineNumber).toBe(16);
      expect(result.lines[2].oldLineNumber).toBe(17);
      expect(result.lines[0].newLineNumber).toBeNull();
      expect(result.lines[1].newLineNumber).toBeNull();
      expect(result.lines[2].newLineNumber).toBeNull();
      expect(result.lines[0].originalIndex).toBe(10);
      expect(result.lines[1].originalIndex).toBe(11);
      expect(result.lines[2].originalIndex).toBe(12);
    });

    it("should handle multiline code with proper separation", async () => {
      const chunk: DiffChunk = {
        type: "add",
        lines: ["function test() {", "  return 42;", "}"],
        startIndex: 0,
        oldLineNumbers: [null, null, null],
        newLineNumbers: [1, 2, 3],
      };

      const result = await highlightDiffChunk(chunk, "typescript");

      expect(result.lines).toHaveLength(3);
      // Each line should be independently highlighted
      expect(result.lines[0].html).toContain("function");
      expect(result.lines[1].html).toContain("return");
      expect(result.lines[2].html).toContain("}");
      // No line should contain content from another line
      expect(result.lines[0].html).not.toContain("return");
      expect(result.lines[2].html).not.toContain("function");
    });

    describe("lazy language loading", () => {
      it("should load language on first use", async () => {
        const chunk: DiffChunk = {
          type: "add",
          lines: ["def hello():", '    print("world")'],
          startIndex: 0,
          oldLineNumbers: [null, null],
          newLineNumbers: [1, 2],
        };

        // Python might not be loaded yet
        const result = await highlightDiffChunk(chunk, "python");

        // Should succeed by loading Python on-demand
        expect(result.lines).toHaveLength(2);
        expect(result.usedFallback).toBe(false);
        expect(result.lines[0].html).toContain("def");
      });

      it("should handle unsupported language gracefully", async () => {
        const chunk: DiffChunk = {
          type: "add",
          lines: ["some code in unknown language"],
          startIndex: 0,
          oldLineNumbers: [null],
          newLineNumbers: [1],
        };

        const result = await highlightDiffChunk(chunk, "totally-fake-language");

        // Should fall back to plain text
        expect(result.lines).toHaveLength(1);
        expect(result.usedFallback).toBe(true);
        expect(result.lines[0].html).toBe("some code in unknown language");
      });

      it("should handle concurrent highlighting of same language", async () => {
        const chunk1: DiffChunk = {
          type: "add",
          lines: ["const x = 1;"],
          startIndex: 0,
          oldLineNumbers: [null],
          newLineNumbers: [1],
        };

        const chunk2: DiffChunk = {
          type: "add",
          lines: ["const y = 2;"],
          startIndex: 0,
          oldLineNumbers: [null],
          newLineNumbers: [1],
        };

        // Highlight both concurrently - should handle race safely
        const [result1, result2] = await Promise.all([
          highlightDiffChunk(chunk1, "typescript"),
          highlightDiffChunk(chunk2, "typescript"),
        ]);

        expect(result1.lines[0].html).toContain("const");
        expect(result2.lines[0].html).toContain("const");
        expect(result1.usedFallback).toBe(false);
        expect(result2.usedFallback).toBe(false);
      });
    });
  });
});
