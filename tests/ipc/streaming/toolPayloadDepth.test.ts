/**
 * Node-native (V8) regression for deep tool payloads. Bun/JSC stack limits
 * differ, so these run under Jest only:
 *
 * 1. Live: a tool call whose JSON input nests ~2100 deep used to abort the
 *    turn — the AI SDK re-parses the raw text for the invalid call and then
 *    overflows the stack cloning it at step finish (RangeError, reported as
 *    `context_exceeded`). With the depth guard the call is rejected before
 *    parsing, never executed (even for a permissive schema), and the turn
 *    settles normally.
 */
import { tmpdir } from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV3, MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type {
  LanguageModelV2,
  LanguageModelV2StreamPart,
  LanguageModelV3StreamPart,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { createMuxMessage } from "@/common/types/message";
import { MAX_TOOL_PAYLOAD_JSON_DEPTH } from "@/constants/json";
import { TOOL_PAYLOAD_DEPTH_REJECTION } from "@/common/utils/tools/toolPayloadDepth";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { StreamManager } from "@/node/services/streamManager";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { createToolInputDepthGuardMiddleware } from "@/node/services/toolInputDepthGuardMiddleware";

/** `{"payload":[[[…1…]]]}` with `depth` enclosing containers in total. */
function deepToolInputText(depth: number): string {
  return `{"payload":${"[".repeat(depth - 1)}1${"]".repeat(depth - 1)}}`;
}

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

type SpecVersion = "v2" | "v3" | "v4";
type MockToolCall = { toolCallId: string; toolName: string; input: string };

/**
 * The same two-step stream in each provider spec shape. v2/v3 models reach the
 * SDK through its own asLanguageModelV4 adapters, which is exactly how
 * ProviderModelFactory wraps them (CopilotResponses is v2; gateway declared v3).
 */
function mockModel(
  version: SpecVersion,
  onStream: (call: number, prompt: LanguageModelV4Prompt) => "tool-call" | "text",
  toolCall: MockToolCall
) {
  let calls = 0;
  const v4Chunks = (kind: "tool-call" | "text"): LanguageModelV4StreamPart[] =>
    kind === "tool-call"
      ? [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", ...toolCall },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
        ]
      : [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Done" },
          { type: "text-end", id: "answer" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ];
  const next = (prompt: LanguageModelV4Prompt) => onStream(++calls, prompt);
  if (version === "v4") {
    return new MockLanguageModelV4({
      doStream: (request) =>
        Promise.resolve({
          stream: simulateReadableStream({ chunks: v4Chunks(next(request.prompt)) }),
        }),
    });
  }
  if (version === "v3") {
    return new MockLanguageModelV3({
      // v3 and v4 share these part shapes.
      doStream: (request) =>
        Promise.resolve({
          stream: simulateReadableStream({
            chunks: v4Chunks(
              next(request.prompt as unknown as LanguageModelV4Prompt)
            ) as unknown as LanguageModelV3StreamPart[],
          }),
        }),
    });
  }
  const v2Usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
  const v2Chunks = (kind: "tool-call" | "text"): LanguageModelV2StreamPart[] =>
    kind === "tool-call"
      ? [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", ...toolCall },
          { type: "finish", finishReason: "tool-calls", usage: v2Usage },
        ]
      : [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Done" },
          { type: "text-end", id: "answer" },
          { type: "finish", finishReason: "stop", usage: v2Usage },
        ];
  const v2: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "mock-v2",
    modelId: "mock-v2",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("doGenerate is not used by this test")),
    doStream: (request) =>
      Promise.resolve({
        stream: simulateReadableStream({
          chunks: v2Chunks(next(request.prompt as unknown as LanguageModelV4Prompt)),
        }),
      }),
  };
  return v2;
}

