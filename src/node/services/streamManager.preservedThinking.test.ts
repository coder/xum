import { describe, expect, test } from "bun:test";
import * as aiSdk from "ai";
import { tool } from "ai";
import { z } from "zod";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { prepareMessagesForProvider } from "./messagePipeline";
import { createStreamManagerForTests, fakeStreamText } from "./streamManager.testHarness";
import {
  historyService,
  installStreamManagerTestHistory,
  runTurnForTests,
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
  const model = createAnthropic({
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
  })("claude-opus-5-5");
  return { model, bodies };
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
});
