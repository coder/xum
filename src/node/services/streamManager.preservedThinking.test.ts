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
import type { TurnEngineEvent } from "./streamManager";
import { ANTHROPIC_NATIVE_SERVER_TOOL_MAX_ROW_CIPHERTEXT_CHARS } from "@/constants/anthropicServerTools";
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

/** A successful web search result block's content, as the API returns it. */
const searchResults = [
  {
    type: "web_search_result",
    url: "https://example.com/xum",
    title: "Xum",
    encrypted_content: "enc-1",
    page_age: null,
  },
];
/** A failed web search: history does not replay it natively (#5887 scope). */
const searchError = { type: "web_search_tool_result_error", error_code: "unavailable" };

/** The SDK's stream output for a failed search: a server tool history does not replay natively. */
const nonNativeSearchOutput = { type: "web_search_tool_result_error", errorCode: "unavailable" };

/** server_tool_use web_search at `index`, then its web_search_tool_result at `index + 1`. */
function webSearchBlocks(index: number, content: unknown): unknown[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "xum" },
      },
    },
    { type: "content_block_stop", index },
    {
      type: "content_block_start",
      index: index + 1,
      content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content },
    },
    { type: "content_block_stop", index: index + 1 },
  ];
}

/**
 * One step with a server tool between thinking blocks (#5887): thinking "plan",
 * server_tool_use web_search, web_search_tool_result, thinking "read", client tool_use.
 */
