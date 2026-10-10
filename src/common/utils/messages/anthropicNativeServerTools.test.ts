import { describe, expect, test } from "bun:test";
import type { DynamicToolPart } from "@/common/types/toolParts";
import { ANTHROPIC_NATIVE_SERVER_TOOL_MAX_ROW_CIPHERTEXT_CHARS } from "@/constants/anthropicServerTools";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  isNativeAnthropicReplayable,
  projectAnthropicServerTools,
  rowCiphertextChars,
  toStoredServerToolPart,
} from "./anthropicNativeServerTools";

/** A completed Anthropic web_search part whose results carry these ciphertext lengths. */
function webSearchPart(id: string, ciphertextLengths: number[]): DynamicToolPart {
  return {
    type: "dynamic-tool",
    toolCallId: id,
    toolName: "web_search",
    state: "output-available",
    input: { query: "xum" },
    providerExecuted: true,
    output: ciphertextLengths.map((length, index) => ({
      type: "web_search_result",
      url: `https://example.com/${index}`,
      title: "Xum",
      pageAge: null,
      encryptedContent: "e".repeat(length),
    })),
  };
}

function hasCiphertext(part: DynamicToolPart): boolean {
  return part.state === "output-available" && JSON.stringify(part.output).includes("eee");
}

/** Stores the parts in order, the way StreamManager completes them within one row. */
function storeRow(parts: DynamicToolPart[]): DynamicToolPart[] {
  const stored: DynamicToolPart[] = [];
  for (const part of parts) {
    stored.push(
      toStoredServerToolPart(part, {
        resultFollowsCall: true,
        rowCiphertextChars: rowCiphertextChars(stored),
      })
    );
  }
  return stored;
}

describe("toStoredServerToolPart ciphertext bound (#5887)", () => {
  const limit = ANTHROPIC_NATIVE_SERVER_TOOL_MAX_ROW_CIPHERTEXT_CHARS;

  test("keeps native replay when the row's summed ciphertext is at the limit", () => {
    // Three results over two calls: the bound sums every result of every search in the row.
    const row = storeRow([
      webSearchPart("srvtoolu_1", [limit - 30, 10]),
      webSearchPart("srvtoolu_2", [20]),
    ]);
    expect(row.map((part) => part.providerExecuted)).toEqual([true, true]);
    expect(row.every(hasCiphertext)).toBe(true);
    expect(rowCiphertextChars(row)).toBe(limit);
  });

  test("stores the search that crosses the limit as the client pair without ciphertext", () => {
    const row = storeRow([
      webSearchPart("srvtoolu_1", [limit - 30, 10]),
      webSearchPart("srvtoolu_2", [21]),
      // A later small search still fits: only the ciphertext kept counts.
      webSearchPart("srvtoolu_3", [20]),
    ]);
    expect(row.map((part) => part.providerExecuted)).toEqual([true, undefined, true]);
    expect(hasCiphertext(row[1])).toBe(false);
    // The search itself stays in history (URLs and titles), only the ciphertext is dropped.
    expect(row[1].state === "output-available" && Array.isArray(row[1].output)).toBe(true);
    expect(rowCiphertextChars(row)).toBe(limit);
  });
});

describe("isNativeAnthropicReplayable fields (#5887)", () => {
  // Native replay sends every field back as the API returned it, so a field the generic
  // provider-output sanitizer would rewrite (too long, control text) cannot replay natively.
  function withTitle(title: string): DynamicToolPart {
    const part = webSearchPart("srvtoolu_1", [10]);
    if (part.state !== "output-available" || !Array.isArray(part.output)) throw new Error("setup");
    return { ...part, output: [{ ...(part.output[0] as object), title }] };
  }

  test("a plain title replays natively", () => {
    expect(isNativeAnthropicReplayable(withTitle("Xum"))).toBe(true);
  });

  test("a title the sanitizer would rewrite does not", () => {
    expect(isNativeAnthropicReplayable(withTitle("t".repeat(12_001)))).toBe(false);
    expect(isNativeAnthropicReplayable(withTitle("bad\u0000title"))).toBe(false);
  });
});

describe("projectAnthropicServerTools demotion across rows (#5887)", () => {
  // Preserved thinking binds each thinking block to everything before it, earlier rows too.
  function rows(): MuxMessage[] {
    return [
      createMuxMessage("user-1", "user", "search", { historySequence: 0 }),
      createMuxMessage("assistant-1", "assistant", "", { historySequence: 1 }, [
        webSearchPart("srvtoolu_1", [10]),
        { type: "text", text: "found" },
      ]),
      createMuxMessage("user-2", "user", "more", { historySequence: 2 }),
      createMuxMessage("assistant-2", "assistant", "", { historySequence: 3 }, [
        { type: "reasoning", text: "read", providerOptions: { anthropic: { signature: "sig" } } },
        { type: "text", text: "done" },
      ]),
    ];
  }

  test("thinking in a later row after a demoted search strips thinking", () => {
    expect(projectAnthropicServerTools(rows(), false).demotedBeforeThinking).toBe(true);
  });

  test("the same rows replayed natively keep thinking", () => {
    expect(projectAnthropicServerTools(rows(), true).demotedBeforeThinking).toBe(false);
  });
});
