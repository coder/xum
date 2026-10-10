import { describe, expect, test } from "bun:test";
import type { DynamicToolPart } from "@/common/types/toolParts";
import { ANTHROPIC_NATIVE_SERVER_TOOL_MAX_CIPHERTEXT_CHARS } from "@/constants/anthropicServerTools";
import { toStoredServerToolPart } from "./anthropicNativeServerTools";

/** A completed Anthropic web_search part whose results carry these ciphertext lengths. */
function webSearchPart(ciphertextLengths: number[]): DynamicToolPart {
  return {
    type: "dynamic-tool",
    toolCallId: "srvtoolu_1",
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

describe("toStoredServerToolPart ciphertext bound (#5887)", () => {
  const limit = ANTHROPIC_NATIVE_SERVER_TOOL_MAX_CIPHERTEXT_CHARS;

  test("keeps native replay when the summed ciphertext is at the limit", () => {
    // Two results: the bound is per call, not per result.
    const stored = toStoredServerToolPart(webSearchPart([limit - 10, 10]), {
      resultFollowsCall: true,
    });
    expect(stored.providerExecuted).toBe(true);
    expect(hasCiphertext(stored)).toBe(true);
  });

  test("stores the client pair without ciphertext above the limit", () => {
    const stored = toStoredServerToolPart(webSearchPart([limit - 10, 11]), {
      resultFollowsCall: true,
    });
    expect(stored.providerExecuted).toBeUndefined();
    expect(hasCiphertext(stored)).toBe(false);
    // The search itself stays in history (URLs and titles), only the ciphertext is dropped.
    expect(stored.state === "output-available" && Array.isArray(stored.output)).toBe(true);
  });
});