const serverToolResponse =
  (content: unknown = searchResults) =>
  () =>
    sse([
      messageStart,
      ...thinkingBlock(0, "plan", "sig-plan"),
      ...webSearchBlocks(1, content),
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

  describe("server tool between thinking blocks (#5887)", () => {
    // History replays a successful Anthropic web_search natively (server_tool_use +
    // web_search_tool_result, ciphertext included), so the thinking after it stays valid.
    // Any other server tool (a failed search here) replays as a client tool_use/tool_result
    // pair: thinking after it is bound to a prefix Xum never sends again, so such a turn
    // writes the thinking-replay receipt and later requests in the context segment send no
    // thinking (removing all thinking blocks is valid per the preserved-thinking docs).
    // A scripted fixture proves the request shape, not upstream acceptance.
    const bashTool = () =>
      tool({
        inputSchema: z.object({ script: z.string() }),
        execute: () => Promise.resolve("/tmp"),
      });

    async function runServerToolTurn(
      workspaceId: string,
      first: () => Response,
      // The turn's later steps; the last textResponse answers the next turn's request.
      rest: Array<() => Response> = [textResponse]
    ) {
      const scripted = scriptedAnthropicModel([first, ...rest, textResponse]);
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
      const events: TurnEngineEvent[] = [];
      const streamManager = createStreamManagerForTests(historyService, {
        streamText: fakeStreamText((options) => aiSdk.streamText(options)),
        eventSink: (event) => {
          events.push(event);
        },
      });
      const { messageId } = await runTurnForTests(streamManager, {
        workspaceId,
        model: scripted.model,
        modelString: "anthropic:claude-opus-5-5",
        messages: [{ role: "user", content: "search" }],
        tools,
      });
      return { ...scripted, tools, messageId, events };
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

    test("a non-native server tool before thinking turns thinking replay off for the segment", async () => {
      const workspaceId = "preserved-thinking-server-tool";
      const scripted = await runServerToolTurn(workspaceId, serverToolResponse(searchError));

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
      // Stored as the client pair it was before native replay: an older build's SDK would
      // throw on a flagged result it cannot validate.
      const search = row?.parts.find(
        (part) => part.type === "dynamic-tool" && part.toolCallId === "srvtoolu_1"
      );
      expect(search?.type === "dynamic-tool" && search.providerExecuted).toBeFalsy();

      const next = await nextTurnBody(workspaceId, scripted);
      expect(thinkingTypes(next)).toEqual([]);
      expectPairedTools(next);
      expect(JSON.stringify(next)).toContain("done");
    });

    test("a search whose result opens the next step is stored as the client pair", async () => {
      // Claude called web_search and a client tool in one parallel group: the response ends
      // after both calls, and the API runs the search at the start of the next step
      // (platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools). One stored part
      // cannot replay the call and its result at their two positions, so the search is stored
      // as the client pair and the thinking after it is kept out (receipt).
      const workspaceId = "preserved-thinking-split-server-tool";
      const parallelCalls = () =>
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
            content_block: { type: "tool_use", id: "toolu_2", name: "bash", input: {} },
          },
          {
            type: "content_block_delta",
            index: 2,
            delta: { type: "input_json_delta", partial_json: '{"script":"pwd"}' },
          },
          { type: "content_block_stop", index: 2 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]);
      const resultThenThinking = () =>
        sse([
          messageStart,
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: searchResults,
            },
          },
          { type: "content_block_stop", index: 0 },
          ...thinkingBlock(1, "read", "sig-read"),
          { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "done" } },
          { type: "content_block_stop", index: 2 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ]);
      const scripted = await runServerToolTurn(workspaceId, parallelCalls, [resultThenThinking]);
      expect(scripted.bodies).toHaveLength(2);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const row = history.data.find((message) => message.id === scripted.messageId);
      expect(row?.metadata?.partial).not.toBe(true);
      expect(row?.metadata?.anthropicThinkingReplay).toBe("off");
      const search = row?.parts.find(
        (part) => part.type === "dynamic-tool" && part.toolCallId === "srvtoolu_1"
      );
      expect(search?.type === "dynamic-tool" && search.state).toBe("output-available");
      expect(search?.type === "dynamic-tool" && search.providerExecuted).toBeFalsy();
      expect(JSON.stringify(search)).not.toContain("enc-1");
      // The renderer gets the stored output: the dropped ciphertext does not cross IPC.
      const searchEnd = scripted.events.find(
        (event) => event.type === "tool-call-end" && event.toolCallId === "srvtoolu_1"
      );
      expect(searchEnd).toBeDefined();
      expect(JSON.stringify(searchEnd)).not.toContain("enc-1");

      const next = await nextTurnBody(workspaceId, scripted);
      expect(thinkingTypes(next)).toEqual([]);
      expectPairedTools(next);
      expect(JSON.stringify(next)).not.toContain("server_tool_use");
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
        scripted = await runServerToolTurn(workspaceId, serverToolResponse(searchError));
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
                  output: nonNativeSearchOutput,
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
                output: nonNativeSearchOutput,
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
                  output: nonNativeSearchOutput,
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

    test("replays a successful web search natively, in place, and writes no receipt", async () => {
      const workspaceId = "preserved-thinking-native-search";
      const scripted = await runServerToolTurn(workspaceId, serverToolResponse());
      // The SDK's in-turn replay is the reference: the API's block order, ciphertext included.
      const reference = firstAssistantBlocks(scripted.bodies[1]);
      expect(reference.map((block) => block.type)).toEqual([
        "thinking",
        "server_tool_use",
        "web_search_tool_result",
        "thinking",
        "tool_use",
      ]);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const row = history.data.find((message) => message.id === scripted.messageId);
      expect(row?.metadata?.anthropicThinkingReplay).toBeUndefined();
      const search = row?.parts.find(
        (part) => part.type === "dynamic-tool" && part.toolCallId === "srvtoolu_1"
      );
      expect(search?.type === "dynamic-tool" && search.providerExecuted).toBe(true);
      expect(JSON.stringify(search)).toContain("enc-1");

      // Each thinking signature binds to everything before it: the next turn sends the same
      // blocks, so the "read" thinking stays valid and nothing is stripped.
      const next = await nextTurnBody(workspaceId, scripted);
      expect(firstAssistantBlocks(next)).toEqual(reference);
      expect(thinkingTypes(next)).toEqual(["thinking", "thinking"]);
    });

    test("a search result with a null title replays natively without failing the request", async () => {
      // The SDK stream omits a null title, but its replay schema requires the key.
      const workspaceId = "preserved-thinking-null-title";
      const untitled = [{ ...searchResults[0], title: null }];
      const scripted = await runServerToolTurn(workspaceId, () =>
        sse([
          messageStart,
          ...thinkingBlock(0, "plan", "sig-plan"),
          ...webSearchBlocks(1, untitled),
          ...thinkingBlock(3, "read", "sig-read"),
          { type: "content_block_start", index: 4, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "found" } },
          { type: "content_block_stop", index: 4 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 3 },
          },
          { type: "message_stop" },
        ])
      );
      // Stored with the null the API returned, so any reader's SDK can validate it.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const search = history.data
        .find((message) => message.id === scripted.messageId)
        ?.parts.find((part) => part.type === "dynamic-tool" && part.toolCallId === "srvtoolu_1");
      expect(
        search?.type === "dynamic-tool" && search.state === "output-available" && search.output
      ).toEqual([
        {
          type: "web_search_result",
          url: "https://example.com/xum",
          title: null,
          pageAge: null,
          encryptedContent: "enc-1",
        },
      ]);
      const next = await nextTurnBody(workspaceId, scripted);
      const result = firstAssistantBlocks(next).find(
        (block) => block.type === "web_search_tool_result"
      );
      expect(result?.content).toEqual([
        {
          type: "web_search_result",
          url: "https://example.com/xum",
          title: null,
          encrypted_content: "enc-1",
          page_age: null,
        },
      ]);
    });

    test("three turns resend each request's blocks unchanged, so the cached prefix holds", async () => {
      // Prompt caching reuses the longest unchanged prefix (system, tools, then messages).
      // Each request must equal the previous one plus the previous reply, as the API returned
      // it, plus the new user turn. cache_control is checked on its own: Xum moves the message
      // breakpoint to the newest block on every request, which changes the JSON, not content.
      const workspaceId = "preserved-thinking-cache-prefix";
      const thinkingText = (n: number) => () =>
        sse([
          messageStart,
          ...thinkingBlock(0, `t${n}`, `sig-t${n}`),
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: `answer ${n}` },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ]);
      const searchThenText = () =>
        sse([
          messageStart,
          ...thinkingBlock(0, "plan", "sig-plan"),
          ...webSearchBlocks(1, searchResults),
          ...thinkingBlock(3, "read", "sig-read"),
          { type: "content_block_start", index: 4, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "found" } },
          { type: "content_block_stop", index: 4 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 3 },
          },
          { type: "message_stop" },
        ]);
      // What the API returned on each turn, in request-block form.
      const replies = [
        [
          { type: "thinking", thinking: "plan", signature: "sig-plan" },
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: { query: "xum" },
          },
          {
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
          { type: "thinking", thinking: "read", signature: "sig-read" },
          { type: "text", text: "found" },
        ],
        [
          { type: "thinking", thinking: "t2", signature: "sig-t2" },
          { type: "text", text: "answer 2" },
        ],
      ];
      const scripted = scriptedAnthropicModel([searchThenText, thinkingText(2), thinkingText(3)]);
      const tools = {
        web_search: scripted.provider.tools.webSearch_20250305({ maxUses: 5 }) as Tool,
      };
      const streamManager = createStreamManagerForTests(historyService, {
        streamText: fakeStreamText((options) => aiSdk.streamText(options)),
      });
      for (const [turn, text] of ["search", "next 2", "next 3"].entries()) {
        const appended = await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`user-${turn}`, "user", text, { historySequence: turn * 2 })
        );
        if (!appended.success) throw new Error(appended.error);
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!history.success) throw new Error(history.error);
        const payload = await assemblePromptPayload({
          history: history.data,
          systemMessage: "system",
          modelString: "anthropic:claude-opus-5-5",
          providerForMessages: "anthropic",
          effectiveThinkingLevel: "high",
          effectiveAgentId: "exec",
          toolNamesForSentinel: [],
          workspaceId,
        });
        await runTurnForTests(streamManager, {
          workspaceId,
          messageId: `assistant-${turn}`,
          historySequence: turn * 2 + 1,
          model: scripted.model,
          modelString: "anthropic:claude-opus-5-5",
          messages: payload.messages.filter((message) => message.role !== "system"),
          tools,
        });
      }

      const bodies = scripted.bodies as unknown as Array<Record<string, unknown>>;
      expect(bodies).toHaveLength(3);
      const withoutCacheControl = (value: unknown): unknown =>
        JSON.parse(
          JSON.stringify(value, (key, item: unknown) =>
            key === "cache_control" ? undefined : item
          )
        );
      const cacheControlPaths = (value: unknown, path = ""): string[] => {
        if (Array.isArray(value))
          return value.flatMap((item, i) => cacheControlPaths(item, `${path}[${i}]`));
        if (typeof value !== "object" || value === null) return [];
        return Object.entries(value).flatMap(([key, item]) =>
          key === "cache_control" ? [path] : cacheControlPaths(item, `${path}.${key}`)
        );
      };
      for (let turn = 1; turn < bodies.length; turn++) {
        const previous = bodies[turn - 1];
        const current = bodies[turn];
        const previousMessages = previous.messages as unknown[];
        const currentMessages = current.messages as unknown[];
        expect(withoutCacheControl(current.system)).toEqual(withoutCacheControl(previous.system));
        expect(withoutCacheControl(current.tools)).toEqual(withoutCacheControl(previous.tools));
        expect(withoutCacheControl(currentMessages.slice(0, previousMessages.length))).toEqual(
          withoutCacheControl(previousMessages)
        );
        expect(withoutCacheControl(currentMessages[previousMessages.length])).toEqual({
          role: "assistant",
          content: replies[turn - 1],
        });
        expect(currentMessages).toHaveLength(previousMessages.length + 2);
      }
      // The breakpoints: system and tools keep theirs; the message breakpoint sits on the
      // newest block only.
      const breakpoints = bodies.map((body) => cacheControlPaths(body));
      const lastBlock = (body: Record<string, unknown>) => {
        const messages = body.messages as Array<{ content: unknown[] }>;
        return `.messages[${messages.length - 1}].content[${messages.at(-1)!.content.length - 1}]`;
      };
      for (const [index, paths] of breakpoints.entries()) {
        const messagePaths = paths.filter((path) => path.startsWith(".messages"));
        expect(messagePaths).toEqual([lastBlock(bodies[index])]);
        expect(paths.filter((path) => !path.startsWith(".messages"))).toEqual(
          breakpoints[0].filter((path) => !path.startsWith(".messages"))
        );
      }
    });

    test("another provider's request gets the search as a client pair, without the ciphertext", async () => {
      const workspaceId = "preserved-thinking-native-to-openai";
      const scripted = await runServerToolTurn(workspaceId, serverToolResponse());
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const messages = await prepareMessagesForProvider({
        messagesWithSentinel: [
          ...history.data,
          createMuxMessage("user-2", "user", "next", { historySequence: 2 }),
        ],
        effectiveAgentId: "exec",
        toolNamesForSentinel: [],
        providerForMessages: "openai",
        effectiveThinkingLevel: "high",
        modelString: "openai:gpt-5.2",
        workspaceId,
      });
      expect(scripted.messageId).toBeDefined();
      const parts = messages.flatMap((message) =>
        Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []
      );
      // The OpenAI converter drops provider-executed calls it did not run: the pair keeps the
      // search in the transcript.
      expect(parts.filter((part) => part.providerExecuted === true)).toEqual([]);
      expect(
        parts.filter((part) => part.type === "tool-call" && part.toolName === "web_search")
      ).toHaveLength(1);
      expect(
        parts.filter((part) => part.type === "tool-result" && part.toolName === "web_search")
      ).toHaveLength(1);
      expect(JSON.stringify(messages)).not.toContain("enc-1");
    });

    test("a native row that lost its ciphertext replays as a client pair, with no thinking", async () => {
      // Without the ciphertext the SDK refuses to build the native block (no request at all),
      // and the thinking after it is bound to native blocks that are not sent.
      const workspaceId = "preserved-thinking-incomplete-native";
      const scripted = scriptedAnthropicModel([textResponse]);
      const row = createMuxMessage("assistant-1", "assistant", "", { historySequence: 1 }, [
        {
          type: "reasoning",
          text: "plan",
          providerOptions: { anthropic: { signature: "sig-plan" } },
        },
        {
          type: "dynamic-tool",
          toolCallId: "srvtoolu_1",
          toolName: "web_search",
          state: "output-available",
          input: { query: "xum" },
          providerExecuted: true,
          output: [
            {
              type: "web_search_result",
              url: "https://example.com/xum",
              title: "Xum",
              pageAge: null,
            },
          ],
        },
        {
          type: "reasoning",
          text: "read",
          providerOptions: { anthropic: { signature: "sig-read" } },
        },
        { type: "text", text: "found" },
      ]);
      const messages = await prepareMessagesForProvider({
        messagesWithSentinel: [
          createMuxMessage("user-1", "user", "search", { historySequence: 0 }),
          row,
          createMuxMessage("user-2", "user", "next", { historySequence: 2 }),
        ],
        effectiveAgentId: "exec",
        toolNamesForSentinel: [],
        providerForMessages: "anthropic",
        effectiveThinkingLevel: "high",
        modelString: "anthropic:claude-opus-5-5",
        workspaceId,
      });
      const replay = aiSdk.streamText({
        model: scripted.model,
        messages,
        tools: { web_search: scripted.provider.tools.webSearch_20250305({ maxUses: 5 }) as Tool },
        maxRetries: 0,
      });
      await replay.consumeStream();
      expect(scripted.bodies).toHaveLength(1);
      const body = scripted.bodies[0];
      expect(thinkingTypes(body)).toEqual([]);
      expectPairedTools(body);
      expect(JSON.stringify(body)).toContain("found");
    });

    test("searches past the row's ciphertext budget are stored as the client pair", async () => {
      const workspaceId = "preserved-thinking-row-ciphertext-budget";
      const search = (index: number, id: string, ciphertext: string) => [
        {
          type: "content_block_start",
          index,
          content_block: { type: "server_tool_use", id, name: "web_search", input: { query: id } },
        },
        { type: "content_block_stop", index },
        {
          type: "content_block_start",
          index: index + 1,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: id,
            // One result holds at most 12,000 chars (the generic sanitizer bound).
            content: Array.from({ length: Math.ceil(ciphertext.length / 12_000) }, (_, i) => ({
              ...searchResults[0],
              encrypted_content: ciphertext.slice(i * 12_000, (i + 1) * 12_000),
            })),
          },
        },
        { type: "content_block_stop", index: index + 1 },
      ];
      // Two searches that fit the budget only one at a time, then thinking after them.
      const half = "h".repeat(ANTHROPIC_NATIVE_SERVER_TOOL_MAX_ROW_CIPHERTEXT_CHARS / 2 + 1);
      const twoSearches = () =>
        sse([
          messageStart,
          ...thinkingBlock(0, "plan", "sig-plan"),
          ...search(1, "srvtoolu_1", half),
          ...search(3, "srvtoolu_2", half),
          ...thinkingBlock(5, "read", "sig-read"),
          { type: "content_block_start", index: 6, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 6, delta: { type: "text_delta", text: "done" } },
          { type: "content_block_stop", index: 6 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ]);
      const scripted = await runServerToolTurn(workspaceId, twoSearches, []);

      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      const row = history.data.find((message) => message.id === scripted.messageId);
      const stored = (row?.parts ?? []).flatMap((part) =>
        part.type === "dynamic-tool" ? [[part.toolCallId, part.providerExecuted === true]] : []
      );
      expect(stored).toEqual([
        ["srvtoolu_1", true],
        ["srvtoolu_2", false],
      ]);
      expect(JSON.stringify(row).length).toBeLessThan(
        ANTHROPIC_NATIVE_SERVER_TOOL_MAX_ROW_CIPHERTEXT_CHARS
      );
      // The second search is demoted with thinking after it: the receipt keeps it out.
      expect(row?.metadata?.anthropicThinkingReplay).toBe("off");
    });

    test("a native search replays its ciphertext byte for byte", async () => {
      // The signed thinking after the search is bound to the exact ciphertext. 12,000 chars is
      // the longest value the generic provider-output sanitizer leaves unchanged.
      const workspaceId = "preserved-thinking-long-ciphertext";
      const ciphertext = "c".repeat(12_000);
      const scripted = scriptedAnthropicModel([textResponse]);
      const row = createMuxMessage("assistant-1", "assistant", "", { historySequence: 1 }, [
        {
          type: "reasoning",
          text: "plan",
          providerOptions: { anthropic: { signature: "sig-plan" } },
        },
        {
          type: "dynamic-tool",
          toolCallId: "srvtoolu_1",
          toolName: "web_search",
          state: "output-available",
          input: { query: "xum" },
          providerExecuted: true,
          output: [
            {
              type: "web_search_result",
              url: "https://example.com/xum",
              title: "Xum",
              pageAge: null,
              encryptedContent: ciphertext,
            },
          ],
        },
        {
          type: "reasoning",
          text: "read",
          providerOptions: { anthropic: { signature: "sig-read" } },
        },
        { type: "text", text: "found" },
      ]);
      const messages = await prepareMessagesForProvider({
        messagesWithSentinel: [
          createMuxMessage("user-1", "user", "search", { historySequence: 0 }),
          row,
          createMuxMessage("user-2", "user", "next", { historySequence: 2 }),
        ],
        effectiveAgentId: "exec",
        toolNamesForSentinel: [],
        providerForMessages: "anthropic",
        effectiveThinkingLevel: "high",
        modelString: "anthropic:claude-opus-5-5",
        workspaceId,
      });
      const replay = aiSdk.streamText({
        model: scripted.model,
        messages,
        tools: { web_search: scripted.provider.tools.webSearch_20250305({ maxUses: 5 }) as Tool },
        maxRetries: 0,
      });
      await replay.consumeStream();
      expect(scripted.bodies).toHaveLength(1);
      const blocks = firstAssistantBlocks(scripted.bodies[0]);
      expect(blocks.map((block) => block.type)).toEqual([
        "thinking",
        "server_tool_use",
        "web_search_tool_result",
        "thinking",
        "text",
      ]);
      const content = blocks[2].content as Array<{ encrypted_content: string }>;
      expect(content[0].encrypted_content).toBe(ciphertext);
    });

    test("a client-pair row from before native replay keeps today's request shape", async () => {
      const workspaceId = "preserved-thinking-legacy-row";
      const scripted = scriptedAnthropicModel([textResponse]);
      const legacy = createMuxMessage("assistant-1", "assistant", "", { historySequence: 1 }, [
        {
          type: "reasoning",
          text: "plan",
          providerOptions: { anthropic: { signature: "sig-plan" } },
        },
        {
          type: "dynamic-tool",
          toolCallId: "srvtoolu_1",
          toolName: "web_search",
          state: "output-available",
          input: { query: "xum" },
          output: [
            {
              type: "web_search_result",
              url: "https://example.com/xum",
              title: "Xum",
              pageAge: null,
            },
          ],
        },
        {
          type: "reasoning",
          text: "read",
          providerOptions: { anthropic: { signature: "sig-read" } },
        },
        { type: "text", text: "found" },
      ]);
      const messages = await prepareMessagesForProvider({
        messagesWithSentinel: [
          createMuxMessage("user-1", "user", "search", { historySequence: 0 }),
          legacy,
          createMuxMessage("user-2", "user", "next", { historySequence: 2 }),
        ],
        effectiveAgentId: "exec",
        toolNamesForSentinel: [],
        providerForMessages: "anthropic",
        effectiveThinkingLevel: "high",
        modelString: "anthropic:claude-opus-5-5",
        workspaceId,
      });
      const replay = aiSdk.streamText({ model: scripted.model, messages, maxRetries: 0 });
      await replay.consumeStream();
      const body = scripted.bodies[0];
      // As on main: a client pair, and the thinking is still sent (no receipt, no native part).
      expectPairedTools(body);
      expect(thinkingTypes(body)).toEqual(["thinking", "thinking"]);
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
