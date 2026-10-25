/**
 * Turn lifecycle on the real StreamManager stack: the AI SDK's streamText over a
 * MockLanguageModelV3, real tools, a real HistoryService (createTestHistoryService).
 * These pin today's stop, start-failure, tool-interrupt, cleanup-order and
 * engine-scope behavior, so the Effect form of TurnEngine.start must keep them.
 */
import { describe, expect, test } from "bun:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Effect, Exit, Scope } from "effect";
import { z } from "zod";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { eventSpine } from "@/node/services/events/eventSpine";
import { attachLanguageModelCleanup } from "./languageModelCleanup";
import { ToolCallDisplayRegistry } from "./toolCallDisplayRegistry";
import type { StreamManager } from "./streamManager";
import {
  createStreamManagerForTests,
  fakeStreamText,
  noopTokenTracker,
  onTurnEngineEvent,
  type StreamManagerTestDeps,
} from "./streamManager.testHarness";
import {
  appendPartialAssistantForTests,
  createExecRecordingRuntimeForTests,
  historyService,
  installStreamManagerTestHistory,
  testStartOptions,
} from "./streamManager.suite.testHarness";
import type { TurnExecutionOptions } from "./turnEngine/TurnEngine";

installStreamManagerTestHistory();

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * A provider whose stream sends `chunks`, then either finishes or stays open
 * until the request's abort signal fires (as a real provider connection does).
 */
function providerModel(
  chunks: LanguageModelV3StreamPart[],
  end: "finish" | "hold" | "tool-calls"
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: ({ abortSignal }) =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const chunk of chunks) controller.enqueue(chunk);
            if (end === "hold") {
              abortSignal?.addEventListener("abort", () => controller.close(), { once: true });
              return;
            }
            controller.enqueue({
              type: "finish",
              finishReason:
                end === "finish"
                  ? { unified: "stop", raw: "stop" }
                  : { unified: "tool-calls", raw: "tool_use" },
              usage: USAGE,
            });
            controller.close();
          },
        }),
      }),
  });
}

function textChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: text },
  ];
}

interface TurnRecorder {
  streamManager: StreamManager;
  events: string[];
}

function recordingManager(deps: StreamManagerTestDeps = {}): TurnRecorder {
  const streamManager = createStreamManagerForTests(historyService, deps);
  const events: string[] = [];
  for (const type of [
    "stream-start",
    "stream-delta",
    "stream-end",
    "stream-abort",
    "error",
  ] as const) {
    onTurnEngineEvent(streamManager, type, (event) => {
      const reason = "abortReason" in event ? `:${String(event.abortReason)}` : "";
      events.push(`${type}${reason}`);
    });
  }
  return { streamManager, events };
}

async function startTurn(
  streamManager: StreamManager,
  options: Partial<TurnExecutionOptions> & Pick<TurnExecutionOptions, "workspaceId" | "model">
) {
  const messageId = options.messageId ?? `${options.workspaceId}-msg`;
  const historySequence = options.historySequence ?? 1;
  await appendPartialAssistantForTests(options.workspaceId, messageId, historySequence);
  return streamManager.startStream(
    testStartOptions({
      providedRuntimeTempDir: "",
      tools: {},
      ...options,
      messageId,
      historySequence,
    })
  );
}

/** The turn's assistant row in chat history (a stop commits the partial there). */
async function committedRow(workspaceId: string) {
  const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
  if (!history.success) throw new Error(history.error);
  return history.data.find((row) => row.id === `${workspaceId}-msg`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve: () => resolve() };
}

