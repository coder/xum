import { describe, expect, it } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import { trimCompactionInput } from "./trimCompactionInput";

const COMPACTION_REQUEST = createMuxMessage("request", "user", "Summarize the conversation.");

function toolTurn(id: string, outputChars: number): MuxMessage[] {
  return [
    createMuxMessage(`${id}-user`, "user", `question ${id}`),
    {
      id: `${id}-assistant`,
      role: "assistant",
      parts: [
        { type: "reasoning", text: `thinking ${id}`, signature: `sig-${id}` },
        {
          type: "dynamic-tool",
          toolCallId: `${id}-call`,
          toolName: "file_read",
          input: { path: `${id}.ts` },
          state: "output-available",
          output: { success: true, content: "x".repeat(outputChars) },
        },
        { type: "text", text: `answer ${id}` },
      ],
    },
  ];
}

function tokensOf(messages: MuxMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMuxMessageTokens(message), 0);
}

function outputOf(messages: MuxMessage[], id: string): unknown {
  const part = messages
    .find((message) => message.id === `${id}-assistant`)
    ?.parts.find((p) => p.type === "dynamic-tool");
  return part?.type === "dynamic-tool" && part.state === "output-available"
    ? part.output
    : undefined;
}

describe("trimCompactionInput", () => {
  it("returns the same array when the history fits", () => {
    const messages = [...toolTurn("a", 4_000), ...toolTurn("b", 4_000), COMPACTION_REQUEST];
    const trim = trimCompactionInput(messages, tokensOf(messages));
    expect(trim.messages).toBe(messages);
    expect(trim.omittedToolResults + trim.omittedTurns).toBe(0);
  });

  it("replaces the oldest tool results first and keeps every call with a result", () => {
    const messages = [...toolTurn("a", 40_000), ...toolTurn("b", 40_000), ...toolTurn("c", 400)];
    messages.push(COMPACTION_REQUEST);
    // Room for one large result: only the oldest one becomes a placeholder.
    const trim = trimCompactionInput(messages, 12_000 + 1_000);

    expect(trim).toMatchObject({ omittedToolResults: 1, omittedTurns: 0 });
    expect(outputOf(trim.messages, "a")).toMatch(/^\[Tool result omitted .* about \d+ tokens\]$/);
    expect(outputOf(trim.messages, "b")).toEqual({ success: true, content: "x".repeat(40_000) });
    for (const message of trim.messages) {
      for (const part of message.parts) {
        if (part.type === "dynamic-tool") expect(part.state).toBe("output-available");
        // Thinking is bound to the prefix the trim just changed.
        expect(part.type).not.toBe("reasoning");
      }
    }
    const note = trim.messages.at(-1)?.parts.at(-1);
    expect(note?.type === "text" ? note.text : "").toContain(
      "1 tool results were replaced by size placeholders"
    );
  });

  it("drops the oldest whole turns next and always keeps the newest turn and the request", () => {
    const summary = createMuxMessage("summary", "assistant", "Earlier summary.", {
      compacted: "user",
    });
    const huge = (id: string): MuxMessage[] => [
      createMuxMessage(`${id}-user`, "user", "y".repeat(40_000)),
      createMuxMessage(`${id}-assistant`, "assistant", "ok"),
    ];
    const messages = [summary, ...huge("a"), ...huge("b"), ...huge("c"), COMPACTION_REQUEST];

    const trim = trimCompactionInput(messages, 11_000);
    expect(trim.omittedTurns).toBe(2);
    expect(trim.messages.map((message) => message.id)).toEqual([
      "summary",
      "c-user",
      "c-assistant",
      "request",
    ]);

    // Even a budget the newest turn cannot meet keeps it and the request.
    const tight = trimCompactionInput(messages, 1);
    expect(tight.messages.map((message) => message.id)).toEqual([
      "summary",
      "c-user",
      "c-assistant",
      "request",
    ]);
  });

  it("replaces the newest turn's tool results only as a last resort", () => {
    const messages = [...toolTurn("a", 40_000), ...toolTurn("b", 40_000), COMPACTION_REQUEST];
    const olderOnly = trimCompactionInput(messages, 11_000);
    expect(olderOnly).toMatchObject({ omittedToolResults: 1, omittedTurns: 0 });
    expect(outputOf(olderOnly.messages, "b")).toEqual({
      success: true,
      content: "x".repeat(40_000),
    });

    const lastResort = trimCompactionInput(messages, 1_000);
    // The note counts only placeholders in kept rows: turn "a" was left out whole.
    expect(lastResort).toMatchObject({ omittedToolResults: 1, omittedTurns: 1 });
    expect(outputOf(lastResort.messages, "b")).toMatch(/^\[Tool result omitted/);
  });

  it("keeps a snapshot cluster with the turn it belongs to", () => {
    const snapshot = createMuxMessage("b-snapshot", "user", "z".repeat(400), {
      synthetic: true,
    });
    const messages = [
      createMuxMessage("a-user", "user", "y".repeat(40_000)),
      createMuxMessage("a-assistant", "assistant", "ok"),
      snapshot,
      createMuxMessage("b-user", "user", "@file"),
      createMuxMessage("b-assistant", "assistant", "ok"),
      COMPACTION_REQUEST,
    ];
    const trim = trimCompactionInput(messages, 1_000);
    expect(trim.messages.map((message) => message.id)).toEqual([
      "b-snapshot",
      "b-user",
      "b-assistant",
      "request",
    ]);
  });
});
