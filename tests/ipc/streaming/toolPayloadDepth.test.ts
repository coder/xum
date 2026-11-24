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
 * 2. Persisted: an already-committed deep row must not brick request
 *    building or later compactions (boundary + tail-copy re-serialization).
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
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
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
interface MockToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
}

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
        input: JSON.parse(deepToolInputText(depth)) as unknown,
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

/** Assistant row with one completed dynamic-tool part carrying the given input/output. */
function toolRow(id: string, input: unknown, output: unknown): MuxMessage {
  return {
    id,
    role: "assistant",
    metadata: { timestamp: 1 },
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: `${id}-call`,
        toolName: "permissive",
        state: "output-available",
        input,
        output,
        timestamp: 1,
      },
    ],
  };
}

function nestedArray(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

/** JSON.stringify without recursion: serialize the deep array by text. */
function toolRowLine(id: string, workspaceId: string, sequence: number, depth: number): string {
  const row = toolRow(id, "$INPUT$", "$OUTPUT$");
  row.metadata = { ...row.metadata, historySequence: sequence };
  const shallow = JSON.stringify({ ...row, workspaceId });
  const deep = "[".repeat(depth) + "1" + "]".repeat(depth);
  return shallow.replace('"$INPUT$"', deep).replace('"$OUTPUT$"', deep) + "\n";
}

describe("tool payload depth bound (persisted history)", () => {
  // 2101 is the observed persisted depth; 6000 fails JSON.stringify/structuredClone
  // deterministically in isolation on Node 22, so it proves the rewrite path itself.
  test.each([2101, 6000])(
    "a committed depth-%i row loads flattened and survives two boundary commits with tail copies",
    async (depth) => {
      const h = await createTestHistoryService();
      const workspaceId = "deep-row-compaction";
      try {
        const first = await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("u1", "user", "before")
        );
        if (!first.success) throw new Error(first.error);
        const chatPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
        const deepLine = toolRowLine("deep", workspaceId, 1, depth);
        await fs.appendFile(chatPath, deepLine);
        const control = toolRow("control", nestedArray(MAX_TOOL_PAYLOAD_JSON_DEPTH), { ok: true });
        const appended = await h.historyService.appendManyToHistory(workspaceId, [
          control,
          createMuxMessage("u2", "user", "after"),
        ]);
        if (!appended.success) throw new Error(appended.error);
        const controlLine = (await fs.readFile(chatPath, "utf8"))
          .split("\n")
          .find((line) => line.includes('"id":"control"'));

        const loaded = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!loaded.success) throw new Error(loaded.error);
        expect(loaded.data.map((row) => row.id)).toEqual(["u1", "deep", "control", "u2"]);
        const deepRow = loaded.data[1];
        expect(deepRow.metadata).toMatchObject({ historySequence: 1, timestamp: 1 });
        expect(deepRow.parts[0]).toMatchObject({
          type: "dynamic-tool",
          toolCallId: "deep-call",
          input: TOOL_PAYLOAD_DEPTH_REJECTION,
          output: TOOL_PAYLOAD_DEPTH_REJECTION,
        });
        // At the bound: untouched (the value walker agrees with the text scanner).
        expect(loaded.data[2].parts[0]).toMatchObject({
          input: nestedArray(MAX_TOOL_PAYLOAD_JSON_DEPTH),
          output: { ok: true },
        });

        // Two consecutive compactions, each re-serializing the flattened deep row as a tail copy.
        for (let round = 0; round < 2; round++) {
          const view = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
          if (!view.success) throw new Error(view.error);
          const tailCopies = view.data
            .filter((row) => row.id === "deep" || row.id.startsWith("copy-"))
            .map((row) => ({
              ...row,
              id: `copy-${round}-${row.id}`,
              metadata: { synthetic: true, rlmPreservedTailCopy: true },
            }));
          expect(tailCopies.length).toBeGreaterThan(0);
          // Same durable-boundary metadata the compaction handler writes.
          const summary = createMuxMessage(`summary-${round}`, "assistant", "summary", {
            timestamp: 1,
            compacted: "user",
            compactionBoundary: true,
            compactionEpoch: round + 1,
          });
          const persisted = await h.historyService.persistBoundaryWithTailCopies(
            workspaceId,
            summary,
            tailCopies,
            false
          );
          expect(persisted).toEqual({ success: true, data: undefined });
          const after = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
          if (!after.success) throw new Error(after.error);
          expect(after.data[0].id).toBe(`summary-${round}`);
          expect(after.data.map((row) => row.id)).toEqual(
            expect.arrayContaining(tailCopies.map((copy) => copy.id))
          );
        }

        // Raw evidence: the sealed epoch was archived byte-for-byte, including the deep row.
        const archive = await fs.readFile(
          path.join(h.config.sessionsDir, workspaceId, "chat-archive.jsonl"),
          "utf8"
        );
        expect(archive).toContain(deepLine);
        expect(archive).toContain(controlLine);
        // Every row now in the active epoch (or archived) has a bounded copy or original.
        const everything = await h.historyService.getLastMessages(workspaceId, 100);
        if (!everything.success) throw new Error(everything.error);
        for (const row of everything.data) {
          for (const part of row.parts) {
            if (part.type !== "dynamic-tool") continue;
            expect(() => JSON.stringify(part)).not.toThrow();
          }
        }
      } finally {
        await h.cleanup();
      }
    }
  );

  // code_execution persists sub-calls under part.nestedCalls with their own payloads;
  // a deep nested input/output must be bounded like the parent's, everything else kept.
  test("a deep nested call inside a code_execution partial is bounded on read, promotion and rewrite", async () => {
    const h = await createTestHistoryService();
    const workspaceId = "deep-nested-partial";
    try {
      const first = await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "before")
      );
      if (!first.success) throw new Error(first.error);
      const placeholder = await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("ce-assistant", "assistant", "")
      );
      if (!placeholder.success) throw new Error(placeholder.error);
      const healthyCall = {
        toolCallId: "n-healthy",
        toolName: "bash",
        input: { script: "true" },
        output: { ok: true },
        state: "output-available" as const,
        timestamp: 2,
      };
      const row: MuxMessage = {
        id: "ce-assistant",
        role: "assistant",
        metadata: { timestamp: 1, historySequence: 1 },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "ce-call",
            toolName: "code_execution",
            state: "output-available",
            input: { code: "await xum.bash({ script: 'true' })" },
            output: { ok: true },
            timestamp: 1,
            nestedCalls: [
              healthyCall,
              {
                toolCallId: "n-deep",
                toolName: "file_read",
                input: "$NESTED_INPUT$",
                output: { ok: true },
                state: "output-available",
                failed: false,
                timestamp: 3,
              },
            ],
          },
        ],
      };
      const deep = "[".repeat(6000) + "1" + "]".repeat(6000);
      const partialPath = path.join(h.config.sessionsDir, workspaceId, "partial.json");
      await fs.writeFile(
        partialPath,
        JSON.stringify({ ...row, workspaceId }).replace('"$NESTED_INPUT$"', deep)
      );

      const partial = await h.historyService.readPartial(workspaceId);
      const part = partial?.parts[0];
      if (part?.type !== "dynamic-tool") throw new Error("Expected the code_execution part");
      expect(part.input).toEqual({ code: "await xum.bash({ script: 'true' })" });
      expect(part.nestedCalls?.[0]).toEqual(healthyCall);
      expect(part.nestedCalls?.[1]).toEqual({
        toolCallId: "n-deep",
        toolName: "file_read",
        input: TOOL_PAYLOAD_DEPTH_REJECTION,
        output: { ok: true },
        state: "output-available",
        failed: false,
        timestamp: 3,
      });

      const committed = await h.historyService.commitPartial(workspaceId);
      expect(committed).toEqual({ success: true, data: undefined });
      await expect(fs.access(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
      const chatPath = path.join(h.config.sessionsDir, workspaceId, "chat.jsonl");
      const chat = await fs.readFile(chatPath, "utf8");
      expect(chat).toContain(TOOL_PAYLOAD_DEPTH_REJECTION);
      expect(chat).not.toContain("[".repeat(300));

      // Healthy nested calls survive a rewrite byte-for-byte (same-reference rows stay raw).
      const controlLine = chat.split("\n").find((line) => line.includes('"id":"ce-assistant"'));
      const summary = createMuxMessage("summary", "assistant", "summary", {
        timestamp: 1,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      });
      const persisted = await h.historyService.persistBoundaryWithTailCopies(
        workspaceId,
        summary,
        [],
        false
      );
      expect(persisted).toEqual({ success: true, data: undefined });
      const archive = await fs.readFile(
        path.join(h.config.sessionsDir, workspaceId, "chat-archive.jsonl"),
        "utf8"
      );
      expect(archive).toContain(controlLine);
    } finally {
      await h.cleanup();
    }
  });

  test("a deep interrupted partial is recovered flattened and promoted", async () => {
    const h = await createTestHistoryService();
    const workspaceId = "deep-partial";
    try {
      const first = await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "before")
      );
      if (!first.success) throw new Error(first.error);
      // The streaming placeholder row already holds the sequence the partial carries.
      const placeholder = await h.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("partial-assistant", "assistant", "")
      );
      if (!placeholder.success) throw new Error(placeholder.error);
      const partialPath = path.join(h.config.sessionsDir, workspaceId, "partial.json");
      await fs.writeFile(partialPath, toolRowLine("partial-assistant", workspaceId, 1, 6000));
      const partial = await h.historyService.readPartial(workspaceId);
      expect(partial?.parts[0]).toMatchObject({
        input: TOOL_PAYLOAD_DEPTH_REJECTION,
        output: TOOL_PAYLOAD_DEPTH_REJECTION,
      });
      const committed = await h.historyService.commitPartial(workspaceId);
      expect(committed).toEqual({ success: true, data: undefined });
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!history.success) throw new Error(history.error);
      expect(history.data.map((row) => row.id)).toEqual(["u1", "partial-assistant"]);
      expect(history.data[1].parts[0]).toMatchObject({ input: TOOL_PAYLOAD_DEPTH_REJECTION });
      // Receipt of intentional replacement: promotion persists the flattened row and
      // deletes partial.json, so — unlike archive rotation — the deep raw partial is NOT
      // retained anywhere on disk.
      await expect(fs.access(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
      const chat = await fs.readFile(
        path.join(h.config.sessionsDir, workspaceId, "chat.jsonl"),
        "utf8"
      );
      expect(chat).toContain(TOOL_PAYLOAD_DEPTH_REJECTION);
      expect(chat).not.toContain("[".repeat(300));
    } finally {
      await h.cleanup();
    }
  });
});
