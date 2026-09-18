import { tmpdir } from "node:os";
import { prepareToolSearch, type ToolSearchRuntime } from "@/common/utils/tools/toolCatalog";
import { createToolSearchTool } from "./tools/toolSearch";
import { createTestToolConfig } from "./tools/testHelpers";
import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { tool } from "ai";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import { applyWorkspaceChatEventToAggregator } from "@/browser/utils/messages/applyWorkspaceChatEventToAggregator";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas/stream";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { evaluateStepBudget } from "@/common/utils/compaction/contextBudget";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { StreamManager, type SettledStepBudget, type TurnEngineEvent } from "./streamManager";
import { onTurnEngineEvent } from "./streamManager.testHarness";
import { createTestHistoryService } from "./testHistoryService";

describe("settled context hard ceiling", () => {
  test.each(["inactive", "activation-fits", "activation-overflow", "search-off"] as const)(
    "checks actual active schemas before each provider step (%s)",
    async (mode) => {
      const h = await createTestHistoryService();
      const workspaceId = "catalog-budget";
      const messageId = "catalog-assistant";
      let providerCalls = 0;
      const searchRuntime: ToolSearchRuntime = {};
      const tools = {
        tool_catalog_search: createToolSearchTool({
          ...createTestToolConfig(h.tempDir),
          toolSearchRuntime: searchRuntime,
        }),
        mcp_large: tool({
          description: "Large catalog schema",
          inputSchema: z.object({
            argument: z.string().describe("漢".repeat(mode === "activation-fits" ? 100 : 10000)),
          }),
        }),
      };
      const search = prepareToolSearch({ tools, mcpToolNames: ["mcp_large"] });
      searchRuntime.state = search.state;
      const model = new MockLanguageModelV3({
        doStream: (request) => {
          providerCalls++;
          const activate = providerCalls === 1 && mode !== "inactive" && mode !== "search-off";
          expect(request.tools?.some((entry) => entry.name === "mcp_large")).toBe(
            providerCalls > 1
          );
          return Promise.resolve({
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                ...(activate
                  ? [
                      {
                        type: "tool-call" as const,
                        toolCallId: "activation",
                        toolName: "tool_catalog_search",
                        input: '{"query":"mcp_large"}',
                      },
                    ]
                  : [
                      { type: "text-start" as const, id: "answer" },
                      { type: "text-delta" as const, id: "answer", delta: "Done" },
                      { type: "text-end" as const, id: "answer" },
                    ]),
                {
                  type: "finish",
                  finishReason: {
                    unified: activate ? "tool-calls" : "stop",
                    raw: activate ? "tool_calls" : "stop",
                  },
                  usage: {
                    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 10, text: 10, reasoning: 0 },
                  },
                },
              ],
            }),
          });
        },
      });
      const manager = new StreamManager(h.historyService);
      const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "context-budget-stream-"));
      try {
        expect(
          (
            await h.historyService.appendManyToHistory(workspaceId, [
              createMuxMessage("user", "user", "Use the catalog"),
              createMuxMessage(messageId, "assistant", ""),
            ])
          ).success
        ).toBe(true);
        const started = await manager.startStream({
          workspaceId,
          messageId,
          historySequence: 1,
          model,
          modelString: "openai:gpt-4o",
          messages: [{ role: "user", content: "Use the catalog" }],
          system: "Use tools",
          runtime: new LocalRuntime(h.tempDir),
          providedRuntimeTempDir: runtimeDir,
          tools: search.tools,
          toolSearchState: mode === "search-off" ? undefined : search.state,
          contextBudgetLimit: 10000,
        });
        expect(started.success).toBe(true);
        if (!started.success) throw new Error("Expected stream construction");
        const completion = await started.data.completion;
        const blocked = mode === "activation-overflow" || mode === "search-off";
        expect(completion.status).toBe(blocked ? "failed" : "completed");
        if (completion.status === "failed") {
          expect(completion.streamError.errorType).toBe("context_budget_blocked");
          expect(completion.streamError.contextBudgetExceeded).toBeUndefined();
        }
        expect(providerCalls).toBe(mode === "search-off" ? 0 : mode === "activation-fits" ? 2 : 1);
        const activated = [...search.state!.activatedToolNames];
        expect(activated).toEqual(mode.startsWith("activation") ? ["mcp_large"] : []);
        expect((await h.historyService.commitPartial(workspaceId)).success).toBe(true);
        const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!history.success) throw new Error(history.error);
        const toolResults = history.data.flatMap((row) =>
          row.parts.filter((part) => part.type === "dynamic-tool")
        );
        expect(toolResults).toHaveLength(activated.length);
        if (activated.length)
          expect(toolResults[0]).toMatchObject({
            toolCallId: "activation",
            state: "output-available",
            output: { matches: [{ name: "mcp_large" }] },
          });
        expect(
          history.data.some((row) => row.metadata?.muxMetadata?.type === "context-window-rollover")
        ).toBe(false);
      } finally {
        await manager.stopStream(workspaceId);
        await fs.rm(runtimeDir, { recursive: true, force: true });
        await h.cleanup();
      }
    }
  );

  test.each(["thinking", "fallback"] as const)(
    "late %s rebuild uses its actual messages and model limit before provider dispatch",
    async (mode) => {
      const h = await createTestHistoryService();
      const manager = new StreamManager(h.historyService);
      const workspaceId = "rebuilt-budget";
      const messageId = "rebuilt-assistant";
      const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "context-budget-stream-"));
      let primaryCalls = 0;
      let fallbackCalls = 0;
      const primary = new MockLanguageModelV3({
        doStream: () => {
          primaryCalls++;
          return Promise.resolve({
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                {
                  type: "finish",
                  finishReason: { unified: "content-filter", raw: "refusal" },
                  usage: {
                    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 0, text: 0, reasoning: 0 },
                  },
                },
              ],
            }),
          });
        },
      });
      const fallback = new MockLanguageModelV3({
        doStream: () => {
          fallbackCalls++;
          throw new Error("Oversized rebuilt request reached the provider");
        },
      });
      const large = "漢".repeat(10000);
      try {
        expect(
          (
            await h.historyService.appendManyToHistory(workspaceId, [
              createMuxMessage("user", "user", "Small request"),
              createMuxMessage(messageId, "assistant", ""),
            ])
          ).success
        ).toBe(true);
        const started = await manager.startStream({
          workspaceId,
          messageId,
          historySequence: 1,
          model: primary,
          modelString: "openai:gpt-4o",
          messages: [{ role: "user", content: "Small request" }],
          system: "Small system",
          runtime: new LocalRuntime(h.tempDir),
          providedRuntimeTempDir: runtimeDir,
          contextBudgetLimit: mode === "fallback" ? 100000 : 10000,
          ...(mode === "thinking"
            ? {
                thinkingOverrideState: { pending: "high" as const },
                rebuildProviderOptionsForThinkingLevel: () => ({
                  providerOptions: {},
                  effectiveLevel: "high" as const,
                }),
                rebuildFirstStepForThinkingLevel: () =>
                  Promise.resolve([{ role: "user" as const, content: large }]),
              }
            : {
                modelFallback: {
                  chain: ["openai:gpt-4o-mini"],
                  prepare: (modelString: string) =>
                    Promise.resolve({
                      success: true as const,
                      data: {
                        model: fallback,
                        modelString,
                        messages: [{ role: "user" as const, content: "Small request" }],
                        system: "Small system",
                        tools: {
                          activated: tool({ description: large, inputSchema: z.object({}) }),
                        },
                        contextBudgetLimit: 10000,
                      },
                    }),
                },
              }),
        });
        if (!started.success) throw new Error("Expected stream construction");
        const completion = await started.data.completion;
        expect(completion).toMatchObject({
          status: "failed",
          streamError: { errorType: "context_budget_blocked" },
        });
        if (completion.status === "failed") {
          expect(completion.streamError.contextBudgetExceeded).toBeUndefined();
          expect(completion.streamError.error).toContain(
            mode === "fallback" ? "openai:gpt-4o-mini" : "openai:gpt-4o"
          );
        }
        expect(primaryCalls).toBe(mode === "fallback" ? 1 : 0);
        expect(fallbackCalls).toBe(0);
      } finally {
        await manager.stopStream(workspaceId);
        await fs.rm(runtimeDir, { recursive: true, force: true });
        await h.cleanup();
      }
    }
  );

  test("dense outputs stop before a second provider call at auto-off and retain every paired result", async () => {
    const h = await createTestHistoryService();
    const workspaceId = "dense-output-hard-stop";
    const messageId = "assistant-hard-stop";
    const outputs = ["🦊".repeat(50000), "second sibling completed"];
    let providerCalls = 0;
    const executed: number[] = [];
    const model = new MockLanguageModelV3({
      doStream: () => {
        providerCalls += 1;
        if (providerCalls > 1)
          return Promise.resolve({
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start", id: "unexpected" },
                { type: "text-delta", id: "unexpected", delta: "unexpected second request" },
                { type: "text-end", id: "unexpected" },
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 10, text: 10, reasoning: 0 },
                  },
                },
              ],
            }),
          });
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "first", toolName: "produce", input: '{"index":0}' },
              {
                type: "tool-call",
                toolCallId: "second",
                toolName: "produce",
                input: '{"index":1}',
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: {
                  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 10, text: 10, reasoning: 0 },
                },
              },
            ],
          }),
        });
      },
    });
    const manager = new StreamManager(h.historyService);
    const runtimeDir = path.join(h.tempDir, "runtime");
    await fs.mkdir(runtimeDir);
    try {
      expect(
        (
          await h.historyService.appendManyToHistory(workspaceId, [
            createMuxMessage("user", "user", "Run both tools"),
            createMuxMessage(messageId, "assistant", ""),
          ])
        ).success
      ).toBe(true);
      const started = await manager.startStream({
        workspaceId,
        messageId,
        historySequence: 1,
        model,
        modelString: "openai:gpt-4o",
        messages: [{ role: "user", content: "Run both tools" }],
        system: "Run tools",
        runtime: new LocalRuntime(h.tempDir),
        providedRuntimeTempDir: runtimeDir,
        tools: {
          produce: tool({
            inputSchema: z.object({ index: z.number() }),
            execute: ({ index }) => {
              executed.push(index);
              return outputs[index];
            },
          }),
        },
        onStepSettled: (step) => {
          expect(Math.ceil(step.toolResultChars / 4) + 1010).toBeLessThan(119808);
          expect(step.toolResultTokens).toBeGreaterThan(119808);
          const { decision } = evaluateStepBudget({
            contextTokens: step.usage?.inputTokens ?? 0,
            outputTokens: step.usage?.outputTokens ?? 0,
            toolResultChars: step.toolResultChars,
            imageParts: step.imageParts,
            toolResultTokens: step.toolResultTokens,
            modelContextLimit: 128000,
            threshold: 1,
            warningEmitted: false,
            handoffRequested: false,
          });
          // The session maps the internal handoff decision onto the callback's "warn" stop.
          return Promise.resolve({ decision: decision === "handoff" ? "warn" : decision });
        },
      });
      expect(started.success).toBe(true);
      if (!started.success) throw new Error("Expected stream startup");
      const completion = await started.data.completion;
      expect(completion).toMatchObject({
        status: "failed",
        streamError: { errorType: "context_budget_blocked" },
      });
      if (completion.status === "failed")
        expect(completion.streamError.contextBudgetExceeded).toBeUndefined();
      expect(providerCalls).toBe(1);
      expect(executed).toEqual([0, 1]);
      expect((await h.historyService.commitPartial(workspaceId)).success).toBe(true);
      const history = await h.historyService.getLastMessages(workspaceId, 10);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      const resultParts = history.data
        .find((row) => row.id === messageId)
        ?.parts.filter((part) => part.type === "dynamic-tool");
      expect(resultParts).toHaveLength(2);
      expect(
        resultParts?.map((part) => ({
          id: part.toolCallId,
          state: part.state,
          output: part.state === "output-available" ? part.output : undefined,
        }))
      ).toEqual([
        { id: "first", state: "output-available", output: outputs[0] },
        { id: "second", state: "output-available", output: outputs[1] },
      ]);
      expect(
        history.data.some(
          (row) =>
            row.metadata?.muxMetadata?.type === "context-window-rollover" ||
            row.metadata?.muxMetadata?.type === "context-budget-warning"
        )
      ).toBe(false);
      expect(history.data.filter((row) => row.role === "user")).toHaveLength(1);
    } finally {
      await manager.stopStream(workspaceId);
      await h.cleanup();
    }
  }, 20000);

  test("a successful new_context settles as a request even when its checkpoint sibling failed", async () => {
    const h = await createTestHistoryService();
    const workspaceId = "new-context-sibling";
    const messageId = "assistant-new-context";
    let providerCalls = 0;
    const settled: SettledStepBudget[] = [];
    const model = new MockLanguageModelV3({
      doStream: () => {
        providerCalls += 1;
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "checkpoint",
                toolName: "memory",
                input: '{"command":"create"}',
              },
              { type: "tool-call", toolCallId: "reset", toolName: "new_context", input: "{}" },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: {
                  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 10, text: 10, reasoning: 0 },
                },
              },
            ],
          }),
        });
      },
    });
    const manager = new StreamManager(h.historyService);
    const runtimeDir = path.join(h.tempDir, "runtime");
    await fs.mkdir(runtimeDir);
    try {
      expect(
        (
          await h.historyService.appendManyToHistory(workspaceId, [
            createMuxMessage("user", "user", "Save notes, then reset"),
            createMuxMessage(messageId, "assistant", ""),
          ])
        ).success
      ).toBe(true);
      const started = await manager.startStream({
        workspaceId,
        messageId,
        historySequence: 1,
        model,
        modelString: "openai:gpt-4o",
        messages: [{ role: "user", content: "Save notes, then reset" }],
        system: "Run tools",
        runtime: new LocalRuntime(h.tempDir),
        providedRuntimeTempDir: runtimeDir,
        tools: {
          memory: tool({
            inputSchema: z.object({ command: z.string() }),
            execute: () => ({ success: false, error: "memory is read-only" }),
          }),
          new_context: tool({
            inputSchema: z.object({}),
            execute: () => ({ success: true, status: "scheduled", message: "scheduled" }),
          }),
        },
        onStepSettled: (step) => {
          settled.push(step);
          return Promise.resolve({ decision: "rollover" });
        },
      });
      expect(started.success).toBe(true);
      if (!started.success) throw new Error("Expected stream startup");
      const completion = await started.data.completion;
      expect(completion.status).toBe("completed");
      // The request is derived from the new_context result alone; the failed sibling neither
      // hides it nor triggers a second provider step before the rollover.
      expect(settled.map((step) => step.newContextRequested)).toEqual([true]);
      expect(providerCalls).toBe(1);
      expect((await h.historyService.commitPartial(workspaceId)).success).toBe(true);
      const history = await h.historyService.getLastMessages(workspaceId, 10);
      if (!history.success) throw new Error(history.error);
      const resultParts = history.data
        .find((row) => row.id === messageId)
        ?.parts.filter((part) => part.type === "dynamic-tool");
      expect(
        resultParts?.map((part) => ({
          id: part.toolCallId,
          output: part.state === "output-available" ? part.output : undefined,
        }))
      ).toEqual([
        { id: "checkpoint", output: { success: false, error: "memory is read-only" } },
        { id: "reset", output: { success: true, status: "scheduled", message: "scheduled" } },
      ]);
    } finally {
      await manager.stopStream(workspaceId);
      await h.cleanup();
    }
  }, 20000);
});

