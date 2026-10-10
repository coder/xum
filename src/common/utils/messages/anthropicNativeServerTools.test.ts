import { describe, expect, test } from "bun:test";
import type { DynamicToolPart } from "@/common/types/toolParts";
import { ANTHROPIC_NATIVE_SERVER_TOOL_MAX_ROW_CIPHERTEXT_CHARS } from "@/constants/anthropicServerTools";
import { rowCiphertextChars, toStoredServerToolPart } from "./anthropicNativeServerTools";

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
