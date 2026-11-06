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

  test("drops a text row carrying only control characters", () => {
    // A persisted U+0007 (BEL) is neither whitespace nor default-ignorable, so the class needs
    // \p{Cc} explicitly -- otherwise the same blank row survives.
    for (const control of ["\u0007", "\u0000", "\u001b[0m".slice(0, 1), "\n\u0007"]) {
      const displayed = rows([{ type: "text", text: control }, FAILED_BASH]);
      expect(displayed.map((row) => row.type)).toEqual(["tool"]);
    }
  });

  test("drops a text row made only of braille blank cells", () => {
    // U+2800 is braille's SPACE: a letter-like character that is not whitespace, default-ignorable
    // or a control, so none of the other classes catch it -- yet a run of them paints an empty gap.
    for (const blank of ["\u2800", "\u2800\u2800\u2800", " \u2800"]) {
      const displayed = rows([{ type: "text", text: blank }, FAILED_BASH]);
      expect(displayed.map((row) => row.type)).toEqual(["tool"]);
    }
  });

  test("keeps a braille passage, whose blank cells are spaces inside real content", () => {
    // \u2813\u2815\u2800\u280a spells "he l" -- dropping this would delete rendered text.
    const displayed = rows([{ type: "text", text: "\u2813\u2815\u2800\u280a" }, FAILED_BASH]);

    expect(displayed.map((row) => row.type)).toEqual(["assistant", "tool"]);
  });

  test("keeps content that merely contains invisible characters or emoji", () => {
    // ZWJ, variation selectors and skin-tone modifiers are default-ignorables or
    // marks, so a predicate over classes must not mistake the sequence for one.
    for (const visible of [
      "a\u200b",
      "\u2764\ufe0f",
      "\u00e9",
      "\ud83d\udc4d\udffb",
      "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc66",
      "\ud83c\udde6\ud83c\uddfa",
    ]) {
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

  test("hands last-part bookkeeping back to the tool row once the stream settles", () => {
    // Settled (no active stream): the trailing whitespace part renders no row, so
    // the tool row is the message's last rendered part and keeps the anchor flags
    // the empty row had taken.
    const settled = rows([FAILED_BASH, { type: "text", text: " " }]);
    expect(settled.map((row) => row.type)).toEqual(["tool"]);
    const toolRow = settled[0];
    expect(toolRow?.type).toBe("tool");
    if (toolRow?.type !== "tool") return;
    expect(toolRow.isLastPartOfMessage).toBe(true);
  });

  test("keeps the streaming trailing row mounted so deltas can reach it", () => {
    // While the stream is active the trailing part is what incoming deltas append
    // to. Omitting its row would leave no subscriber for WorkspaceStore's
    // row-local bump, so the visible text that arrives later would never render.
    const streaming = rows([FAILED_BASH, { type: "text", text: " " }], true);
    expect(streaming.map((row) => row.type)).toEqual(["tool", "assistant"]);
    const trailing = streaming[1];
    expect(trailing?.type).toBe("assistant");
    if (trailing?.type !== "assistant") return;
    expect(trailing.isLastPartOfMessage).toBe(true);
    expect(trailing.isStreaming).toBe(true);

    // Same parts once the stream ends: the invisible row goes away again, which is
    // the blank-line gap this change removes.
    expect(rows([FAILED_BASH, { type: "text", text: " " }]).map((row) => row.type)).toEqual([
      "tool",
    ]);
  });

  test("does not keep a paintable-empty row that is not the streaming tail", () => {
    // The whitespace part is followed by a tool part, so deltas append to the tool
    // part and nothing needs the empty row mounted.
    const streaming = rows([{ type: "text", text: "\n" }, FAILED_BASH], true);
    expect(streaming.map((row) => row.type)).toEqual(["tool"]);
  });
});

describe("buildDisplayedMessagesForMessage unicode-tag text parts", () => {
  // Tag characters (U+E0020-U+E007F) are default-ignorables, so they paint nothing -- but they map
  // onto ASCII and the provider request path keeps them (`dropEmptyText` is trim()-based, and
  // OpenAI/Google skip that filter entirely). Dropping the row would hide instructions the model
  // still received, so the row stays; the render leaves are what reveal the tags as visible marks.
  const tags = (ascii: string) =>
    [...ascii].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");

  test("keeps a tag-only row that would otherwise draw nothing", () => {
    const displayed = rows([{ type: "text", text: tags("AB") }, FAILED_BASH]);

    expect(displayed.map((row) => row.type)).toEqual(["assistant", "tool"]);
  });

  test("leaves row content byte-identical so Copy and Edit cannot corrupt it", () => {
    // The defect this pins: the row's content is the field Copy and Edit read, and a revealed
    // `<U+XXXX>` mark is irreversible, so editing such a row persisted 8 ASCII characters per
    // invisible character in place of the user's text. The reveal belongs to the render leaves.
    const text = `continue${tags("XY")}`;
    const displayed = rows([{ type: "text", text }, FAILED_BASH]);

    expect(displayed[0]?.type === "assistant" ? displayed[0].content : null).toBe(text);
  });

  test("leaves user row content byte-identical as well", () => {
    const text = tags("AB");
    const displayed = buildDisplayedMessagesForMessage({
      message: createMuxMessage("u1", "user", "", undefined, [{ type: "text", text }]),
      hasActiveStream: false,
      isContextBoundaryMessage: () => false,
    });

    expect(displayed[0]?.type).toBe("user");
    expect(displayed[0]?.type === "user" ? displayed[0].content : null).toBe(text);
  });

  test("keeps a subdivision-flag emoji byte-identical", () => {
    // A subdivision flag IS black flag + a tag sequence + cancel: its tags are the emoji.
    const subdivisionFlag = (region: string) => `\u{1F3F4}${tags(region)}\u{E007F}`;
    for (const region of ["gbeng", "gbsct", "gbwls"]) {
      const flag = subdivisionFlag(region);
      const displayed = rows([{ type: "text", text: `ship ${flag}` }, FAILED_BASH]);
      expect(displayed[0]?.type === "assistant" ? displayed[0].content : null).toBe(`ship ${flag}`);
    }
  });

  test("keeps a row for a payload disguised as a non-RGI flag, which no font draws", () => {
    // Only gbeng/gbsct/gbwls are RGI. A black flag plus other tags renders as a plain black flag,
    // so its tags are a hidden payload: the row must stay visible rather than look like an emoji.
    const disguised = `\u{1F3F4}${tags("usca")}\u{E007F}`;
    const displayed = rows([{ type: "text", text: disguised }, FAILED_BASH]);

    expect(displayed.map((row) => row.type)).toEqual(["assistant", "tool"]);
  });

  test("keeps a row for a payload hidden alongside a real subdivision flag", () => {
    const flag = `\u{1F3F4}${tags("gbeng")}\u{E007F}`;
    const text = `${flag}${tags("AB")}`;
    const displayed = rows([{ type: "text", text }, FAILED_BASH]);

    expect(displayed[0]?.type === "assistant" ? displayed[0].content : null).toBe(text);
  });

  test("keeps a message that is nothing but a subdivision flag", () => {
    // The black-flag base is not default-ignorable, so the flag paints and the row must survive
    // even when nothing else in the message does.
    const flag = `\u{1F3F4}${tags("gbwls")}\u{E007F}`;
    const displayed = rows([{ type: "text", text: flag }, FAILED_BASH]);

    expect(displayed.map((row) => row.type)).toEqual(["assistant", "tool"]);
    expect(displayed[0]?.type === "assistant" ? displayed[0].content : null).toBe(flag);
  });
});
