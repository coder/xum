import { describe, expect, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";
import { buildDisplayedMessagesForMessage } from "./displayedMessageBuilder";

/**
 * A failed tool call draws the eye, so the gap left by a whitespace-only text delta is most
 * visible right above it. The provider request path already drops those parts
 * (`dropEmptyText` in modelMessageTransform); these assert the transcript agrees.
 */
function rows(parts: Parameters<typeof createMuxMessage>[4], hasActiveStream = false) {
  return buildDisplayedMessagesForMessage({
    message: createMuxMessage("m1", "assistant", "", undefined, parts),
    hasActiveStream,
    isContextBoundaryMessage: () => false,
  });
}

const FAILED_BASH = {
  type: "dynamic-tool" as const,
  toolCallId: "bash-1",
  toolName: "bash",
  state: "output-available" as const,
  input: { script: "cargo build", model_intent: "Building the workspace", timeout_secs: 60 },
  output: { error: "exit status 101", success: false },
};

describe("buildDisplayedMessagesForMessage whitespace-only text parts", () => {
  test("drops a whitespace-only text row that would sit above a failed tool row", () => {
    const displayed = rows([{ type: "text", text: "\n" }, FAILED_BASH]);

    expect(displayed.map((row) => row.type)).toEqual(["tool"]);
    expect(displayed[0]?.type).toBe("tool");
  });

  test("drops a text row that carries only invisible characters", () => {
    // trim() keeps these, so a whitespace test alone would pass while the gap survived.
    for (const invisible of ["\u200b", "\u2060", "\ufeff", "\n\u200b"]) {
      const displayed = rows([{ type: "text", text: invisible }, FAILED_BASH]);
      expect(displayed.map((row) => row.type)).toEqual(["tool"]);
    }
  });

  test("keeps content that merely contains invisible characters or emoji", () => {
    for (const visible of ["a\u200b", "\u2764\ufe0f", "\u00e9"]) {
      const displayed = rows([{ type: "text", text: visible }, FAILED_BASH]);
      expect(displayed.map((row) => row.type)).toEqual(["assistant", "tool"]);
    }
  });

  test("keeps a standalone mark that paints without a base character", () => {
    // Spacing marks (Mc) and enclosing marks (Me) render on their own, and a
    // message about Unicode is legitimate output, so the predicate must not
    // classify all of \p{M} as unpaintable.
    for (const mark of ["\u0903", "\u093e", "\u20e2"]) {
      const displayed = rows([{ type: "text", text: mark }, FAILED_BASH]);
      expect(displayed.map((row) => row.type)).toEqual(["assistant", "tool"]);
    }
  });

  test("does not orphan a mark that arrives in its own delta", () => {
    // Adjacent text deltas merge before the predicate sees them, so the base
    // character carries the mark's row instead of it becoming a row of its own.
    const displayed = rows([
      { type: "text", text: "e" },
      { type: "text", text: "\u0301" },
      FAILED_BASH,
    ]);

    expect(displayed.map((row) => row.type)).toEqual(["assistant", "tool"]);
    // Concatenated, not normalized: the point is the single row, so the mark
    // travels with its base instead of being judged on its own.
    expect(displayed[0]?.type === "assistant" ? displayed[0].content : null).toBe("e\u0301");
  });

  test("keeps a text row that carries content", () => {
    const displayed = rows([{ type: "text", text: "Building now\n" }, FAILED_BASH]);

    expect(displayed.map((row) => row.type)).toEqual(["assistant", "tool"]);
  });

  test("hands last-part bookkeeping back to the tool row after a trailing whitespace part", () => {
    const withWhitespace = rows([FAILED_BASH, { type: "text", text: " " }], true);

    // The whitespace row is gone, so the tool row is the message's last rendered part again:
    // it keeps the streaming/anchor flags the empty row had taken.
    expect(withWhitespace.map((row) => row.type)).toEqual(["tool"]);
    const toolRow = withWhitespace[0];
    expect(toolRow?.type).toBe("tool");
    if (toolRow?.type !== "tool") return;
    expect(toolRow.isLastPartOfMessage).toBe(true);
  });
});
