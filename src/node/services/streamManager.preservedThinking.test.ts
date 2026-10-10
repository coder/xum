import { describe, expect, spyOn, test } from "bun:test";
import * as aiSdk from "ai";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { prepareMessagesForProvider } from "./messagePipeline";
import { assemblePromptPayload } from "./turnContextAssembler";
import {
  createStreamManagerForTests,
  engineInternals,
  fakeStreamText,
} from "./streamManager.testHarness";
import {
  appendPartialAssistantForTests,
  createTestLanguageModel,
  historyService,
  installStreamManagerTestHistory,
  REFUSAL_FINISH,
  runTurnForTests,
  scriptedStreamText,
  STOP_FINISH,
  TEST_USAGE,
} from "./streamManager.suite.testHarness";

installStreamManagerTestHistory();

// Preserved thinking (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking):
// newer Claude models bind each replayed thinking block to its prefix, so Xum must
// send every block back exactly as the API returned it. These tests drive real
// Anthropic SSE through the real SDK, persist the turn, rebuild the next request
// from history, and read the request body the real SDK sends.

interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}
interface AnthropicRequestBody {
  messages: Array<{ role: string; content: AnthropicBlock[] | string }>;
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

const messageStart = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
};

function thinkingBlock(index: number, text: string, signature: string): unknown[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    // Fable 5.1 / Haiku 5.5 return blocks with no thinking text, only a signature.
    ...(text.length > 0
      ? [{ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } }]
      : []),
    { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
    { type: "content_block_stop", index },
  ];
}

/** One step: thinking "plan", thinking "check", redacted_thinking, empty signed thinking, tool_use. */
const toolStepResponse = () =>
  sse([
    messageStart,
    ...thinkingBlock(0, "plan", "sig-plan"),
    ...thinkingBlock(1, "check", "sig-check"),
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "redacted_thinking", data: "redacted-data" },
    },
    { type: "content_block_stop", index: 2 },
    ...thinkingBlock(3, "", "sig-empty"),
    {
      type: "content_block_start",
      index: 4,
      content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
    },
    {
      type: "content_block_delta",
      index: 4,
      delta: { type: "input_json_delta", partial_json: '{"script":"pwd"}' },
    },
    { type: "content_block_stop", index: 4 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);

const textResponse = () =>
  sse([
    messageStart,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);

/** A real Anthropic Messages model whose responses are scripted; request bodies are captured. */
function scriptedAnthropicModel(responses: Array<() => Response>) {
  const bodies: AnthropicRequestBody[] = [];
  const provider = createAnthropic({
    apiKey: "test-key",
    fetch: Object.assign(
      (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body)) as AnthropicRequestBody);
        const next = responses.shift();
        if (!next) throw new Error(`Unexpected Anthropic request ${bodies.length}`);
        return Promise.resolve(next());
      },
      { preconnect: fetch.preconnect.bind(fetch) }
    ),
  });
  return { model: provider("claude-opus-5-5"), provider, bodies };
}

/** Thinking-type blocks of the first assistant message, plus the block after them. */
function firstAssistantBlocks(body: AnthropicRequestBody | undefined): AnthropicBlock[] {
  const assistant = body?.messages.find((message) => message.role === "assistant");
  expect(Array.isArray(assistant?.content)).toBe(true);
  return (assistant?.content as AnthropicBlock[]).map(({ cache_control: _cc, ...block }) => block);
}

const expectedBlocks = [
  { type: "thinking", thinking: "plan", signature: "sig-plan" },
  { type: "thinking", thinking: "check", signature: "sig-check" },
  { type: "redacted_thinking", data: "redacted-data" },
  { type: "thinking", thinking: "", signature: "sig-empty" },
  { type: "tool_use", id: "toolu_1", name: "bash", input: { script: "pwd" } },
];

/**
 * One step with a server tool between thinking blocks (#5887): thinking "plan",
 * server_tool_use web_search, web_search_tool_result, thinking "read", client tool_use.
 */