describe("StreamManager lifecycle - stop and start", () => {
  test("stream-start is emitted before startStream resolves", async () => {
    // A slow token tracker: stream-start must not wait for the loop's first await.
    const { streamManager, events } = recordingManager({
      tokenTracker: {
        ...noopTokenTracker,
        setModel: () => new Promise((resolve) => setTimeout(resolve, 50)),
      },
    });
    const workspaceId = "lifecycle-start-order";
    const started = await startTurn(streamManager, {
      workspaceId,
      model: providerModel(textChunks("hello"), "hold"),
    });
    // Captured before any further await: the loop's synchronous start already ran.
    const atResolve = [...events];
    expect(started.success).toBe(true);
    if (!started.success) throw new Error("Expected stream to start");
    expect(atResolve).toEqual(["stream-start"]);
    expect(streamManager.isStreaming(workspaceId)).toBe(true);
    await streamManager.stopStream(workspaceId);
    await started.data.completion;
  });

  test("a hard stop mid-stream aborts once, keeps the streamed text and frees the workspace", async () => {
    const { streamManager, events } = recordingManager();
    const workspaceId = "lifecycle-hard-stop";
    const delta = deferred();
    onTurnEngineEvent(streamManager, "stream-delta", () => delta.resolve());
    const started = await startTurn(streamManager, {
      workspaceId,
      model: providerModel(textChunks("partial answer"), "hold"),
    });
    if (!started.success) throw new Error("Expected stream to start");
    await delta.promise;

    expect((await streamManager.stopStream(workspaceId, { abortReason: "user" })).success).toBe(
      true
    );

    expect(await started.data.completion).toMatchObject({ status: "aborted", abortReason: "user" });
    expect(events).toEqual(["stream-start", "stream-delta", "stream-abort:user"]);
    expect(streamManager.isStreaming(workspaceId)).toBe(false);
    expect((await committedRow(workspaceId))?.parts).toMatchObject([
      { type: "text", text: "partial answer" },
    ]);

    // The workspace takes the next turn right away.
    const next = await startTurn(streamManager, {
      workspaceId,
      messageId: `${workspaceId}-next`,
      historySequence: 2,
      model: providerModel(textChunks("next answer"), "finish"),
    });
    if (!next.success) throw new Error("Expected the next stream to start");
    expect((await next.data.completion).status).toBe("completed");
  });

  for (const failure of ["construction", "envelope"] as const) {
    test(`a start whose ${failure} throws returns the error, emits nothing and releases the start`, async () => {
      const { streamManager, events } = recordingManager({
        streamText:
          failure === "construction"
            ? fakeStreamText(() => {
                throw new Error("provider construction failed");
              })
            : undefined,
      });
      const workspaceId = `lifecycle-start-${failure}-failure`;
      const { runtime, execCalls } = createExecRecordingRuntimeForTests();
      const model = providerModel(textChunks("unused"), "finish");
      let modelCleanups = 0;
      attachLanguageModelCleanup(model, () => {
        modelCleanups++;
      });

      const started = await startTurn(streamManager, {
        workspaceId,
        model,
        runtime,
        providedRuntimeTempDir: "/tmp/lifecycle-start-failure",
        onStreamConstructed:
          failure === "envelope"
            ? () => Promise.reject(new Error("envelope write failed"))
            : undefined,
      });

      expect(started.success).toBe(false);
      expect(events).toEqual([]);
      expect(streamManager.isStreaming(workspaceId)).toBe(false);
      expect(execCalls.map((call) => call.command)).toEqual(["rm -rf 'lifecycle-start-failure'"]);
      expect(modelCleanups).toBe(1);
      // The start lock is free: acquiring it again does not wait.
      const sameWorkspace = await streamManager.acquireStreamStartLock(workspaceId);
      await sameWorkspace[Symbol.asyncDispose]();
    });
  }
});