describe("final flush turn transcript visibility", () => {
  const CREATED_AT = "2026-01-01T00:00:00.000Z";
  const FLUSH_TEXT_DELTAS = ["Saved the ", "notes; window ", "can close."];
  const USAGE = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  };

  const displayedRowsFor = (aggregator: StreamingMessageAggregator, messageId: string) =>
    aggregator
      .getDisplayedMessages()
      .filter((row) => "historyId" in row && row.historyId === messageId);

  const loadIntoFreshAggregator = (rows: MuxMessage[]) => {
    const aggregator = new StreamingMessageAggregator(CREATED_AT);
    aggregator.loadHistoricalMessages(
      rows.map((row) => MuxMessageSchema.parse(row)),
      false
    );
    return aggregator;
  };

  // The renderer only ever sees engine events after the IPC schema parsed them, so a flag
  // the emitter or schema drops never reaches the aggregator no matter what the engine knew.
  const applyThroughIpcSchema = (aggregator: StreamingMessageAggregator, event: TurnEngineEvent) =>
    applyWorkspaceChatEventToAggregator(aggregator, WorkspaceChatMessageSchema.parse(event), {
      allowSideEffects: false,
    });

  test.each([
    { flush: true, ending: "completed" },
    { flush: true, ending: "stopped" },
    { flush: false, ending: "completed" },
  ] as const)(
    "flush output never surfaces while an ordinary turn does (flush=$flush, $ending)",
    async ({ flush, ending }) => {
      const h = await createTestHistoryService();
      const manager = new StreamManager(h.historyService);
      const workspaceId = `flush-visibility-${ending}`;
      const messageId = "flush-assistant";
      const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "context-budget-stream-"));
      // The provider stream is hand-driven so the test can observe the renderer between
      // deltas and stop the turn mid-text; the engine reads it lazily after startStream.
      const controllerReady =
        Promise.withResolvers<ReadableStreamDefaultController<LanguageModelV3StreamPart>>();
      const model = new MockLanguageModelV3({
        doStream: ({ abortSignal }) =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start: (streamController) => {
                streamController.enqueue({ type: "stream-start", warnings: [] });
                streamController.enqueue({ type: "text-start", id: "answer" });
                // Like a real transport, a stop must surface to the consumer as an abort.
                abortSignal?.addEventListener("abort", () => {
                  try {
                    streamController.error(new DOMException("Stopped", "AbortError"));
                  } catch {
                    // Already closed.
                  }
                });
                controllerReady.resolve(streamController);
              },
            }),
          }),
      });
      const events: TurnEngineEvent[] = [];
      let firstDelta!: () => void;
      const firstDeltaSeen = new Promise<void>((resolve) => {
        firstDelta = resolve;
      });
      for (const type of ["stream-start", "stream-delta", "stream-end", "stream-abort"] as const) {
        onTurnEngineEvent(manager, type, (event) => {
          events.push(event);
          if (event.type === "stream-delta") firstDelta();
        });
      }
      try {
        // Rows as the request builder persists them: the hidden synthetic trigger and the
        // empty assistant placeholder that the stream fills in.
        const trigger = createMuxMessage("flush-trigger", "user", "Flush context notes now.", {
          synthetic: true,
          uiVisible: false,
          muxMetadata: {
            type: "normal",
            contextBudgetContinuation: true,
            ...(flush ? { contextBudgetFlush: true } : {}),
          },
        });
        const placeholder = createMuxMessage(messageId, "assistant", "");
        expect(
          (await h.historyService.appendManyToHistory(workspaceId, [trigger, placeholder])).success
        ).toBe(true);
        const before = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!before.success) throw new Error(before.error);
        const live = loadIntoFreshAggregator(before.data);

        const started = await manager.startStream({
          workspaceId,
          messageId,
          historySequence: placeholder.metadata?.historySequence ?? 1,
          model,
          modelString: "openai:gpt-4o",
          messages: [{ role: "user", content: "Flush context notes now." }],
          system: "Write notes",
          runtime: new LocalRuntime(h.tempDir),
          providedRuntimeTempDir: runtimeDir,
          initialMetadata: {
            muxMetadata: {
              type: "normal",
              contextBudgetContinuation: true,
              ...(flush ? { contextBudgetFlush: true } : {}),
            },
          },
        });
        expect(started.success).toBe(true);
        if (!started.success) throw new Error("Expected stream construction");
        const controller = await controllerReady.promise;
        controller.enqueue({ type: "text-delta", id: "answer", delta: FLUSH_TEXT_DELTAS[0] });
        await firstDeltaSeen;
        if (ending === "stopped") {
          await manager.stopStream(workspaceId);
        } else {
          for (const delta of FLUSH_TEXT_DELTAS.slice(1)) {
            controller.enqueue({ type: "text-delta", id: "answer", delta });
          }
          controller.enqueue({ type: "text-end", id: "answer" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: USAGE,
          });
          controller.close();
        }
        const completion = await started.data.completion;
        expect(completion.status).toBe(ending === "stopped" ? "aborted" : "completed");

        // Live path: replay the real engine emissions into the renderer aggregator and check
        // after every event, so a partially streamed flush cannot flash into the transcript.
        const expectedEventTypes: Array<TurnEngineEvent["type"]> =
          ending === "stopped"
            ? ["stream-start", "stream-delta", "stream-abort"]
            : [
                "stream-start",
                ...FLUSH_TEXT_DELTAS.map(() => "stream-delta" as const),
                "stream-end",
              ];
        expect(events.map((event) => event.type)).toEqual(expectedEventTypes);
        const seenLive: string[][] = [];
        for (const event of events) {
          applyThroughIpcSchema(live, event);
          seenLive.push(displayedRowsFor(live, messageId).map((row) => row.type));
        }
        if (flush) {
          expect(seenLive.flat()).toEqual([]);
        } else {
          expect(seenLive.at(-1)).toEqual(["assistant"]);
          expect(displayedRowsFor(live, messageId)[0]).toMatchObject({
            content: FLUSH_TEXT_DELTAS.join(""),
          });
        }
        // The hidden trigger row is unaffected either way.
        expect(displayedRowsFor(live, trigger.id)).toEqual([]);

        // Durable path: the same rows a reload or crash recovery replays from disk.
        if (ending === "stopped") {
          // Stopping commits the partial into history with its streamed text.
          expect(await h.historyService.readPartial(workspaceId)).toBeNull();
        }
        const persisted = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (!persisted.success) throw new Error(persisted.error);
        const assistantRow = persisted.data.find((row) => row.id === messageId);
        expect(
          assistantRow?.parts.map((part) => (part.type === "text" ? part.text : part.type)).join("")
        ).toBe(ending === "stopped" ? FLUSH_TEXT_DELTAS[0] : FLUSH_TEXT_DELTAS.join(""));
        const reloaded = loadIntoFreshAggregator(persisted.data);
        expect(displayedRowsFor(reloaded, messageId).map((row) => row.type)).toEqual(
          flush ? [] : ["assistant"]
        );
      } finally {
        await manager.stopStream(workspaceId);
        await fs.rm(runtimeDir, { recursive: true, force: true });
        await h.cleanup();
      }
    },
    20000
  );
});
