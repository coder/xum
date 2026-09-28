import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { LanguageModel } from "ai";

import { createRuntime } from "@/node/runtime/runtimeFactory";
import {
  createStreamManagerForTests,
  fakeStreamText,
  onTurnEngineEvent,
} from "./streamManager.testHarness";

import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";

const model: LanguageModel = {
  specificationVersion: "v3",
  provider: "noop",
  modelId: "model",
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error("Unexpected generation in notification test")),
  doStream: () => Promise.reject(new Error("Unexpected stream in notification test")),
};

describe("StreamManager - model-only tool notifications", () => {
  let historyService: HistoryService;
  let historyCleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: historyCleanup } = await createTestHistoryService());
  });

  afterEach(async () => {
    await historyCleanup();
  });

  test("strips __mux_notifications before emitting tool-call-end", async () => {
    const mockStreamResult = {
      // eslint-disable-next-line @typescript-eslint/require-await
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "bash",
          input: { script: "echo hi" },
        };

        yield {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "bash",
          output: {
            ok: true,
            __mux_notifications: ["<notification>hello</notification>"],
          },
        };

        yield { type: "finish", finishReason: "stop" };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      providerMetadata: Promise.resolve({}),
      steps: Promise.resolve([]),
    };

    // The default no-op token tracker avoids tokenizer workers in unit tests.
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(() => mockStreamResult),
    });
    let completed = false;
    onTurnEngineEvent(streamManager, "stream-end", () => {
      completed = true;
    });

    const events: Array<{ toolName?: string; result?: unknown }> = [];
    onTurnEngineEvent(
      streamManager,
      "tool-call-end",
      (data: { toolName: string; result: unknown }) => {
        events.push({ toolName: data.toolName, result: data.result });
      }
    );

    await historyService.appendToHistory("test-workspace", {
      id: "test-message-1",
      role: "assistant",
      metadata: { historySequence: 1, partial: true },
      parts: [],
    });
    const result = await streamManager.startStream({
      workspaceId: "test-workspace",
      messageId: "test-message-1",
      model,
      modelString: "noop:model",
      messages: [{ role: "user", content: "hello" }],
      system: undefined,
      historySequence: 1,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      providedRuntimeTempDir: "", // Skip cleanup rm -rf
    });
    if (!result.success) throw new Error("Expected stream to start");
    await result.data.completion;
    expect(completed).toBe(true);

    const toolEnd = events.find((e) => e.toolName === "bash");
    expect(toolEnd).toBeDefined();

    expect(toolEnd?.result && typeof toolEnd.result === "object").toBe(true);
    expect("__mux_notifications" in (toolEnd!.result as Record<string, unknown>)).toBe(false);
  });

  test("persists orphan web_search tool-result when tool-call mapping is missing", async () => {
    const mockStreamResult = {
      // eslint-disable-next-line @typescript-eslint/require-await
      fullStream: (async function* () {
        yield {
          type: "tool-result",
          toolCallId: "orphan-web-search-1",
          toolName: "web_search",
          providerExecuted: true,
          output: {
            type: "json",
            value: [
              {
                title: "Example",
                url: "https://example.com",
                encryptedContent: "encrypted-payload",
              },
            ],
          },
        };

        yield { type: "finish", finishReason: "stop" };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      providerMetadata: Promise.resolve({}),
      steps: Promise.resolve([]),
    };

    // The default no-op token tracker avoids tokenizer workers in unit tests.
    const streamManager = createStreamManagerForTests(historyService, {
      streamText: fakeStreamText(() => mockStreamResult),
    });
    let completed = false;
    onTurnEngineEvent(streamManager, "stream-end", () => {
      completed = true;
    });

    const events: Array<{
      toolName?: string;
      result?: unknown;
      providerExecuted?: boolean;
    }> = [];
    onTurnEngineEvent(
      streamManager,
      "tool-call-end",
      (data: { toolName: string; result: unknown; providerExecuted?: boolean }) => {
        events.push({
          toolName: data.toolName,
          result: data.result,
          providerExecuted: data.providerExecuted,
        });
      }
    );

    await historyService.appendToHistory("test-workspace", {
      id: "test-message-orphan-web-search",
      role: "assistant",
      metadata: { historySequence: 1, partial: true },
      parts: [],
    });
    const result = await streamManager.startStream({
      workspaceId: "test-workspace",
      messageId: "test-message-orphan-web-search",
      model,
      modelString: "noop:model",
      messages: [{ role: "user", content: "hello" }],
      system: undefined,
      historySequence: 1,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      providedRuntimeTempDir: "", // Skip cleanup rm -rf
    });
    if (!result.success) throw new Error("Expected stream to start");
    await result.data.completion;
    expect(completed).toBe(true);

    // The committed assistant message is the persisted record of the stream.
    const history = await historyService.getLastMessages("test-workspace", 1);
    if (!history.success) throw new Error(history.error);
    const webSearchPart = (history.data[0]?.parts ?? []).find(
      (part) => "toolCallId" in part && part.toolCallId === "orphan-web-search-1"
    ) as
      | {
          state?: string;
          input?: unknown;
          output?: unknown;
        }
      | undefined;

    expect(webSearchPart).toBeDefined();
    expect(webSearchPart?.state).toBe("output-available");
    expect(webSearchPart?.input).toBeNull();

    expect(webSearchPart?.output && typeof webSearchPart.output === "object").toBe(true);
    const outputRecord = webSearchPart?.output as Record<string, unknown> | undefined;
    expect(outputRecord?.type).toBe("json");

    expect(Array.isArray(outputRecord?.value)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test assertion on dynamic tool output shape
    const firstResult = Array.isArray(outputRecord?.value) ? outputRecord.value[0] : undefined;
    expect(firstResult && typeof firstResult === "object").toBe(true);
    if (!firstResult || typeof firstResult !== "object") {
      throw new Error("Expected first web_search result object");
    }
    expect("encryptedContent" in firstResult).toBe(false);

    const toolEnd = events.find((event) => event.toolName === "web_search");
    expect(toolEnd).toBeDefined();
    expect(toolEnd?.providerExecuted).toBe(true);
  });
});