describe("StreamManager lifecycle - tools and cleanup", () => {
  test("a hard stop while a tool runs aborts the tool and ends the turn once", async () => {
    const { streamManager, events } = recordingManager();
    const workspaceId = "lifecycle-tool-stop";
    const toolStarted = deferred();
    let toolSawAbort = false;
    let providerCalls = 0;
    const leases: string[] = [];
    streamManager.setMCPServerManager({
      acquireLease: (id: string) => void leases.push(`acquire:${id}`),
      releaseLease: (id: string) => void leases.push(`release:${id}`),
    } as unknown as MCPServerManager);
    const model = providerModel(
      [{ type: "tool-call", toolCallId: "t1", toolName: "wait", input: "{}" }],
      "tool-calls"
    );
    const doStream = model.doStream.bind(model);
    model.doStream = (options) => {
      providerCalls++;
      return doStream(options);
    };

    const started = await startTurn(streamManager, {
      workspaceId,
      model,
      tools: {
        wait: tool({
          description: "Waits until the turn stops",
          inputSchema: z.object({}),
          execute: async (_input, { abortSignal }) => {
            toolStarted.resolve();
            await new Promise<void>((resolve) =>
              abortSignal?.addEventListener("abort", () => resolve(), { once: true })
            );
            toolSawAbort = true;
            return "stopped";
          },
        }),
      },
    });
    if (!started.success) throw new Error("Expected stream to start");
    await toolStarted.promise;

    await streamManager.stopStream(workspaceId, { abortReason: "user" });

    expect(await started.data.completion).toMatchObject({ status: "aborted", abortReason: "user" });
    expect(toolSawAbort).toBe(true);
    expect(providerCalls).toBe(1);
    expect(events.filter((event) => event.startsWith("stream-abort"))).toEqual([
      "stream-abort:user",
    ]);
    expect(leases).toEqual([`acquire:${workspaceId}`, `release:${workspaceId}`]);
  });

  for (const outcome of ["completed", "failed", "aborted"] as const) {
    test(`a ${outcome} turn closes its resources in order`, async () => {
      const registry = new ToolCallDisplayRegistry();
      const { streamManager } = recordingManager({ toolCallDisplayRegistry: registry });
      const workspaceId = `lifecycle-cleanup-${outcome}`;
      // First occurrence of each step: a stop closes the display scope early, and
      // the later closes of an already closed scope are no-ops.
      const order: string[] = [];
      const record = (step: string) => {
        if (!order.includes(step)) order.push(step);
      };
      const closeDisplay = registry.close.bind(registry);
      registry.close = (scope) => {
        record("display-scope");
        closeDisplay(scope);
      };
      streamManager.setMCPServerManager({
        acquireLease: () => undefined,
        releaseLease: () => record("mcp-lease"),
      } as unknown as MCPServerManager);
      const { runtime } = createExecRecordingRuntimeForTests();
      const exec = runtime.exec.bind(runtime);
      runtime.exec = (command, options) => {
        record("temp-dir");
        return exec(command, options);
      };
      const model =
        outcome === "failed"
          ? new MockLanguageModelV3({
              doStream: () => Promise.reject(new Error("provider failed")),
            })
          : providerModel(textChunks("hello"), outcome === "completed" ? "finish" : "hold");
      attachLanguageModelCleanup(model, () => record("model"));
      const unsubscribe = eventSpine.subscribe("stream.end", (payload) => {
        if (payload.workspaceId !== workspaceId) return;
        // A completed or failed turn frees its slot first; an abort keeps it until its
        // abort cleanup finishes.
        record(streamManager.getStreamInfo(workspaceId, true) ? "stream.end" : "stream.end:freed");
      });
      const started = await startTurn(streamManager, {
        workspaceId,
        model,
        runtime,
        providedRuntimeTempDir: "/tmp/lifecycle-cleanup",
      });
      if (!started.success) throw new Error("Expected stream to start");
      if (outcome === "aborted")
        await streamManager.stopStream(workspaceId, { abortReason: "user" });
      const completion = await started.data.completion;
      record(`settled:${completion.status}`);
      unsubscribe();
      expect(order).toEqual(
        outcome === "aborted"
          ? ["display-scope", "mcp-lease", "temp-dir", "model", "stream.end", "settled:aborted"]
          : [
              "mcp-lease",
              "display-scope",
              "temp-dir",
              "model",
              "stream.end:freed",
              `settled:${outcome}`,
            ]
      );
      expect(streamManager.getStreamInfo(workspaceId, true)).toBeUndefined();
    });
  }
});

describe("StreamManager lifecycle - engine scope", () => {
  test("closing the engine scope stops a starting turn as system and waits for it", async () => {
    const engineScope = Scope.makeUnsafe();
    const { streamManager, events } = recordingManager({ engineScope });
    const workspaceId = "lifecycle-scope-starting";
    const envelopeEntered = deferred();
    const envelopeRelease = deferred();
    const startedPromise = startTurn(streamManager, {
      workspaceId,
      model: providerModel(textChunks("never"), "hold"),
      onStreamConstructed: async () => {
        envelopeEntered.resolve();
        await envelopeRelease.promise;
      },
    });
    await envelopeEntered.promise;

    let closed = false;
    const closing = Effect.runPromise(Scope.close(engineScope, Exit.void)).then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    envelopeRelease.resolve();
    await closing;
    // The close returned only after the turn left the workspace.
    expect(streamManager.getStreamInfo(workspaceId, true)).toBeUndefined();

    const started = await startedPromise;
    if (!started.success) throw new Error("Expected a handle");
    expect(await started.data.completion).toMatchObject({
      status: "aborted",
      abortReason: "system",
    });
    // Whether the loop emitted stream-start first depends on how fast the
    // pre-cancel flush runs; exactly one abort is delivered either way.
    expect(events.filter((event) => event.startsWith("stream-abort"))).toEqual([
      "stream-abort:system",
    ]);
  });

  test("closing the engine scope stops a streaming turn as system and waits for it", async () => {
    const engineScope = Scope.makeUnsafe();
    const { streamManager, events } = recordingManager({ engineScope });
    const workspaceId = "lifecycle-scope-streaming";
    const started = await startTurn(streamManager, {
      workspaceId,
      model: providerModel(textChunks("streaming"), "hold"),
    });
    if (!started.success) throw new Error("Expected stream to start");
    let settled = false;
    void started.data.completion.then(() => {
      settled = true;
    });

    await Effect.runPromise(Scope.close(engineScope, Exit.void));

    expect(settled).toBe(true);
    expect(await started.data.completion).toMatchObject({
      status: "aborted",
      abortReason: "system",
    });
    expect(events.filter((event) => event.startsWith("stream-abort"))).toEqual([
      "stream-abort:system",
    ]);
    expect(streamManager.isStreaming(workspaceId)).toBe(false);
  });
});
