/**
 * Shared fixtures for the StreamManager test files (streamManager*.test.ts).
 */
import { expect, afterEach, beforeEach } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { StreamManager, TurnExecutionOptions, WorkspaceStreamInfo } from "./streamManager";
import { fakeStreamText } from "./streamManager.testHarness";
import type { ExecOptions, ExecStream, Runtime } from "@/node/runtime/Runtime";
import type { LanguageModel, ModelMessage, streamText } from "ai";
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

/**
 * Hand-built WorkspaceStreamInfo for the few whitebox engine tests. Every real
 * field is checked against the engine type; only the SDK stream result and the
 * request config are loose fakes (tests supply just the fields the engine reads).
 */
export type StreamInfoFixture = Omit<Partial<WorkspaceStreamInfo>, "streamResult" | "request"> & {
  streamResult?: Record<string, unknown>;
  request?: Record<string, unknown>;
};

export function createStreamInfoForTests(overrides: StreamInfoFixture = {}): StreamInfoFixture {
  const now = Date.now();
  const model = overrides.model ?? TEST_STREAM_MODEL_ID;
  const defaults = {
    // StreamState is a module-private enum and StreamToken a brand: name the
    // runtime values through the engine type.
    state: "streaming" as WorkspaceStreamInfo["state"],
    streamResult: createStreamResultForTests(
      (async function* emptyStream() {
        await Promise.resolve();
        yield* [];
      })()
    ),
    abortController: new AbortController(),
    messageId: "test-message",
    token: "test-token" as WorkspaceStreamInfo["token"],
    startTime: now,
    lastPartTimestamp: now,
    toolCompletionTimestamps: new Map<string, number>(),
    pendingWorkflowRunAttachments: new Map(),
    pendingNestedCalls: new Map(),
    pendingToolExecutionStarts: new Map<string, number>(),
    model,
    metadataModel: overrides.metadataModel ?? model,
    historySequence: 1,
    request: { model: createTestLanguageModel(), messages: [], providerOptions: undefined },
    toolModelUsages: [],
    parts: [],
    lastPartialWriteTime: 0,
    partialWriteFiber: undefined,
    partialWritePromise: undefined,
    processingPromise: Promise.resolve(),
    softInterrupt: { pending: false },
    runtimeTempDir: "",
    runtime: LOCAL_TEST_RUNTIME,
    cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cumulativeProviderMetadata: undefined,
    didRetryPreviousResponseIdAtStep: false,
    receivedTerminalEvent: false,
    currentStepStartIndex: 0,
    stepStartIndices: [0],
    stepTracker: {},
  } satisfies StreamInfoFixture;
  return { ...defaults, ...overrides };
}

/** A fullStream chunk, or a callback awaited at that point of the stream (mid-turn side effects). */
export type ScriptedChunk = Record<string, unknown> | (() => unknown);

/** One provider attempt served by the injected streamText (the primary turn, then each fallback). */
export interface ScriptedAttempt {
  chunks: ScriptedChunk[];
  /** streamResult usage/totalUsage for the attempt; omitted means TEST_USAGE. */
  usage?: Record<string, number>;
  providerMetadata?: Record<string, unknown>;
  /** Keep the stream open after the chunks until the turn's abort signal fires. */
  holdUntilAbort?: boolean;
}

export const STOP_FINISH = { type: "finish", finishReason: "stop" };
export const REFUSAL_FINISH = {
  type: "finish",
  finishReason: "content-filter",
  rawFinishReason: "refusal",
};

/**
 * The scripted fake provider: serves attempts in order, one per streamText call
 * (the turn's own stream, then each internal retry or fallback hop). An Error
 * entry makes that streamText call throw; an extra call fails the test.
 */
export function scriptedStreamText(attempts: Array<ScriptedAttempt | Error>) {
  const queue = [...attempts];
  return fakeStreamText((request) => {
    const attempt = queue.shift();
    if (attempt === undefined) throw new Error("unexpected extra streamText call");
    if (attempt instanceof Error) throw attempt;
    const signal = request.abortSignal!;
    return createStreamResultForTests(
      (async function* () {
        await Promise.resolve();
        for (const chunk of attempt.chunks) {
          if (typeof chunk === "function") await chunk();
          else yield chunk;
        }
        if (attempt.holdUntilAbort && !signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
        }
      })(),
      attempt.usage,
      attempt.providerMetadata
    );
  });
}

/**
 * Starts one turn through startStream (Anthropic model string by default),
 * appends its placeholder partial first, and waits for the terminal outcome.
 */
export async function runTurnForTests(
  streamManager: StreamManager,
  options: Partial<TurnExecutionOptions> & Pick<TurnExecutionOptions, "workspaceId">
) {
  const messageId = options.messageId ?? `${options.workspaceId}-message`;
  const historySequence = options.historySequence ?? 1;
  await appendPartialAssistantForTests(options.workspaceId, messageId, historySequence);
  const result = await streamManager.startStream(
    testStartOptions({
      model: createTestLanguageModel(),
      modelString: KNOWN_MODELS.SONNET.id,
      providedRuntimeTempDir: "",
      ...options,
      messageId,
      historySequence,
    })
  );
  if (!result.success) throw new Error(`Expected stream to start: ${JSON.stringify(result.error)}`);
  return { messageId, completion: await result.data.completion };
}

export interface RecordedExecCall {
  command: string;
  options: ExecOptions;
}

function createExecStreamForTests(): ExecStream {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    stdin: new WritableStream<Uint8Array>({
      write(_chunk) {
        return Promise.resolve();
      },
      close() {
        return Promise.resolve();
      },
    }),
    exitCode: Promise.resolve(0),
    duration: Promise.resolve(0),
  };
}

/** The local test runtime with exec recorded instead of run (temp-dir cleanup uses exec). */
export function createExecRecordingRuntimeForTests(): {
  runtime: Runtime;
  execCalls: RecordedExecCall[];
} {
  const execCalls: RecordedExecCall[] = [];
  const runtime = Object.create(LOCAL_TEST_RUNTIME) as Runtime;
  runtime.exec = (command: string, options: ExecOptions) => {
    execCalls.push({ command, options });
    return Promise.resolve(createExecStreamForTests());
  };
  return { runtime, execCalls };
}

type StreamTextOptionsForTests = Parameters<typeof streamText>[0];

/** A prepareStep result as the AI SDK types it. */
export type PreparedStepForTests = Awaited<
  ReturnType<NonNullable<StreamTextOptionsForTests["prepareStep"]>>
>;

/**
 * Plays one SDK step preparation against the prepareStep StreamManager handed
 * to the injected streamText. StreamManager reads only `messages` and
 * `stepNumber`; the remaining fields satisfy the SDK's callback type.
 */
export async function prepareStepForTests(
  options: StreamTextOptionsForTests,
  messages: ModelMessage[],
  stepNumber = 1
): Promise<PreparedStepForTests> {
  const prepare = options.prepareStep;
  if (!prepare) throw new Error("Expected StreamManager to pass prepareStep");
  return await prepare({
    messages,
    stepNumber,
    model: options.model,
    steps: [],
    initialMessages: messages,
    responseMessages: [],
    instructions: undefined,
    initialInstructions: undefined,
    toolsContext: {},
    runtimeContext: {},
  });
}
