import { createOpenAI } from "@ai-sdk/openai";
import { describe, expect, test } from "bun:test";
import { generateText, tool, type ModelMessage } from "ai";

import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import {
  LEGACY_TOOL_SEARCH_TOOL_NAME,
  normalizeLegacyToolSearchMessages,
  TOOL_SEARCH_TOOL_NAME,
} from "@/common/utils/tools/toolCatalog";

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
