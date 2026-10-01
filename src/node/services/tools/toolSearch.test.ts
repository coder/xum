import * as os from "node:os";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { describe, expect, test } from "bun:test";
import { generateText, stepCountIs, tool, type JSONValue, type ModelMessage } from "ai";
import { z } from "zod";

import { applyCacheControlToTools } from "@/common/utils/ai/cacheStrategy";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import {
  applyNativeToolSearchReplay,
  LEGACY_TOOL_SEARCH_TOOL_NAME,
  NATIVE_TOOL_SEARCH_MIN_DEFERRED_CHARS,
  normalizeLegacyToolSearchMessages,
  prepareToolSearch,
  TOOL_SEARCH_TOOL_NAME,
  type ToolSearchRuntime,
} from "@/common/utils/tools/toolCatalog";
import { wrapFetchWithAnthropicCacheControl } from "@/node/services/providerModelFactory";
import { createTestToolConfig } from "./testHelpers";
import { createToolSearchTool } from "./toolSearch";

describe("tool catalog search provider compatibility", () => {
  test("serializes as a custom function in OpenAI Responses history", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const captureFetch = Object.assign(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected the OpenAI provider to send a JSON string body");
        }
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "resp_test",
              model: "gpt-5.6-sol",
              output: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      },
      { preconnect: fetch.preconnect.bind(fetch) }
    );
    const openai = createOpenAI({ apiKey: "test", fetch: captureFetch });
    const result = {
      query: "workspace goal",
      matches: [{ name: "set_goal", description: "Create or replace a workspace goal" }],
      totalDeferred: 3,
    };
    const legacyMessages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: LEGACY_TOOL_SEARCH_TOOL_NAME,
            input: { query: result.query },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: LEGACY_TOOL_SEARCH_TOOL_NAME,
            output: { type: "json", value: result },
          },
        ],
      },
      { role: "user", content: "Continue" },
    ];
    const messages = normalizeLegacyToolSearchMessages(legacyMessages);

    await generateText({
      model: openai.responses("gpt-5.6-sol"),
      messages,
      tools: {
        [TOOL_SEARCH_TOOL_NAME]: tool({
          description: TOOL_DEFINITIONS.tool_catalog_search.description,
          inputSchema: TOOL_DEFINITIONS.tool_catalog_search.schema,
        }),
      },
      maxRetries: 0,
    });

    const input = capturedBody?.input as Array<Record<string, unknown>> | undefined;
    expect(input?.some((item) => item.type === "function_call")).toBe(true);
    expect(input?.some((item) => item.type === "function_call_output")).toBe(true);
    expect(input?.some((item) => item.type === "tool_search_output")).toBe(false);
  });
});

