import { tmpdir } from "node:os";
import {
  NATIVE_TOOL_SEARCH_MIN_DEFERRED_CHARS,
  prepareToolSearch,
  type ToolSearchRuntime,
} from "@/common/utils/tools/toolCatalog";
import { createToolSearchTool } from "./tools/toolSearch";
import { createTestToolConfig } from "./tools/testHelpers";
import { describe, expect, spyOn, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { tool } from "ai";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { evaluateStepBudget } from "@/common/utils/compaction/contextBudget";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { StreamManager, type SettledStepBudget } from "./streamManager";
import { createTestHistoryService } from "./testHistoryService";
import * as budgetCounting from "./contextBudgetCounting";
import {
  estimateAnchoredRequestTokensForModel,
  estimateAssembledRequestTokensForModel,
} from "./contextBudgetCounting";

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

  test.each(["fits", "overflow", "stale-activation"] as const)(
    "native tool search sends every tool each step and budgets only loaded schemas (%s)",
    async (mode) => {
      const h = await createTestHistoryService();
      const workspaceId = "native-catalog-budget";
      const messageId = "native-catalog-assistant";
      const settledEstimates: Array<number | undefined> = [];
      const requests: Array<{ tools: string; prompt: unknown[] }> = [];
      const searchRuntime: ToolSearchRuntime = {};
      const search = prepareToolSearch({
        tools: {
          tool_catalog_search: createToolSearchTool({
            ...createTestToolConfig(h.tempDir),
            toolSearchRuntime: searchRuntime,
          }),
          mcp_large: tool({
            description: "Large catalog schema",
            inputSchema: z.object({
              argument: z.string().describe("漢".repeat(mode === "fits" ? 100 : 10000)),
            }),
          }),
          // Never loaded: lifts the deferred catalog over the native size
          // threshold (#5405) without touching the budgeted schemas.
          padding_tool: tool({
            description: "Lorem ipsum dolor sit amet. ".repeat(
              Math.ceil(NATIVE_TOOL_SEARCH_MIN_DEFERRED_CHARS / 28)
            ),
            inputSchema: z.object({}),
          }),
        },
        mcpToolNames: ["mcp_large", "padding_tool"],
        promptCacheActive: true,
      });
      searchRuntime.state = search.state;
      // An activation whose tool_reference a compacted prefix no longer carries.
      if (mode === "stale-activation") search.state?.activatedToolNames.add("mcp_large");
      const model = new MockLanguageModelV3({
        doStream: (request) => {
          requests.push({ tools: JSON.stringify(request.tools), prompt: request.prompt });
          const activate = requests.length === 1;
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
                        input:
                          mode === "stale-activation"
                            ? '{"query":"unmatched"}'
                            : '{"query":"mcp_large"}',
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
          toolSearchState: search.state,
          contextBudgetLimit: 10000,
          onStepSettled: (step) => {
            settledEstimates.push(step.nextRequestTokens);
            return Promise.resolve({ decision: "continue" as const });
          },
        });
        expect(started.success).toBe(true);
        if (!started.success) throw new Error("Expected stream construction");
        const completion = await started.data.completion;
        if (mode === "stale-activation") {
          expect(settledEstimates).toHaveLength(1);
          // The unreferenced schema alone measures several thousand tokens.
          expect(settledEstimates[0]).toBeLessThan(2000);
        }
        // The deferred schema is sent but not loaded, so the first step fits
        // even when loading it would not; the activation then counts it.
        expect(completion.status).toBe(mode === "overflow" ? "failed" : "completed");
        expect(requests).toHaveLength(mode === "overflow" ? 1 : 2);
        expect(requests[0].tools).toContain('"deferLoading":true');
        if (mode === "fits") {
          expect(requests[1].tools).toBe(requests[0].tools);
          expect(requests[1].prompt.at(-1)).toMatchObject({
            role: "tool",
            content: [
              {
                type: "tool-result",
                output: {
                  type: "content",
                  value: [
                    {
                      type: "custom",
                      providerOptions: {
                        anthropic: { type: "tool-reference", toolName: "mcp_large" },
                      },
                    },
                  ],
                },
              },
            ],
          });
        }
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
            handoffRequested: false,
            finalHandoffAvailable: false,
          });
          // The session maps the internal handoff and final decisions onto callback stops.
          return Promise.resolve({
            decision:
              decision === "handoff" ? "warn" : decision === "final" ? "rollover" : decision,
          });
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

  // #4855: the provider reports far fewer input tokens than the assembled estimate the next
  // step's preflight enforces. The settled step must see that same estimate so the forced
  // rollover wins; before the fix the preflight hard-stopped the turn every time. With a roomy
  // limit, the settled measure must equal what the next step's preflight actually checks.
  // #4858: with provider usage both measures anchor on it; without it both use the full estimate.
  test.each([
    { limit: 10_000, reported: false },
    { limit: 10_000, reported: true },
    { limit: 100_000, reported: true },
  ])(
    "a settled step measures the next preflight request (limit $limit, usage $reported)",
    async ({ limit, reported }) => {
      const preflights = spyOn(budgetCounting, "checkAssembledRequestBudgetForModel");
      const h = await createTestHistoryService();
      const workspaceId = "next-request-rollover";
      const messageId = "assistant-next-request";
      let providerCalls = 0;
      const settled: SettledStepBudget[] = [];
      const usage = {
        inputTokens: reported
          ? { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }
          : { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      };
      const model = new MockLanguageModelV3({
        doStream: () => {
          providerCalls += 1;
          return Promise.resolve({
            stream: simulateReadableStream<LanguageModelV3StreamPart>({
              chunks:
                providerCalls === 1
                  ? [
                      { type: "stream-start", warnings: [] },
                      { type: "tool-call", toolCallId: "read", toolName: "read", input: "{}" },
                      {
                        type: "finish",
                        finishReason: { unified: "tool-calls", raw: "tool_calls" },
                        usage,
                      },
                    ]
                  : [
                      { type: "stream-start", warnings: [] },
                      { type: "text-start", id: "answer" },
                      { type: "text-delta", id: "answer", delta: "Done" },
                      { type: "text-end", id: "answer" },
                      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
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
              createMuxMessage("user", "user", "Read the part"),
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
          messages: [{ role: "user", content: "Read the part" }],
          // Large enough that the first request fits and the second does not (hard ceiling 7,500).
          system: "system prompt line ".repeat(1200),
          runtime: new LocalRuntime(h.tempDir),
          providedRuntimeTempDir: runtimeDir,
          tools: {
            read: tool({
              inputSchema: z.object({}),
              execute: () => "part text line ".repeat(700),
            }),
          },
          contextBudgetLimit: limit,
          onStepSettled: (step) => {
            settled.push(step);
            // The same evaluation the token-budget strategy runs, with rollover enabled.
            const { decision } = evaluateStepBudget({
              contextTokens: step.usage?.inputTokens ?? 0,
              outputTokens: step.usage?.outputTokens ?? 0,
              toolResultChars: step.toolResultChars,
              imageParts: step.imageParts,
              toolResultTokens: step.toolResultTokens,
              nextRequestTokens: step.nextRequestTokens,
              modelContextLimit: limit,
              threshold: 0.9,
              handoffRequested: true,
              finalHandoffAvailable: false,
            });
            return Promise.resolve({
              decision:
                decision === "handoff" ? "warn" : decision === "final" ? "rollover" : decision,
            });
          },
        });
        if (!started.success) throw new Error("Expected stream startup");
        const completion = await started.data.completion;
        // Before the fix the next step's preflight failed the stream as "context_budget_blocked".
        expect(
          completion.status === "failed" ? completion.streamError.errorType : completion.status
        ).toBe("completed");
        if (!reported) {
          expect(providerCalls).toBe(1);
          expect(settled).toHaveLength(1);
          // Provider usage plus the settled tool output alone stays below the ceiling...
          expect(110 + (settled[0].toolResultTokens ?? 0)).toBeLessThan(7_500);
          // ...but the next assembled request does not, so the step stops as a rollover.
          expect(settled[0].nextRequestTokens).toBeGreaterThan(7_500);
        } else {
          // The anchored request fits even the small window, so the turn takes its second step.
          expect(providerCalls).toBe(2);
          // The last preflight checked step two's request: re-measure its exact payload.
          const [payload, budget, anchor] = preflights.mock.calls.at(-1)!;
          expect(anchor?.providerTokens).toBe(100);
          const anchored = await estimateAnchoredRequestTokensForModel(payload, budget, anchor);
          expect(settled[0].nextRequestTokens).toBe(anchored!.estimate);
          expect(anchored!.estimate).toBeLessThan(
            (await estimateAssembledRequestTokensForModel(payload, budget))!.estimate
          );
        }
      } finally {
        preflights.mockRestore();
        await manager.stopStream(workspaceId);
        await h.cleanup();
      }
    },
    20000
  );

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
