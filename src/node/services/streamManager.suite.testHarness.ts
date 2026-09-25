/**
 * Shared fixtures for the StreamManager test files (streamManager*.test.ts).
 */
import { expect, afterEach, beforeEach } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { type TurnExecutionOptions } from "./streamManager";
import { type LanguageModel } from "ai";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { createRuntime } from "@/node/runtime/runtimeFactory";

// Real HistoryService backed by a temp directory (created fresh per test)
export let historyService: HistoryService;
export let historyConfig: Awaited<ReturnType<typeof createTestHistoryService>>["config"];
let historyCleanup: () => Promise<void>;

/** Registers the fresh-per-test HistoryService hooks in the calling test file. */
export function installStreamManagerTestHistory(): void {
  beforeEach(async () => {
    ({
      historyService,
      config: historyConfig,
      cleanup: historyCleanup,
    } = await createTestHistoryService());
  });

  afterEach(async () => {
    await historyCleanup();
  });
}

export function createTestLanguageModel(
  modelId = "cleanup-model",
  provider = "test"
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("doGenerate is unused in StreamManager tests")),
    doStream: () => Promise.reject(new Error("doStream is unused in StreamManager tests")),
  };
}

export const TEST_STREAM_MODEL_ID = KNOWN_MODELS.SONNET.id;

export const TEST_USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

export const LOCAL_TEST_RUNTIME = createRuntime({ type: "local", srcBaseDir: "/tmp" });

/** Base startStream options; scenarios override only what they assert. */
export function testStartOptions(
  overrides: Partial<TurnExecutionOptions> &
    Pick<TurnExecutionOptions, "workspaceId" | "messageId" | "model">
): TurnExecutionOptions {
  return {
    messages: [{ role: "user", content: "hello" }],
    modelString: "openai:gpt-4.1-mini",
    historySequence: 1,
    system: "system",
    runtime: LOCAL_TEST_RUNTIME,
    ...overrides,
  };
}

export async function appendPartialAssistantForTests(
  workspaceId: string,
  messageId: string,
  historySequence: number
): Promise<void> {
  const appendResult = await historyService.appendToHistory(workspaceId, {
    id: messageId,
    role: "assistant",
    metadata: { historySequence, partial: true },
    parts: [],
  });
  expect(appendResult.success).toBe(true);
  if (!appendResult.success) {
    throw new Error(appendResult.error);
  }
}

export function createStreamResultForTests(
  fullStream: AsyncGenerator<unknown, void, unknown>,
  usage: unknown = TEST_USAGE,
  providerMetadata: unknown = undefined
): Record<string, unknown> {
  return {
    fullStream,
    totalUsage: Promise.resolve(usage),
    usage: Promise.resolve(usage),
    providerMetadata: Promise.resolve(providerMetadata),
    steps: Promise.resolve([]),
  };
}

export function createStreamInfoForTests(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const now = Date.now();
  const model = overrides.model ?? TEST_STREAM_MODEL_ID;
  return {
    state: "streaming",
    streamResult: createStreamResultForTests(
      (async function* emptyStream() {
        await Promise.resolve();
        yield* [];
      })()
    ),
    abortController: new AbortController(),
    messageId: "test-message",
    token: "test-token",
    startTime: now,
    lastPartTimestamp: now,
    toolCompletionTimestamps: new Map<string, number>(),
    pendingWorkflowRunAttachments: new Map<string, unknown>(),
    pendingNestedCalls: new Map<string, unknown[]>(),
    pendingToolExecutionStarts: new Map<string, number>(),
    model,
    metadataModel: overrides.metadataModel ?? model,
    historySequence: 1,
    request: { model: createTestLanguageModel(), messages: [], providerOptions: undefined },
    toolModelUsages: [],
    parts: [],
    lastPartialWriteTime: 0,
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
    ...overrides,
  };
}
