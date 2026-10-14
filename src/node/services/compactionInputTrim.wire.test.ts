/**
 * Wire-level checks for the compaction input trim (trimCompactionInput via
 * assemblePromptPayload): the request the provider receives stays valid, and an untrimmed
 * compaction request stays byte-identical so its prompt-cache reads are intact.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { estimateCompactionInputTokens } from "@/common/utils/messages/trimCompactionInput";
import { assemblePromptPayload } from "./turnContextAssembler";

function toolTurn(id: string, outputChars: number): MuxMessage[] {
  return [
    createMuxMessage(`${id}-user`, "user", `read ${id}`),
    {
      id: `${id}-assistant`,
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          text: `Plan for ${id}.`,
          providerOptions: { anthropic: { signature: `sig-${id}` } },
        },
        { type: "text", text: `Reading ${id}.` },
        {
          type: "dynamic-tool",
          toolCallId: `call_${id}`,
          toolName: "file_read",
          input: { path: `${id}.ts` },
          state: "output-available",
          output: { success: true, content: `${id}:${"x".repeat(outputChars)}` },
        },
        { type: "text", text: `Done with ${id}.` },
      ],
    },
  ];
}

// Three turns of about 10k tokens each, then the compaction request.
const HISTORY: MuxMessage[] = [
  ...toolTurn("a", 40_000),
  ...toolTurn("b", 40_000),
  ...toolTurn("c", 40_000),
  createMuxMessage("request", "user", "Summarize the conversation.", {
    muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
  }),
];

function assemble(
  provider: "anthropic" | "openai",
  compactionInputBudgetTokens?: number,
  history: MuxMessage[] = HISTORY
) {
  return assemblePromptPayload({
    history,
    systemMessage: "You summarize conversations.",
    modelString: provider === "anthropic" ? "anthropic:claude-haiku-4-5" : "openai:gpt-5.2",
    providerForMessages: provider,
    // Thinking on: an untrimmed request must keep its signed thinking blocks.
    effectiveThinkingLevel: "high",
    effectiveAgentId: "compact",
    toolNamesForSentinel: [],
    workspaceId: "ws",
    ...(compactionInputBudgetTokens != null ? { compactionInputBudgetTokens } : {}),
  });
}

/** The JSON body the provider SDK would send for these messages (the fetch never answers). */
async function wireBody(
  provider: "anthropic" | "openai",
  payload: Awaited<ReturnType<typeof assemble>>
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const fetch = ((_url: unknown, init?: { body?: unknown }) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.resolve(new Response("{}", { status: 400 }));
  }) as unknown as typeof globalThis.fetch;
  const model: LanguageModel =
    provider === "anthropic"
      ? createAnthropic({ apiKey: "k", baseURL: "http://wire.invalid/v1", fetch })(
          "claude-haiku-4-5"
        )
      : createOpenAI({ apiKey: "k", baseURL: "http://wire.invalid/v1", fetch }).responses(
          "gpt-5.2"
        );
  await generateText({
    model,
    system: payload.system,
    messages: payload.messages,
    // Xum keeps the cached Anthropic system row in messages (see assemblePromptPayload).
    allowSystemInMessages: true,
    maxRetries: 0,
  }).catch(() => undefined);
  if (body == null) throw new Error("the provider SDK sent no request");
  return body;
}

/** Tool call IDs, and the IDs that have a result, in the provider's own wire format. */
function toolPairs(provider: "anthropic" | "openai", body: Record<string, unknown>) {
  const calls: string[] = [];
  const results: string[] = [];
  if (provider === "anthropic") {
    for (const message of body.messages as Array<{ content: unknown }>) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type === "tool_use") calls.push(String(block.id));
        if (block.type === "tool_result") results.push(String(block.tool_use_id));
      }
    }
  } else {
    for (const item of body.input as Array<Record<string, unknown>>) {
      if (item.type === "function_call") calls.push(String(item.call_id));
      if (item.type === "function_call_output") results.push(String(item.call_id));
    }
  }
  return { calls, results };
}

