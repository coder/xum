import { describe, expect, it } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { estimateCompactionRowTokens } from "./compactionRowSizing";
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
  return messages.reduce((sum, message) => sum + estimateCompactionRowTokens(message), 0);
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
  it("returns the same array when the history fits", async () => {
    const messages = [...toolTurn("a", 4_000), ...toolTurn("b", 4_000), COMPACTION_REQUEST];
    const trim = await trimCompactionInput(messages, tokensOf(messages));
    expect(trim.messages).toBe(messages);
    expect(trim.omittedToolResults + trim.omittedTurns).toBe(0);
  });

  it("does not count nested code_execution calls, which never reach the provider", async () => {
    const nested = (withNestedCalls: boolean): MuxMessage[] => [
      createMuxMessage("n-user", "user", "run the script"),
      {
        id: "n-assistant",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "n-call",
            toolName: "code_execution",
            input: { code: "await mux.file_read({ path: 'big.ts' })" },
            state: "output-available",
            output: { success: true, result: "done" },
            ...(withNestedCalls
              ? {
                  nestedCalls: [
                    {
                      toolCallId: "n-nested",
                      toolName: "file_read",
                      input: { path: "big.ts" },
                      output: { success: true, content: "x".repeat(40_000) },
                      state: "output-available" as const,
                    },
                  ],
                }
              : {}),
          },
        ],
      },
      COMPACTION_REQUEST,
    ];
    const messages = nested(true);
    // The budget fits the provider-bound history, which has no nestedCalls.
    const trim = await trimCompactionInput(messages, tokensOf(nested(false)));
    expect(trim.messages).toBe(messages);
    expect(trim.omittedToolResults + trim.omittedTurns).toBe(0);
  });

  it("replaces the oldest tool results first and keeps every call with a result", async () => {
    const messages = [...toolTurn("a", 40_000), ...toolTurn("b", 40_000), ...toolTurn("c", 400)];
    messages.push(COMPACTION_REQUEST);
    // Room for one large result: only the oldest one becomes a placeholder.
    const trim = await trimCompactionInput(messages, 12_000 + 1_000);

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

  it("drops the oldest whole turns next and always keeps the newest turn and the request", async () => {
    const summary = createMuxMessage("summary", "assistant", "Earlier summary.", {
      compacted: "user",
    });
    const huge = (id: string): MuxMessage[] => [
      createMuxMessage(`${id}-user`, "user", "y".repeat(40_000)),
      createMuxMessage(`${id}-assistant`, "assistant", "ok"),
    ];
    const messages = [summary, ...huge("a"), ...huge("b"), ...huge("c"), COMPACTION_REQUEST];

    const trim = await trimCompactionInput(messages, 11_000);
    expect(trim.omittedTurns).toBe(2);
    expect(trim.messages.map((message) => message.id)).toEqual([
      "summary",
      "c-user",
      "c-assistant",
      "request",
    ]);

    // Even a budget the newest turn cannot meet keeps it and the request.
    const tight = await trimCompactionInput(messages, 1);
    expect(tight.messages.map((message) => message.id)).toEqual([
      "summary",
      "c-user",
      "c-assistant",
      "request",
    ]);
  });

  it("replaces the newest turn's tool results only as a last resort", async () => {
    const messages = [...toolTurn("a", 40_000), ...toolTurn("b", 40_000), COMPACTION_REQUEST];
    const olderOnly = await trimCompactionInput(messages, 11_000);
    expect(olderOnly).toMatchObject({ omittedToolResults: 1, omittedTurns: 0 });
    expect(outputOf(olderOnly.messages, "b")).toEqual({
      success: true,
      content: "x".repeat(40_000),
    });

    const lastResort = await trimCompactionInput(messages, 1_000);
    // The note counts only placeholders in kept rows: turn "a" was left out whole.
    expect(lastResort).toMatchObject({ omittedToolResults: 1, omittedTurns: 1 });
    expect(outputOf(lastResort.messages, "b")).toMatch(/^\[Tool result omitted/);
  });

  it("keeps a snapshot cluster with the turn it belongs to", async () => {
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
    const trim = await trimCompactionInput(messages, 1_000);
    expect(trim.messages.map((message) => message.id)).toEqual([
      "b-snapshot",
      "b-user",
      "b-assistant",
      "request",
    ]);
  });

  it("replaces only as many results of a multi-tool row as the budget needs", async () => {
    const row: MuxMessage = {
      id: "multi-assistant",
      role: "assistant",
      parts: ["r1", "r2", "r3"].map((id) => ({
        type: "dynamic-tool" as const,
        toolCallId: id,
        toolName: "file_read",
        input: {},
        state: "output-available" as const,
        output: { content: "x".repeat(40_000) },
      })),
    };
    const messages = [
      createMuxMessage("u1", "user", "read three"),
      row,
      createMuxMessage("u2", "user", "next"),
      createMuxMessage("a2", "assistant", "ok"),
      COMPACTION_REQUEST,
    ];
    // Room for two of the three results.
    const trim = await trimCompactionInput(messages, 21_000);
    const outputs = trim.messages
      .find((message) => message.id === "multi-assistant")
      ?.parts.map((part) =>
        part.type === "dynamic-tool" && part.state === "output-available" ? part.output : null
      );
    expect(trim.omittedToolResults).toBe(1);
    expect(outputs?.[0]).toMatch(/^\[Tool result omitted/);
    expect(outputs?.slice(1)).toEqual([
      { content: "x".repeat(40_000) },
      { content: "x".repeat(40_000) },
    ]);
  });

  it("rebases step boundaries onto the parts left after removing reasoning", async () => {
    const row: MuxMessage = {
      id: "steps-assistant",
      role: "assistant",
      metadata: { stepStartPartIndices: [0, 2, 4] },
      parts: [
        { type: "reasoning", text: "plan" },
        { type: "text", text: "step one" },
        { type: "reasoning", text: "think" },
        { type: "text", text: "step two" },
        // A step of reasoning only: it disappears with its reasoning.
        { type: "reasoning", text: "more" },
      ],
    };
    const messages = [
      ...toolTurn("a", 40_000),
      createMuxMessage("b-user", "user", "go"),
      row,
      COMPACTION_REQUEST,
    ];
    const trim = await trimCompactionInput(messages, 2_000);
    const rebased = trim.messages.find((message) => message.id === "steps-assistant");
    expect(rebased?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "step one",
      "step two",
    ]);
    expect(rebased?.metadata?.stepStartPartIndices).toEqual([0, 1]);
  });

  it("counts media parts so a screenshot-heavy history is trimmed", async () => {
    const screenshotTurn = (id: string): MuxMessage[] => [
      createMuxMessage(`${id}-user`, "user", `look ${id}`),
      {
        id: `${id}-assistant`,
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: `${id}-call`,
            toolName: "screenshot",
            input: {},
            state: "output-available",
            output: {
              type: "content",
              value: Array.from({ length: 10 }, () => ({
                type: "media",
                data: "iVBORw0KGgo=",
                mediaType: "image/png",
              })),
            },
          },
        ],
      },
    ];
    const messages = [...screenshotTurn("a"), ...screenshotTurn("b"), COMPACTION_REQUEST];
    // About 20 * 1,024 tokens of images; the base64 itself is a few characters.
    const trim = await trimCompactionInput(messages, 15_000);
    expect(trim.omittedToolResults).toBe(1);
  });

  it("counts a record typed media without the media shape as text", async () => {
    // No data or mediaType: extractToolMediaAsUserMessages leaves it in the tool-result JSON,
    // so the provider receives its 40k characters as text, not as one attachment.
    const messages: MuxMessage[] = [
      createMuxMessage("m-user", "user", "describe"),
      {
        id: "m-assistant",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "m-call",
            toolName: "mcp_tool",
            input: {},
            state: "output-available",
            output: { type: "content", value: [{ type: "media", text: "x".repeat(40_000) }] },
          },
        ],
      },
      createMuxMessage("n-user", "user", "next"),
      createMuxMessage("n-answer", "assistant", "ok"),
      COMPACTION_REQUEST,
    ];
    const trim = await trimCompactionInput(messages, 5_000);
    expect(trim.omittedTurns + trim.omittedToolResults).toBeGreaterThan(0);
  });

  it("states the size of the result alone in its placeholder, not of the call's input", async () => {
    const messages: MuxMessage[] = [
      createMuxMessage("w-user", "user", "write"),
      {
        id: "w-assistant",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "w-call",
            toolName: "file_write",
            // About 10k tokens of input, which stays in the request.
            input: { content: "i".repeat(40_000) },
            state: "output-available",
            // About 1k tokens of output, which the placeholder replaces.
            output: { content: "o".repeat(4_000) },
          },
        ],
      },
      createMuxMessage("n-user", "user", "next"),
      createMuxMessage("n-answer", "assistant", "ok"),
      COMPACTION_REQUEST,
    ];
    // Over the budget by less than the output: one placeholder fits it.
    const trim = await trimCompactionInput(messages, tokensOf(messages) - 500);
    expect(trim).toMatchObject({ omittedToolResults: 1, omittedTurns: 0 });
    const placeholder = String(outputOf(trim.messages, "w"));
    const tokens = Number(/about (\d+) tokens/.exec(placeholder)?.[1]);
    expect(tokens).toBeGreaterThan(900);
    expect(tokens).toBeLessThan(1_200);
  });

  it("keeps the turn boundary of a reasoning-only row it removes", async () => {
    // A stream that crashed early left an assistant row with only reasoning between u2 and u3.
    const messages: MuxMessage[] = [
      createMuxMessage("u1", "user", "y".repeat(40_000)),
      createMuxMessage("a1", "assistant", "ok"),
      createMuxMessage("u2", "user", "y".repeat(40_000)),
      { id: "crashed", role: "assistant", parts: [{ type: "reasoning", text: "thinking" }] },
      createMuxMessage("u3", "user", "small"),
      createMuxMessage("a3", "assistant", "ok"),
      COMPACTION_REQUEST,
    ];
    const trim = await trimCompactionInput(messages, 1_000);
    // u2 is its own turn and is dropped; the emptied row is not sent.
    expect(trim.messages.map((message) => message.id)).toEqual(["u3", "a3", "request"]);
    expect(trim.omittedTurns).toBe(2);
  });

  it("keeps a short result instead of growing the row with a placeholder", async () => {
    const row: MuxMessage = {
      id: "short-assistant",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "short",
          toolName: "file_exists",
          input: {},
          state: "output-available",
          output: true,
        },
        {
          type: "dynamic-tool",
          toolCallId: "long",
          toolName: "file_read",
          input: {},
          state: "output-available",
          output: { content: "x".repeat(40_000) },
        },
      ],
    };
    const messages = [
      createMuxMessage("u1", "user", "check then read"),
      row,
      createMuxMessage("u2", "user", "next"),
      createMuxMessage("a2", "assistant", "ok"),
      COMPACTION_REQUEST,
    ];
    // Replacing the long result fits the budget; the short one comes first and stays.
    const trim = await trimCompactionInput(messages, 2_000);
    const outputs = trim.messages
      .find((message) => message.id === "short-assistant")
      ?.parts.map((part) =>
        part.type === "dynamic-tool" && part.state === "output-available" ? part.output : null
      );
    expect(trim).toMatchObject({ omittedToolResults: 1, omittedTurns: 0 });
    expect(outputs?.[0]).toBe(true);
    expect(outputs?.[1]).toMatch(/^\[Tool result omitted/);
  });

  it("finds the compaction request when snapshot rows follow it", async () => {
    const request = createMuxMessage("compact-request", "user", "Summarize the conversation.", {
      muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
    });
    const snapshot = (id: string) =>
      createMuxMessage(id, "user", `<snapshot ${id}>`, {
        synthetic: true,
        fileAtMentionSnapshot: [`${id}.ts`],
      });
    const turn = (id: string): MuxMessage[] => [
      createMuxMessage(`${id}-user`, "user", "y".repeat(40_000)),
      createMuxMessage(`${id}-assistant`, "assistant", "ok"),
    ];
    const messages = [...turn("old"), ...turn("newest"), request, snapshot("s1"), snapshot("s2")];

    const trim = await trimCompactionInput(messages, 11_000);
    // Only the older turn goes: the newest turn, the request and its snapshots stay.
    expect(trim.omittedTurns).toBe(1);
    expect(trim.messages.map((message) => message.id)).toEqual([
      "newest-user",
      "newest-assistant",
      "compact-request",
      "s1",
      "s2",
    ]);
    const note = trim.messages[2]?.parts.at(-1);
    expect(note?.type === "text" ? note.text : "").toContain("1 oldest turns were left out");

    // Even a budget nothing meets keeps the real newest turn: it is never dropped.
    const tight = await trimCompactionInput(messages, 1);
    expect(tight.messages.map((message) => message.id)).toContain("newest-user");
  });
});