describe("tool catalog search native Anthropic deferred loading (#5262)", () => {
  const mcpNames = ["zulip_list_channels", "zulip_send_message"];
  // Large enough for native deferral (#5405); neutral prose keeps search scoring unchanged.
  const filler = " Lorem ipsum dolor sit amet.".repeat(
    Math.ceil(NATIVE_TOOL_SEARCH_MIN_DEFERRED_CHARS / 28)
  );

  function nativeTools(runtime: ToolSearchRuntime) {
    const prepared = prepareToolSearch({
      tools: {
        // Name-sorted like the production record, so a deferred tool is last.
        bash: tool({ description: "Run a shell command", inputSchema: z.object({}) }),
        [TOOL_SEARCH_TOOL_NAME]: createToolSearchTool({
          ...createTestToolConfig(os.tmpdir()),
          toolSearchRuntime: runtime,
        }),
        zulip_list_channels: tool({
          description: `List channels.${filler}`,
          inputSchema: z.object({}),
        }),
        zulip_send_message: tool({ description: "Send a message", inputSchema: z.object({}) }),
      },
      mcpToolNames: mcpNames,
      promptCacheActive: true,
    });
    runtime.state = prepared.state;
    return applyCacheControlToTools(prepared.tools, "anthropic:claude-sonnet-5-5");
  }

  test("toModelOutput follows the stream's mode at call time", async () => {
    const runtime: ToolSearchRuntime = {};
    const searchTool = nativeTools(runtime)[TOOL_SEARCH_TOOL_NAME];
    const options = { toolCallId: "call-1", messages: [], context: undefined };
    const output: unknown = await searchTool.execute!({ query: "zulip send" }, options);
    const toModelOutput = (value: unknown) =>
      searchTool.toModelOutput!({ toolCallId: "call-1", input: {}, output: value });
    expect(await toModelOutput(output)).toMatchObject({
      type: "content",
      value: [
        { providerOptions: { anthropic: { toolName: "zulip_send_message" } } },
        { providerOptions: { anthropic: { toolName: "zulip_list_channels" } } },
      ],
    });
    runtime.state!.native = false;
    expect(await toModelOutput(output)).toEqual({ type: "json", value: output as JSONValue });
  });

  test("sends defer_loading, keeps the tools block, and replays tool_reference bytes", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const captureFetch = Object.assign(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        const content =
          bodies.length === 1
            ? [
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: TOOL_SEARCH_TOOL_NAME,
                  input: { query: "zulip send" },
                },
              ]
            : [{ type: "text", text: "ok" }];
        const usage = { input_tokens: 1, output_tokens: 1 };
        const stop_reason = bodies.length === 1 ? "tool_use" : "end_turn";
        return Promise.resolve(
          Response.json({
            id: "m",
            type: "message",
            role: "assistant",
            content,
            stop_reason,
            usage,
          })
        );
      },
      { preconnect: fetch.preconnect.bind(fetch) }
    );
    const model = createAnthropic({
      apiKey: "test",
      fetch: wrapFetchWithAnthropicCacheControl(captureFetch),
    })("claude-sonnet-5-5");
    const runtime: ToolSearchRuntime = {};
    const tools = nativeTools(runtime);

    const live = await generateText({
      model,
      prompt: "Find the Zulip tool.",
      tools,
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1].tools)).toBe(JSON.stringify(bodies[0].tools));
    const wireTools = bodies[0].tools as Array<Record<string, unknown>>;
    expect(
      wireTools.filter((entry) => entry.defer_loading === true).map((entry) => entry.name)
    ).toEqual(mcpNames);
    expect(
      wireTools.filter((entry) => entry.cache_control != null).map((entry) => entry.name)
    ).toEqual([TOOL_SEARCH_TOOL_NAME]);
    const toolResultOf = (body: Record<string, unknown>) =>
      (body.messages as Array<{ content: Array<Record<string, unknown>> }>)
        .flatMap((message) => message.content)
        .find((block) => block.type === "tool_result");
    const liveResult = toolResultOf(bodies[1]);
    expect(liveResult?.content).toEqual([
      { type: "tool_reference", tool_name: "zulip_send_message" },
      { type: "tool_reference", tool_name: "zulip_list_channels" },
    ]);

    // Next turn: history persists the raw result, which converts to a json output.
    const persisted: unknown = live.steps[0].toolResults[0].output;
    const history: ModelMessage[] = [
      { role: "user", content: "Find the Zulip tool." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_1",
            toolName: TOOL_SEARCH_TOOL_NAME,
            input: { query: "zulip send" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_1",
            toolName: TOOL_SEARCH_TOOL_NAME,
            output: { type: "json", value: persisted as JSONValue },
          },
        ],
      },
      { role: "user", content: "Continue" },
    ];
    await generateText({
      model,
      messages: applyNativeToolSearchReplay(history, runtime.state!.deferredToolNames),
      tools,
      maxRetries: 0,
    });
    const replayed = toolResultOf(bodies[2]);
    expect(JSON.stringify(replayed?.content)).toBe(JSON.stringify(liveResult?.content));
  });
});
