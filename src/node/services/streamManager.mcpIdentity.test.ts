import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import type { ToolCallEndEvent } from "@/common/types/stream";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { HistoryService } from "./historyService";
import { StreamManager } from "./streamManager";
import { engineInternals, onTurnEngineEvent } from "./streamManager.testHarness";
import { createTestHistoryService } from "./testHistoryService";
import { ToolCallDisplayRegistry, type ExecutionScope } from "./toolCallDisplayRegistry";

/**
 * Ownership regressions for the host-authored MCP identity snapshot: the
 * stream that assembled a tool set is the only consumer of its snapshots, on
 * both the top-level (completeToolCall) and nested (emitNestedToolEvent)
 * paths, and persisted snapshots replay to reconnecting renderers.
 */

let historyService: HistoryService;
let historyCleanup: () => Promise<void>;

beforeEach(async () => {
  ({ historyService, cleanup: historyCleanup } = await createTestHistoryService());
});

afterEach(async () => {
  await historyCleanup();
});

const LOCAL_TEST_RUNTIME = createRuntime({ type: "local", srcBaseDir: "/tmp" });

function snapshot(name: string): MCPToolCallDisplay {
  return {
    connection: { key: "identity", transport: "stdio" },
    identity: { name, version: "1" },
    source: "response",
  };
}

const unusedModel: LanguageModel = {
  specificationVersion: "v3",
  provider: "test",
  modelId: "unused",
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error("unused")),
  doStream: () => Promise.reject(new Error("unused")),
};

/** Minimal registered stream: only what completeToolCall, emitNestedToolEvent and replay touch. */
function registerStream(
  streamManager: StreamManager,
  scope: ExecutionScope,
  parts: PartRecord[] = []
): PartRecord {
  const now = Date.now();
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const streamInfo: PartRecord = {
    state: "streaming",
    streamResult: {
      fullStream: (async function* emptyStream() {
        await Promise.resolve();
        yield* [];
      })(),
      totalUsage: Promise.resolve(usage),
      usage: Promise.resolve(usage),
      providerMetadata: Promise.resolve(undefined),
      steps: Promise.resolve([]),
    },
    abortController: new AbortController(),
    messageId: scope.messageId,
    token: scope.token,
    executionScope: scope,
    startTime: now,
    lastPartTimestamp: now,
    lastPartialWriteTime: now,
    toolCompletionTimestamps: new Map<string, number>(),
    pendingWorkflowRunAttachments: new Map<string, unknown>(),
    pendingNestedCalls: new Map<string, unknown[]>(),
    pendingToolExecutionStarts: new Map<string, number>(),
    model: KNOWN_MODELS.SONNET.id,
    metadataModel: KNOWN_MODELS.SONNET.id,
    historySequence: 1,
    request: { model: unusedModel, messages: [], providerOptions: undefined },
    toolModelUsages: [],
    parts,
    partialWriteTimer: undefined,
    partialWritePromise: undefined,
    processingPromise: Promise.resolve(),
    softInterrupt: { pending: false as const },
    runtimeTempDir: "",
    runtime: LOCAL_TEST_RUNTIME,
    cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cumulativeProviderMetadata: undefined,
    didRetryPreviousResponseIdAtStep: false,
    receivedTerminalEvent: false,
    currentStepStartIndex: 0,
    stepStartIndices: [0],
    stepTracker: {},
  };
  const streams: unknown = engineInternals(streamManager).workspaceStreams;
  if (!(streams instanceof Map)) throw new Error("Expected StreamManager.workspaceStreams");
  streams.set(scope.workspaceId, streamInfo);
  return streamInfo;
}

type CompleteToolCall = (
  workspaceId: string,
  streamInfo: Record<string, unknown>,
  toolCalls: Map<string, unknown>,
  toolCallId: string,
  toolName: string,
  output: unknown
) => Promise<void>;

function completeToolCallFor(streamManager: StreamManager): CompleteToolCall {
  const method: unknown = engineInternals(streamManager).completeToolCall;
  if (typeof method !== "function") throw new Error("Expected StreamManager.completeToolCall");
  return (method as CompleteToolCall).bind(streamManager);
}

type PartRecord = Record<string, unknown>;

function toolPart(toolCallId: string, extra: PartRecord = {}): PartRecord {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "identity_identity_probe",
    input: {},
    state: "input-available",
    timestamp: Date.now(),
    ...extra,
  };
}