const serverToolResponse = () =>
  sse([
    messageStart,
    ...thinkingBlock(0, "plan", "sig-plan"),
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "xum" },
      },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          {
            type: "web_search_result",
            url: "https://example.com/xum",
            title: "Xum",
            encrypted_content: "enc-1",
            page_age: null,
          },
        ],
      },
    },
    { type: "content_block_stop", index: 2 },
    ...thinkingBlock(3, "read", "sig-read"),
    {
      type: "content_block_start",
      index: 4,
      content_block: { type: "tool_use", id: "toolu_2", name: "bash", input: {} },
    },
    {
      type: "content_block_delta",
      index: 4,
      delta: { type: "input_json_delta", partial_json: '{"script":"pwd"}' },
    },
    { type: "content_block_stop", index: 4 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);

describe("StreamManager - Anthropic preserved thinking replay", () => {
  test("replays every thinking block from history as the API returned it", async () => {
    const workspaceId = "preserved-thinking-replay";
    // Request 1: the turn's tool step. Request 2: the same turn's follow-up step
    // after the tool result. Request 3: the next turn, rebuilt from history.
    const { model, bodies } = scriptedAnthropicModel([
      toolStepResponse,
      textResponse,
      textResponse,
    ]);
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText((options) => aiSdk.streamText(options)),
    });

    const { messageId } = await runTurnForTests(streamManager, {
      workspaceId,
      model,
      modelString: "anthropic:claude-opus-5-5",
      messages: [{ role: "user", content: "go" }],
      tools: {
        bash: tool({
          inputSchema: z.object({ script: z.string() }),
          execute: () => Promise.resolve("/tmp"),
        }),
      },
    });

    // The SDK's own in-turn replay (response messages) is the reference shape.
    expect(bodies).toHaveLength(2);
    expect(firstAssistantBlocks(bodies[1])).toEqual(expectedBlocks);

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    const assistant = history.data.find((message) => message.id === messageId);
    expect(assistant?.metadata?.partial).not.toBe(true);
    // Client tools alone never turn replay off (#5887 containment is server-tool only).
    expect(assistant?.metadata?.anthropicThinkingReplay).toBeUndefined();

    const nextTurn: MuxMessage[] = [
      createMuxMessage("user-1", "user", "go", { timestamp: 1 }),
      assistant!,
      createMuxMessage("user-2", "user", "next", { timestamp: 3 }),
    ];
    const rebuilt = await prepareMessagesForProvider({
      messagesWithSentinel: nextTurn,
      effectiveAgentId: "exec",
      toolNamesForSentinel: [],
      providerForMessages: "anthropic",
      effectiveThinkingLevel: "high",
      modelString: "anthropic:claude-opus-5-5",
      workspaceId,
    });
    const replay = aiSdk.streamText({ model, messages: rebuilt, maxRetries: 0 });
    await replay.consumeStream();

    expect(bodies).toHaveLength(3);
    expect(firstAssistantBlocks(bodies[2])).toEqual(expectedBlocks);
  });

  describe("server tool between thinking blocks (#5887, containment)", () => {
    // Xum stores an Anthropic server tool (web_search) as a client tool call without its
    // encrypted results, so history replays it as a tool_use/tool_result pair instead of
    // the API's server_tool_use + web_search_tool_result blocks. Thinking after the server
    // tool is bound to a prefix Xum never sends again. Until native replay exists, such a
    // turn writes the thinking-replay receipt, and later requests in the context segment
    // send no thinking (removing all thinking blocks is valid per the preserved-thinking
    // docs). A scripted fixture proves the drift and the strip, not upstream acceptance.
    const bashTool = () =>
      tool({
        inputSchema: z.object({ script: z.string() }),
        execute: () => Promise.resolve("/tmp"),
      });

    async function runServerToolTurn(workspaceId: string, first: () => Response) {
      const scripted = scriptedAnthropicModel([first, textResponse, textResponse]);
      const tools = {
        // Same cast as production (src/common/utils/tools/tools.ts).
        web_search: scripted.provider.tools.webSearch_20250305({ maxUses: 5 }) as Tool,
        bash: bashTool(),
      };
      const seeded = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user-1", "user", "search", { historySequence: 0 })
      );
      if (!seeded.success) throw new Error(seeded.error);
      const streamManager = createStreamManagerForTests(historyService, {
        streamText: fakeStreamText((options) => aiSdk.streamText(options)),
      });
      const { messageId } = await runTurnForTests(streamManager, {
        workspaceId,
        model: scripted.model,
        modelString: "anthropic:claude-opus-5-5",
        messages: [{ role: "user", content: "search" }],
        tools,
      });
      return { ...scripted, tools, messageId };
    }

    /** The next turn's request body, rebuilt from committed history the production way. */
    async function nextTurnBody(
      workspaceId: string,
      scripted: Pick<Awaited<ReturnType<typeof runServerToolTurn>>, "model" | "bodies" | "tools">
    ): Promise<AnthropicRequestBody | undefined> {
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const payload = await assemblePromptPayload({
        history: [
          ...history.data,
          createMuxMessage("user-2", "user", "next", { historySequence: 2 }),
        ],
        systemMessage: "system",
        modelString: "anthropic:claude-opus-5-5",
        providerForMessages: "anthropic",
        effectiveThinkingLevel: "high",
        effectiveAgentId: "exec",
        toolNamesForSentinel: [],
        workspaceId,
      });
      const before = scripted.bodies.length;
      const replay = aiSdk.streamText({
        model: scripted.model,
        // The system prompt is not part of what this test compares.
        messages: payload.messages.filter((message) => message.role !== "system"),
        tools: scripted.tools,
        maxRetries: 0,
      });
      await replay.consumeStream();
      expect(scripted.bodies).toHaveLength(before + 1);
      return scripted.bodies.at(-1);
    }

    function blocksOf(message: AnthropicRequestBody["messages"][number] | undefined) {
      return message == null || typeof message.content === "string" ? [] : message.content;
    }

    function thinkingTypes(body: AnthropicRequestBody | undefined): string[] {
      return (body?.messages ?? [])
        .flatMap((message) => blocksOf(message))
        .map((block) => block.type)
        .filter((type) => type === "thinking" || type === "redacted_thinking");
    }

    /** Every tool_use is answered by the next message, and no tool_result is left over. */
    function expectPairedTools(body: AnthropicRequestBody | undefined) {
      const messages = body?.messages ?? [];
      let uses = 0;
      messages.forEach((message, index) => {
        if (message.role !== "assistant") return;
        const useIds = blocksOf(message)
          .filter((block) => block.type === "tool_use")
          .map((block) => block.id);
        const resultIds = blocksOf(messages[index + 1])
          .filter((block) => block.type === "tool_result")
          .map((block) => block.tool_use_id);
        expect(resultIds).toEqual(useIds);
        uses += useIds.length;
      });
      const results = messages
        .flatMap((message) => blocksOf(message))
        .filter((block) => block.type === "tool_result").length;
      expect(results).toBe(uses);
      expect(uses).toBeGreaterThan(0);
    }

    test("a server tool before thinking turns thinking replay off for the segment", async () => {
      const workspaceId = "preserved-thinking-server-tool";
      const scripted = await runServerToolTurn(workspaceId, serverToolResponse);

      // The SDK's own in-turn replay keeps the API's block order, native result included:
      // that is the prefix the "read" signature is bound to.
      expect(firstAssistantBlocks(scripted.bodies[1]).map((block) => block.type)).toEqual([
        "thinking",
        "server_tool_use",
        "web_search_tool_result",
        "thinking",
        "tool_use",
      ]);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const row = history.data.find((message) => message.id === scripted.messageId);
      expect(row?.metadata?.partial).not.toBe(true);
      expect(row?.metadata?.anthropicThinkingReplay).toBe("off");

      const next = await nextTurnBody(workspaceId, scripted);
      expect(thinkingTypes(next)).toEqual([]);
      expectPairedTools(next);
      expect(JSON.stringify(next)).toContain("done");
    });

    test("the first partial that holds the bound thinking carries the receipt through a crash", async () => {
      const workspaceId = "preserved-thinking-server-tool-partial";
      const written: MuxMessage[] = [];
      const realWritePartial = historyService.writePartial.bind(historyService);
      const writePartial = spyOn(historyService, "writePartial").mockImplementation(
        (id, message) => {
          if (id === workspaceId) written.push(structuredClone(message));
          return realWritePartial(id, message);
        }
      );
      let scripted: Awaited<ReturnType<typeof runServerToolTurn>>;
      try {
        scripted = await runServerToolTurn(workspaceId, serverToolResponse);
      } finally {
        writePartial.mockRestore();
      }
      // The first partial on disk with thinking after the server tool: a crash right after
      // this write must already keep that thinking out of later requests.
      const snapshot = written.find((message) => {
        const toolIndex = message.parts.findIndex(
          (part) => part.type === "dynamic-tool" && part.toolCallId === "srvtoolu_1"
        );
        return (
          toolIndex >= 0 &&
          message.parts.slice(toolIndex + 1).some((part) => part.type === "reasoning")
        );
      });
      expect(snapshot?.metadata?.anthropicThinkingReplay).toBe("off");

      // Replay that crash: the same partial left on disk, committed on the next start.
      const crashed = "preserved-thinking-server-tool-crash";
      const seeded = await historyService.appendToHistory(
        crashed,
        createMuxMessage("user-1", "user", "search", { historySequence: 0 })
      );
      if (!seeded.success) throw new Error(seeded.error);
      await appendPartialAssistantForTests(crashed, snapshot!.id, 1);
      const partial = await historyService.writePartial(crashed, snapshot!);
      if (!partial.success) throw new Error(partial.error);
      const committed = await historyService.commitPartial(crashed);
      if (!committed.success) throw new Error(committed.error);

      const next = await nextTurnBody(crashed, scripted);
      expect(thinkingTypes(next)).toEqual([]);
      expectPairedTools(next);
    });

    test("a provider-executed tool before reasoning on the OpenAI wire writes no receipt", async () => {
      const workspaceId = "preserved-thinking-openai-server-tool";
      // OpenAI Responses: web_search_call, then a reasoning summary, then the answer. The
      // receipt is Anthropic-only (it strips the `anthropic` replay namespace).
      const events = [
        {
          type: "response.created",
          response: { id: "resp_1", created_at: 1, model: "gpt-5.2" },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "web_search_call", id: "ws_1", status: "in_progress" },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            action: { type: "search", query: "xum" },
          },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "reasoning", id: "rs_1", encrypted_content: null },
        },
        {
          type: "response.reasoning_summary_part.added",
          item_id: "rs_1",
          output_index: 1,
          summary_index: 0,
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_1",
          output_index: 1,
          summary_index: 0,
          delta: "read",
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: { type: "reasoning", id: "rs_1", encrypted_content: null },
        },
        {
          type: "response.output_item.added",
          output_index: 2,
          item: { type: "message", id: "msg_1" },
        },
        { type: "response.output_text.delta", item_id: "msg_1", output_index: 2, delta: "found" },
        {
          type: "response.output_item.done",
          output_index: 2,
          item: { type: "message", id: "msg_1" },
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 10, output_tokens: 3 } },
        },
      ];
      const openai = createOpenAI({
        apiKey: "test-key",
        fetch: Object.assign(() => Promise.resolve(sse(events)), {
          preconnect: fetch.preconnect.bind(fetch),
        }),
      });
      const seeded = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user-1", "user", "search", { historySequence: 0 })
      );
      if (!seeded.success) throw new Error(seeded.error);
      const streamManager = createStreamManagerForTests(historyService, {
        streamText: fakeStreamText((options) => aiSdk.streamText(options)),
      });
      const { messageId } = await runTurnForTests(streamManager, {
        workspaceId,
        model: openai.responses("gpt-5.2"),
        modelString: "openai:gpt-5.2",
        messages: [{ role: "user", content: "search" }],
        // Same cast as production (src/common/utils/tools/tools.ts).
        tools: { web_search: openai.tools.webSearch({}) as Tool },
      });

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const row = history.data.find((message) => message.id === messageId);
      // The trigger shape is present: reasoning after a provider-executed tool part.
      const parts = row?.parts ?? [];
      const toolIndex = parts.findIndex(
        (part) => part.type === "dynamic-tool" && part.toolName === "web_search"
      );
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(parts.slice(toolIndex + 1).some((part) => part.type === "reasoning")).toBe(true);
      expect(row?.metadata?.anthropicThinkingReplay).toBeUndefined();
    });

    test("a dropped server-tool part costs at most one parts scan, not one per delta", async () => {
      const workspaceId = "preserved-thinking-server-tool-dropped";
      const deltas = 50;
      let scans = 0;
      let streamInfo: { parts: unknown[] } | undefined;
      // The script below reads the manager lazily, after construction.
      const streamManager: ReturnType<typeof createStreamManagerForTests> =
        createStreamManagerForTests(historyService, {
          streamText: scriptedStreamText([
            {
              chunks: [
                { type: "start-step" },
                {
                  type: "tool-call",
                  toolCallId: "srvtoolu_1",
                  toolName: "web_search",
                  input: { query: "xum" },
                  providerExecuted: true,
                },
                {
                  type: "tool-result",
                  toolCallId: "srvtoolu_1",
                  toolName: "web_search",
                  output: [],
                  providerExecuted: true,
                },
                // A retry that does not preserve parts drops the server-tool part, while
                // the turn keeps its record of the server-tool call.
                async () => {
                  const internals = engineInternals(streamManager);
                  streamInfo = internals.workspaceStreams.get(workspaceId) as { parts: unknown[] };
                  await internals.resetStreamStateForRetry(workspaceId, streamInfo, {
                    preserveParts: false,
                  });
                  const parts = streamInfo.parts;
                  // Count full scans of the parts array from here on.
                  parts.some = (...args: Parameters<typeof parts.some>) => {
                    scans += 1;
                    return Array.prototype.some.apply(parts, args);
                  };
                },
                ...Array.from({ length: deltas }, () => ({ type: "reasoning-delta", text: "r" })),
                { type: "finish-step", usage: TEST_USAGE },
                STOP_FINISH,
              ],
            },
          ]),
        });
      const { messageId } = await runTurnForTests(streamManager, {
        workspaceId,
        model: createTestLanguageModel("claude-opus-5-5", "anthropic.messages"),
        modelString: "anthropic:claude-opus-5-5",
      });

      expect(streamInfo).toBeDefined();
      expect(scans).toBeLessThanOrEqual(1);
      // Nothing in the committed row follows a server tool, so replay stays on.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const row = history.data.find((message) => message.id === messageId);
      expect(row?.parts.some((part) => part.type === "dynamic-tool")).toBe(false);
      expect(row?.metadata?.anthropicThinkingReplay).toBeUndefined();
    });

    test("reasoning from a non-Anthropic refusal fallback writes no receipt", async () => {
      const workspaceId = "preserved-thinking-server-tool-fallback";
      const streamManager = createStreamManagerForTests(historyService, {
        streamText: scriptedStreamText([
          {
            // The Anthropic attempt runs a server tool, then refuses: the parts stay.
            chunks: [
              { type: "start-step" },
              {
                type: "tool-call",
                toolCallId: "srvtoolu_1",
                toolName: "web_search",
                input: { query: "xum" },
                providerExecuted: true,
              },
              {
                type: "tool-result",
                toolCallId: "srvtoolu_1",
                toolName: "web_search",
                output: [],
                providerExecuted: true,
              },
              REFUSAL_FINISH,
            ],
          },
          {
            // The OpenAI fallback reasons: that reasoning is not bound to an Anthropic prefix.
            chunks: [
              { type: "start-step" },
              { type: "reasoning-delta", text: "fallback thinking" },
              { type: "text-delta", text: "answer" },
              { type: "finish-step", usage: TEST_USAGE },
              STOP_FINISH,
            ],
          },
        ]),
      });
      const { messageId } = await runTurnForTests(streamManager, {
        workspaceId,
        model: createTestLanguageModel("claude-opus-5-5", "anthropic.messages"),
        modelString: "anthropic:claude-opus-5-5",
        modelFallback: {
          chain: ["openai:gpt-5.2"],
          prepare: (modelString) =>
            Promise.resolve(
              Ok({
                model: createTestLanguageModel("gpt-5.2", "openai.responses"),
                modelString,
                messages: [],
                system: "system",
                tools: undefined,
                thinkingLevel: "high" as const,
              })
            ),
        },
      });

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const row = history.data.find((message) => message.id === messageId);
      // The fallback did run after the server tool, and its reasoning is in the row.
      const parts = row?.parts ?? [];
      const toolIndex = parts.findIndex(
        (part) => part.type === "dynamic-tool" && part.toolCallId === "srvtoolu_1"
      );
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(parts.slice(toolIndex + 1).some((part) => part.type === "reasoning")).toBe(true);
      expect(row?.metadata?.anthropicThinkingReplay).toBeUndefined();
    });

    test("the running turn exposes its receipt to continuous compaction (#5996)", async () => {
      const workspaceId = "preserved-thinking-server-tool-live";
      const seen: Array<"off" | undefined> = [];
      const streamManager: ReturnType<typeof createStreamManagerForTests> =
        createStreamManagerForTests(historyService, {
          streamText: scriptedStreamText([
            {
              chunks: [
                { type: "start-step" },
                () => {
                  seen.push(
                    streamManager.getStreamInfo(workspaceId)?.initialMetadata
                      ?.anthropicThinkingReplay
                  );
                  return Promise.resolve();
                },
                {
                  type: "tool-call",
                  toolCallId: "srvtoolu_1",
                  toolName: "web_search",
                  input: { query: "xum" },
                  providerExecuted: true,
                },
                {
                  type: "tool-result",
                  toolCallId: "srvtoolu_1",
                  toolName: "web_search",
                  output: [],
                  providerExecuted: true,
                },
                { type: "reasoning-delta", text: "read" },
                () => {
                  seen.push(
                    streamManager.getStreamInfo(workspaceId)?.initialMetadata
                      ?.anthropicThinkingReplay
                  );
                  return Promise.resolve();
                },
                { type: "finish-step", usage: TEST_USAGE },
                STOP_FINISH,
              ],
            },
          ]),
        });
      await runTurnForTests(streamManager, {
        workspaceId,
        model: createTestLanguageModel("claude-opus-5-5", "anthropic.messages"),
        modelString: "anthropic:claude-opus-5-5",
      });
      expect(seen).toEqual([undefined, "off"]);
    });

    test("a server tool with no thinking after it keeps thinking replay on", async () => {
      const workspaceId = "preserved-thinking-server-tool-last";
      // thinking "plan", server tool, then the answer: no block is bound to the native prefix.
      const serverToolThenText = () =>
        sse([
          messageStart,
          ...thinkingBlock(0, "plan", "sig-plan"),
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "server_tool_use",
              id: "srvtoolu_1",
              name: "web_search",
              input: { query: "xum" },
            },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "content_block_start",
            index: 2,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.com/xum",
                  title: "Xum",
                  encrypted_content: "enc-1",
                  page_age: null,
                },
              ],
            },
          },
          { type: "content_block_stop", index: 2 },
          { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "found" } },
          { type: "content_block_stop", index: 3 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 3 },
          },
          { type: "message_stop" },
        ]);
      const scripted = await runServerToolTurn(workspaceId, serverToolThenText);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const row = history.data.find((message) => message.id === scripted.messageId);
      expect(row?.metadata?.anthropicThinkingReplay).toBeUndefined();
      expect(thinkingTypes(await nextTurnBody(workspaceId, scripted))).toEqual(["thinking"]);
    });
  });
});