async function runToolCallTurn(inputText: string, version: SpecVersion = "v4") {
  const h = await createTestHistoryService();
  const workspaceId = "tool-payload-depth";
  const messageId = "tool-payload-depth-assistant";
  const toolCallId = "permissive-call";
  const executeInputs: unknown[] = [];
  let providerCalls = 0;
  let retryPrompt: LanguageModelV4Prompt | undefined;
  const model = wrapLanguageModel({
    model: mockModel(
      version,
      (call, prompt) => {
        providerCalls = call;
        if (call === 2) retryPrompt = prompt;
        return call === 1 ? "tool-call" : "text";
      },
      { toolCallId, toolName: "permissive", input: inputText }
    ),
    middleware: createToolInputDepthGuardMiddleware(),
  });
  const manager = new StreamManager(h.historyService);
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "tool-payload-depth-"));
  try {
    const seeded = await h.historyService.appendManyToHistory(workspaceId, [
      createMuxMessage("user", "user", "Call the tool"),
      createMuxMessage(messageId, "assistant", ""),
    ]);
    if (!seeded.success) throw new Error(seeded.error);
    const started = await manager.startStream({
      workspaceId,
      messageId,
      historySequence: 1,
      model,
      modelString: "openai:gpt-4o",
      messages: [{ role: "user", content: "Call the tool" }],
      system: "Use tools",
      runtime: new LocalRuntime(h.tempDir),
      providedRuntimeTempDir: runtimeDir,
      tools: {
        // Accepts ANY object: a valid-JSON replacement would validate and execute.
        permissive: tool({
          description: "permissive test tool",
          inputSchema: z.record(z.string(), z.unknown()),
          execute: (input: unknown): Promise<{ ok: true }> => {
            executeInputs.push(input);
            return Promise.resolve({ ok: true });
          },
        }),
      },
    });
    if (!started.success) throw new Error("Expected stream construction");
    const completion = await started.data.completion;
    const committed = await h.historyService.commitPartial(workspaceId);
    if (!committed.success) throw new Error(committed.error);
    const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    const toolPart = history.data
      .find((row) => row.id === messageId)
      ?.parts.find((part) => part.type === "dynamic-tool");
    const retryToolResult = retryPrompt
      ?.flatMap((message) => (message.role === "tool" ? message.content : []))
      .find((part) => part.type === "tool-result" && part.toolCallId === toolCallId);
    return { completion, providerCalls, executeInputs, toolPart, retryToolResult };
  } finally {
    await manager.stopStream(workspaceId);
    await fs.rm(runtimeDir, { recursive: true, force: true });
    await h.cleanup();
  }
}

describe("tool payload depth guard (live stream)", () => {
  // 1200/2100 are the depths observed in the app (deeper real async stacks); in this
  // harness the SDK clone RangeError itself reproduces from ~4000 on the parent commit.
  test.each([1200, 2100, 4000, 6000])(
    "depth %i input is rejected before parsing, never executed, and the turn settles",
    async (depth) => {
      const run = await runToolCallTurn(deepToolInputText(depth));
      expect(run.completion.status).toBe("completed");
      expect(run.providerCalls).toBe(2);
      expect(run.executeInputs).toEqual([]);
      expect(run.toolPart).toMatchObject({
        state: "output-available",
        input: TOOL_PAYLOAD_DEPTH_REJECTION,
        output: { success: false },
      });
      // The model's same-turn retry sees an explicit invalid-input error, not the deep echo.
      if (run.retryToolResult?.type !== "tool-result") throw new Error("Expected a tool-result");
      expect(run.retryToolResult.output.type).toBe("error-text");
      if (run.retryToolResult.output.type !== "error-text") throw new Error("Expected error-text");
      expect(run.retryToolResult.output.value).toContain(TOOL_PAYLOAD_DEPTH_REJECTION);
      expect(run.retryToolResult.output.value).not.toContain("[[[[");
    }
  );

  // Non-v4 providers reach the SDK through its v2→v3→v4 adapters; the guard must see
  // their raw tool-call text too (review finding: gateway v3 / CopilotResponses v2).
  test.each([
    ["v2", 2100],
    ["v3", 2100],
    ["v2", 6000],
    ["v3", 6000],
  ] as const)("%s model: depth %i input is rejected and never executed", async (version, depth) => {
    const run = await runToolCallTurn(deepToolInputText(depth), version);
    expect(run.completion.status).toBe("completed");
    expect(run.providerCalls).toBe(2);
    expect(run.executeInputs).toEqual([]);
    expect(run.toolPart).toMatchObject({ input: TOOL_PAYLOAD_DEPTH_REJECTION });
  });

  test.each(["v2", "v3"] as const)(
    "%s model: shallow input executes unchanged",
    async (version) => {
      const run = await runToolCallTurn(deepToolInputText(2), version);
      expect(run.completion.status).toBe("completed");
      expect(run.executeInputs).toEqual([JSON.parse(deepToolInputText(2))]);
    }
  );

  test.each([2, MAX_TOOL_PAYLOAD_JSON_DEPTH])(
    "depth %i input passes through unchanged and executes",
    async (depth) => {
      const run = await runToolCallTurn(deepToolInputText(depth));
      expect(run.completion.status).toBe("completed");
      expect(run.executeInputs).toEqual([JSON.parse(deepToolInputText(depth))]);
      expect(run.toolPart).toMatchObject({
        state: "output-available",
        input: JSON.parse(deepToolInputText(depth)),
        output: { ok: true },
      });
    }
  );

  test("quoted brackets are not nesting", async () => {
    const text = JSON.stringify({ script: "[".repeat(MAX_TOOL_PAYLOAD_JSON_DEPTH * 2) + '\\"[[' });
    const run = await runToolCallTurn(text);
    expect(run.executeInputs).toEqual([JSON.parse(text)]);
  });
});