describe("StreamManager - MCP identity snapshot ownership", () => {
  const workspaceId = "mcp-identity-workspace";
  const replaced: ExecutionScope = { workspaceId, messageId: "message-a", token: "token-a" };
  const replacement: ExecutionScope = { workspaceId, messageId: "message-b", token: "token-b" };

  test("a top-level completion consumes only its own execution's snapshot, exactly once", async () => {
    const registry = new ToolCallDisplayRegistry();
    const streamManager = new StreamManager(
      historyService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registry
    );
    const ends: ToolCallEndEvent[] = [];
    onTurnEngineEvent(streamManager, "tool-call-end", (event) => ends.push(event));
    const completeToolCall = completeToolCallFor(streamManager);

    // The replaced execution still owns a registered stream object while the
    // replacement's wrapper published a snapshot under the same call id.
    registry.open(replaced);
    registry.open(replacement);
    registry.set(replacement, "call-1", snapshot("replacement"));
    const staleStream = registerStream(streamManager, replaced, [toolPart("call-1")]);
    await completeToolCall(
      workspaceId,
      staleStream,
      new Map(),
      "call-1",
      "identity_identity_probe",
      {
        content: [],
      }
    );
    expect((staleStream.parts as Array<Record<string, unknown>>)[0]?.mcpServer).toBeUndefined();
    expect(ends[0]?.mcpServer).toBeUndefined();
    expect(registry.take(replacement, "call-1")).toStrictEqual(snapshot("replacement"));

    // The owning execution consumes it: persisted before the live event, then gone.
    registry.set(replacement, "call-1", snapshot("replacement"));
    const ownStream = registerStream(streamManager, replacement, [toolPart("call-1")]);
    await completeToolCall(workspaceId, ownStream, new Map(), "call-1", "identity_identity_probe", {
      content: [],
    });
    const persisted = await historyService.readPartial(workspaceId);
    const persistedPart = persisted?.parts[0] as Record<string, unknown> | undefined;
    expect(persistedPart?.mcpServer).toStrictEqual(snapshot("replacement"));
    expect(ends[1]?.mcpServer).toStrictEqual(snapshot("replacement"));
    expect(ends[1]?.messageId).toBe(replacement.messageId);
    expect(registry.take(replacement, "call-1")).toBeUndefined();
  });

  test("a nested completion from a closed or mismatched originating scope cannot consume the replacement's snapshot", () => {
    const registry = new ToolCallDisplayRegistry();
    const streamManager = new StreamManager(
      historyService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registry
    );
    const ends: ToolCallEndEvent[] = [];
    onTurnEngineEvent(streamManager, "tool-call-end", (event) => ends.push(event));

    // Run B replaced run A and owns the workspace stream. A's teardown has not
    // closed its registry scope yet, and A's wrapper published its own snapshot
    // under the same nested call id.
    registry.open(replaced);
    registry.open(replacement);
    registry.set(replaced, "nested-1", snapshot("replaced"));
    registry.set(replacement, "nested-1", snapshot("replacement"));
    const stream = registerStream(streamManager, replacement, [
      toolPart("code-exec", { toolName: "code_execution", input: { code: "…" } }),
    ]);
    const startTime = Date.now();
    const nestedStart = {
      type: "tool-call-start" as const,
      callId: "nested-1",
      toolName: "identity_identity_probe",
      args: {},
      parentToolCallId: "code-exec",
      startTime,
    };
    const nestedEnd = {
      ...nestedStart,
      type: "tool-call-end" as const,
      endTime: startTime + 1,
      result: { content: [] },
    };
    streamManager.emitNestedToolEvent(replacement, nestedStart);
    const nestedCalls = () =>
      ((stream.parts as Array<Record<string, unknown>>)[0]?.nestedCalls ?? []) as Array<
        Record<string, unknown>
      >;

    // A's late nested consumer must neither brand B's record with A's snapshot
    // nor consume B's; after A closes, a structurally equal lookalike of B's
    // scope fails the identity check too.
    streamManager.emitNestedToolEvent(replaced, nestedEnd);
    expect(registry.take(replaced, "nested-1")).toStrictEqual(snapshot("replaced"));
    registry.close(replaced);
    streamManager.emitNestedToolEvent(replaced, nestedEnd);
    streamManager.emitNestedToolEvent({ ...replacement }, nestedEnd);
    expect(nestedCalls().every((call) => call.mcpServer === undefined)).toBe(true);
    expect(ends.every((event) => event.mcpServer === undefined)).toBe(true);
    expect(registry.take(replacement, "nested-1")).toStrictEqual(snapshot("replacement"));

    // Only the owning scope object consumes it, and only once.
    registry.set(replacement, "nested-1", snapshot("replacement"));
    streamManager.emitNestedToolEvent(replacement, nestedEnd);
    const owned = nestedCalls().find((call) => call.mcpServer !== undefined);
    expect(owned?.toolCallId).toBe("nested-1");
    expect(owned?.mcpServer).toStrictEqual(snapshot("replacement"));
    const ownedEvent = ends.find((event) => event.mcpServer !== undefined);
    expect(ownedEvent?.toolCallId).toBe("nested-1");
    expect(ownedEvent?.parentToolCallId).toBe("code-exec");
    expect(registry.take(replacement, "nested-1")).toBeUndefined();
  });

  test("replay carries persisted snapshots for top-level parts and nested records", async () => {
    const streamManager = new StreamManager(historyService);
    const timestamp = Date.now();
    registerStream(streamManager, replacement, [
      toolPart("call-1", {
        state: "output-available",
        output: { content: [] },
        mcpServer: snapshot("top"),
      }),
      toolPart("code-exec", {
        toolName: "code_execution",
        input: { code: "…" },
        state: "output-available",
        output: { ok: true },
        nestedCalls: [
          {
            toolCallId: "nested-1",
            toolName: "identity_identity_probe",
            input: {},
            state: "output-available",
            output: { content: [] },
            timestamp: timestamp + 1,
            mcpServer: snapshot("nested"),
          },
        ],
      }),
    ]);
    const ends: ToolCallEndEvent[] = [];
    onTurnEngineEvent(streamManager, "tool-call-end", (event) => ends.push(event));

    await streamManager.replayStream(workspaceId);

    expect(ends.find((e) => e.toolCallId === "call-1")?.mcpServer).toStrictEqual(snapshot("top"));
    const nested = ends.find((e) => e.toolCallId === "nested-1");
    expect(nested?.parentToolCallId).toBe("code-exec");
    expect(nested?.mcpServer).toStrictEqual(snapshot("nested"));
    expect(ends.find((e) => e.toolCallId === "code-exec")?.mcpServer).toBeUndefined();
  });
});