describe("compaction input trim on the wire", () => {
  test.each(["anthropic", "openai"] as const)(
    "%s: an untrimmed compaction request is byte-identical",
    async (provider) => {
      const plain = await assemble(provider);
      const roomy = await assemble(provider, 1_000_000);
      expect(JSON.stringify(roomy.messages)).toBe(JSON.stringify(plain.messages));
      if (provider === "anthropic") expect(JSON.stringify(plain.messages)).toContain("sig-a");
      expect(JSON.stringify(await wireBody(provider, roomy))).toBe(
        JSON.stringify(await wireBody(provider, plain))
      );
    }
  );

  test.each(["anthropic", "openai"] as const)(
    "%s: a trimmed request keeps every tool call paired with a result",
    async (provider) => {
      // Room for one full result: "a" and "b" become placeholders, "c" stays whole.
      const payload = await assemble(provider, 14_000);
      const body = await wireBody(provider, payload);
      const text = JSON.stringify(body);
      const { calls, results } = toolPairs(provider, body);

      expect(calls).toEqual(["call_a", "call_b", "call_c"]);
      expect(results).toEqual(calls);
      expect(text).not.toContain(`a:${"x".repeat(100)}`);
      expect(text).toContain(`c:${"x".repeat(100)}`);
      expect(text).toContain("Tool result omitted to fit the compaction request");
      expect(text).toContain("2 tool results were replaced by size placeholders");
      // Thinking signatures are bound to the prefix the trim changed. (The SDK body here has
      // no thinking config, so check the provider messages Xum hands it.)
      expect(JSON.stringify(payload.messages)).not.toContain("sig-");
    }
  );

  test("a trimmed request keeps a step that opens with a tool call in its own message", async () => {
    const tool = (id: string) => ({
      type: "dynamic-tool" as const,
      toolCallId: `call_${id}`,
      toolName: "file_read",
      input: { path: `${id}.ts` },
      state: "output-available" as const,
      output: { success: true, content: id },
    });
    const reasoning = (text: string) => ({
      type: "reasoning" as const,
      text,
      providerOptions: { anthropic: { signature: `sig-${text}` } },
    });
    // Two sequential steps: the second opens with its reasoning, then a tool call.
    const steps: MuxMessage = {
      id: "steps-assistant",
      role: "assistant",
      metadata: { stepStartPartIndices: [0, 2] },
      parts: [
        reasoning("one"),
        tool("s1"),
        reasoning("two"),
        tool("s2"),
        { type: "text", text: "Done." },
      ],
    };
    const history = [
      ...toolTurn("old", 40_000),
      createMuxMessage("steps-user", "user", "read twice"),
      steps,
      HISTORY[HISTORY.length - 1],
    ];
    // Trimmed (the old result becomes a placeholder), so reasoning is removed too.
    const payload = await assemble("anthropic", 2_000, history);
    const body = await wireBody("anthropic", payload);
    expect(JSON.stringify(body)).toContain("Tool result omitted");
    const messageOf = (callId: string) =>
      (body.messages as Array<{ content: unknown }>).findIndex(
        (message) =>
          Array.isArray(message.content) &&
          (message.content as Array<Record<string, unknown>>).some(
            (block) => block.type === "tool_use" && block.id === callId
          )
      );
    // Sequential steps replay as two assistant messages, not one parallel call.
    expect(messageOf("call_s1")).toBeGreaterThanOrEqual(0);
    expect(messageOf("call_s2")).toBeGreaterThan(messageOf("call_s1"));
  });

  test("sizes the redacted projection: provider-invisible output does not trigger a trim", async () => {
    // Most of this result is ui_only data, which applyToolOutputRedaction removes before send.
    const uiOnlyTurn: MuxMessage[] = [
      createMuxMessage("ui-user", "user", "edit"),
      {
        id: "ui-assistant",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call_ui",
            toolName: "file_edit_replace_string",
            input: { path: "a.ts" },
            state: "output-available",
            output: { success: true, ui_only: { file_edit: { diff: "d".repeat(200_000) } } },
          },
        ],
      },
    ];
    const history = [...uiOnlyTurn, HISTORY[HISTORY.length - 1]];
    const plain = await assemble("openai", undefined, history);
    // The raw rows are about 50k tokens, the redacted ones a few dozen.
    const sized = await assemble("openai", 5_000, history);
    expect(JSON.stringify(sized.messages)).toBe(JSON.stringify(plain.messages));
    expect(JSON.stringify(sized.messages)).not.toContain("Compaction input trimmed");
  });

  test("counts dense text with the model's tokenizer before deciding to trim", async () => {
    const cjk = "这是一个测试句子，用于检查分词器的密度。".repeat(2_000);
    const history: MuxMessage[] = [
      createMuxMessage("cjk-old", "user", cjk),
      createMuxMessage("cjk-old-answer", "assistant", "ok"),
      createMuxMessage("cjk-new", "user", "next"),
      createMuxMessage("cjk-new-answer", "assistant", "ok"),
      HISTORY[HISTORY.length - 1],
    ];
    const charsEstimate = await estimateCompactionInputTokens(history);
    // chars/4 says the history fits twice over; the real count is several times larger.
    const payload = await assemble("openai", charsEstimate * 2, history);
    const text = JSON.stringify(payload.messages);
    expect(text).toContain("Compaction input trimmed");
    expect(text).not.toContain(cjk.slice(0, 50));
  });

  test("a screenshot data URL that fits keeps the request untrimmed and byte-identical", async () => {
    // About 1.5 MB of base64: the provider charges it as one image, not as text.
    const screenshot = `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUgAA".repeat(64_000)}`;
    const history: MuxMessage[] = [
      {
        id: "shot-user",
        role: "user",
        parts: [
          { type: "text", text: "What is on this screen?" },
          { type: "file", mediaType: "image/png", url: screenshot },
        ],
      },
      createMuxMessage("shot-answer", "assistant", "A login form."),
      createMuxMessage("next-user", "user", "next"),
      createMuxMessage("next-answer", "assistant", "ok"),
      HISTORY[HISTORY.length - 1],
    ];
    const plain = await assemble("openai", undefined, history);
    const budgeted = await assemble("openai", 5_000, history);
    expect(JSON.stringify(budgeted.messages)).toBe(JSON.stringify(plain.messages));
  });

  test("sizes an SVG attachment as the source text the provider receives", async () => {
    // About 45k characters of markup: inlineSvgAsTextForProvider sends it as text, not as an
    // image, so it is well over this budget.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect x="1" y="2"/>'.repeat(2_300)}</svg>`;
    const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const history: MuxMessage[] = [
      {
        id: "svg-user",
        role: "user",
        parts: [
          { type: "text", text: "Fix this icon." },
          { type: "file", mediaType: "image/svg+xml", url },
        ],
      },
      createMuxMessage("svg-answer", "assistant", "Done."),
      createMuxMessage("next-user", "user", "next"),
      createMuxMessage("next-answer", "assistant", "ok"),
      HISTORY[HISTORY.length - 1],
    ];
    const text = JSON.stringify((await assemble("openai", 5_000, history)).messages);
    expect(text).toContain("1 oldest turns were left out");
    expect(text).not.toContain('<rect x="1"');
  });

  test("sizes a malformed tool input as the empty object the provider receives", async () => {
    // sanitizeToolInputs sends a non-object input as {}: this 200k-character string never
    // reaches the provider, so the history fits.
    const history: MuxMessage[] = [
      createMuxMessage("bad-user", "user", "run it"),
      {
        id: "bad-assistant",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call_bad",
            toolName: "bash",
            input: "x".repeat(200_000),
            state: "output-available",
            output: { success: true, output: "ok" },
          },
        ],
      },
      createMuxMessage("next-user", "user", "next"),
      createMuxMessage("next-answer", "assistant", "ok"),
      HISTORY[HISTORY.length - 1],
    ];
    const plain = await assemble("openai", undefined, history);
    const sized = await assemble("openai", 5_000, history);
    expect(JSON.stringify(sized.messages)).toBe(JSON.stringify(plain.messages));
    expect(JSON.stringify(sized.messages)).not.toContain("Compaction input trimmed");
  });

  test("recounts a row after replacing its result, so dense text left in it still counts", async () => {
    const cjk = "这是一个测试句子，用于检查分词器的密度。".repeat(400);
    // One row: a large low-density result next to dense CJK text.
    const mixed: MuxMessage = {
      id: "mixed-assistant",
      role: "assistant",
      parts: [
        { type: "text", text: cjk },
        {
          type: "dynamic-tool",
          toolCallId: "call_big",
          toolName: "file_read",
          input: { path: "big.log" },
          state: "output-available",
          output: { success: true, content: "x".repeat(400_000) },
        },
      ],
    };
    const history: MuxMessage[] = [
      createMuxMessage("mixed-user", "user", "read the log"),
      mixed,
      createMuxMessage("next-user", "user", "next"),
      createMuxMessage("next-answer", "assistant", "ok"),
      HISTORY[HISTORY.length - 1],
    ];
    // After the result is replaced, the CJK text alone is still over this budget.
    const payload = await assemble("openai", 6_000, history);
    const text = JSON.stringify(payload.messages);
    expect(text).toContain("1 oldest turns were left out");
    expect(text).not.toContain(cjk.slice(0, 40));
  });
});
