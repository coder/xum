import { describe, expect, test } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { buildDisplayedMessagesForMessage } from "./displayedMessageBuilder";

/**
 * Local models (Qwen via oMLX) emit a whitespace-only text part between
 * reasoning and each tool call. It must not render as an empty assistant row
 * or take last-part status from the row before it.
 */
function build(parts: MuxMessage["parts"], hasActiveStream: boolean) {
  const message = createMuxMessage("m1", "assistant", "", undefined, parts);
  return buildDisplayedMessagesForMessage({
    message,
    hasActiveStream,
    isContextBoundaryMessage: () => false,
  });
}

describe("buildDisplayedMessagesForMessage whitespace-only text parts", () => {
  test("settled message hides whitespace-only text between reasoning and a tool", () => {
    const rows = build(
      [
        { type: "reasoning", text: "\nPlan.\n" },
        { type: "text", text: "\n\n" },
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          state: "output-available",
          input: { script: "ls" },
          output: { success: true, output: "a" },
        },
        { type: "reasoning", text: "\nWrap up.\n" },
        { type: "text", text: "\n\nDone." },
      ],
      false
    );

    expect(rows.map((row) => row.type)).toEqual(["reasoning", "tool", "reasoning", "assistant"]);
    const assistant = rows[3];
    if (assistant?.type !== "assistant") throw new Error("expected assistant row");
    expect(assistant.content).toBe("\n\nDone.");
    expect(rows.filter((row) => "isLastPartOfMessage" in row && row.isLastPartOfMessage)).toEqual([
      assistant,
    ]);
  });

  test("streaming reasoning keeps last-part status when whitespace text follows it", () => {
    const rows = build(
      [
        { type: "reasoning", text: "\nThinking.\n" },
        { type: "text", text: "\n\n" },
      ],
      true
    );

    expect(rows.map((row) => row.type)).toEqual(["reasoning"]);
    const reasoning = rows[0];
    if (reasoning?.type !== "reasoning") throw new Error("expected reasoning row");
    expect(reasoning.isStreaming).toBe(true);
    expect(reasoning.isLastPartOfMessage).toBe(true);
    // Reasoning-only status keeps the row out of operational bundles, as it
    // would be without the whitespace part.
    expect(reasoning.isOnlyMessageContent).toBe(true);
  });

  test("a corrupted text part without text renders no row instead of crashing", () => {
    // A lone part skips mergeAdjacentParts, so the builder sees the raw row.
    const corruptedPart: unknown = { type: "text" };
    const rows = build([corruptedPart as MuxMessage["parts"][number]], false);

    expect(rows).toEqual([]);
  });
});
