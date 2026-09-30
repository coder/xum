import { describe, expect, it } from "bun:test";
import type { AssistantModelMessage, ModelMessage } from "ai";

import { flattenProviderExecutedToolParts } from "./flattenProviderExecutedToolParts";

type AssistantContentPart = Exclude<AssistantModelMessage["content"], string>[number];
type AssistantToolResultOutput = Extract<AssistantContentPart, { type: "tool-result" }>["output"];

function getAssistantParts(message: ModelMessage): AssistantContentPart[] {
  expect(message.role).toBe("assistant");
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    throw new Error("Expected assistant message with array content");
  }
  return message.content;
}

describe("flattenProviderExecutedToolParts", () => {
  it("flattens provider-executed tool-call and assistant tool-result parts to text", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "look this up" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching..." },
          {
            type: "tool-call",
            toolCallId: "srvtoolu_013m4MqeeoVpBWdeyQvGkvqQ",
            toolName: "web_search",
            input: { query: "mux advisor bug" },
            providerExecuted: true,
            providerOptions: { anthropic: { foo: "bar" } },
          },
          {
            type: "tool-result",
            toolCallId: "srvtoolu_013m4MqeeoVpBWdeyQvGkvqQ",
            toolName: "web_search",
            output: { type: "json", value: [{ url: "https://example.com", title: "Result" }] },
            providerOptions: { anthropic: { foo: "bar" } },
          },
        ],
      },
    ];

    const result = flattenProviderExecutedToolParts(messages);
    expect(result).not.toBe(messages);
    // User message untouched (referentially equal).
    expect(result[0]).toBe(messages[0]);

    const parts = getAssistantParts(result[1]);
    expect(parts).toHaveLength(3);
    // Pre-existing text part untouched.
    expect(parts[0]).toBe(getAssistantParts(messages[1])[0]);
    // No tool parts remain.
    expect(parts.every((part) => part.type !== "tool-call" && part.type !== "tool-result")).toBe(
      true
    );

    const callPart = parts[1];
    const resultPart = parts[2];
    expect(callPart.type).toBe("text");
    expect(resultPart.type).toBe("text");
    if (callPart.type !== "text" || resultPart.type !== "text") {
      throw new Error("Expected flattened text parts");
    }
    // Payloads survive flattening.
    expect(callPart.text).toContain("web_search");
    expect(callPart.text).toContain("mux advisor bug");
    expect(resultPart.text).toContain("web_search");
    expect(resultPart.text).toContain("https://example.com");
    // Leak prevention: flattened parts carry only { type, text } — no
    // provider-specific ids/options that could resolve to item_references.
    for (const part of [callPart, resultPart]) {
      expect(Object.keys(part).sort()).toEqual(["text", "type"]);
    }
  });

  it("leaves client tool call/result pairs and non-assistant messages unchanged", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "be helpful" },
      { role: "user", content: "run the tool" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_client_1",
            toolName: "bash",
            input: { script: "ls" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_client_1",
            toolName: "bash",
            output: { type: "json", value: { exitCode: 0 } },
          },
        ],
      },
      { role: "assistant", content: "done" },
    ];

    const result = flattenProviderExecutedToolParts(messages);
    // No provider-executed parts → the exact same array reference is returned.
    expect(result).toBe(messages);
  });

  it("stringifies each tool-result output union member", () => {
    const outputs: Array<{ output: AssistantToolResultOutput; expected: string }> = [
      { output: { type: "text", value: "plain text output" }, expected: "plain text output" },
      { output: { type: "error-text", value: "boom failed" }, expected: "boom failed" },
      { output: { type: "json", value: { answer: 42 } }, expected: '{"answer":42}' },
      // Error-shaped fixture: provider-executed tool errors are normalized
      // into tool-result parts with error-json output upstream.
      {
        output: { type: "error-json", value: { errorText: "rate limited" } },
        expected: '{"errorText":"rate limited"}',
      },
      {
        output: { type: "content", value: [{ type: "text", text: "inline content" }] },
        expected: '[{"type":"text","text":"inline content"}]',
      },
    ];

    for (const { output, expected } of outputs) {
      const result = flattenProviderExecutedToolParts([
        {
          role: "assistant",
          content: [
            { type: "tool-result", toolCallId: "srvtoolu_x", toolName: "web_fetch", output },
          ],
        },
      ]);
      const part = getAssistantParts(result[0])[0];
      expect(part.type).toBe("text");
      if (part.type !== "text") {
        throw new Error("Expected flattened text part");
      }
      expect(part.text).toBe(`[Server tool result: web_fetch] ${expected}`);
    }
  });

  it("flattens the paired inline client tool-call together with its result", () => {
    // Contrived but type-legal shape: a non-providerExecuted tool-call whose
    // result lives inline in the same assistant message. Flattening only the
    // result would leave a bare tool-call, which providers reject.
    const result = flattenProviderExecutedToolParts([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_inline_pair",
            toolName: "bash",
            input: { script: "ls" },
          },
          {
            type: "tool-result",
            toolCallId: "toolu_inline_pair",
            toolName: "bash",
            output: { type: "json", value: { exitCode: 0 } },
          },
        ],
      },
    ]);

    const parts = getAssistantParts(result[0]);
    expect(parts.every((part) => part.type === "text")).toBe(true);
  });

  it("strips encryptedContent from web search results before stringifying", () => {
    const result = flattenProviderExecutedToolParts([
      {
        role: "assistant",
        content: [
          {
            type: "tool-result",
            toolCallId: "srvtoolu_websearch",
            toolName: "web_search",
            output: {
              type: "json",
              value: [
                {
                  url: "https://example.com",
                  title: "Result",
                  encryptedContent: "OPAQUE_ENCRYPTED_BLOB",
                },
              ],
            },
          },
        ],
      },
    ]);

    const part = getAssistantParts(result[0])[0];
    expect(part.type).toBe("text");
    if (part.type !== "text") {
      throw new Error("Expected flattened text part");
    }
    expect(part.text).toContain("https://example.com");
    expect(part.text).not.toContain("OPAQUE_ENCRYPTED_BLOB");
  });

  it("self-heals on unstringifiable payloads instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = flattenProviderExecutedToolParts([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "srvtoolu_circular",
            toolName: "web_search",
            input: circular,
            providerExecuted: true,
          },
          {
            type: "tool-call",
            toolCallId: "srvtoolu_undefined",
            toolName: "web_search",
            input: undefined,
            providerExecuted: true,
          },
        ],
      },
    ]);

    for (const part of getAssistantParts(result[0])) {
      expect(part.type).toBe("text");
      if (part.type !== "text") {
        throw new Error("Expected flattened text part");
      }
      expect(typeof part.text).toBe("string");
      expect(part.text.length).toBeGreaterThan(0);
    }
  });
});
