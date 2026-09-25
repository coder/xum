/**
 * Live-stream fixtures for StreamManager tests: a real StreamManager whose
 * provider streams come from test-fed chunk feeds, so tests drive startStream
 * and observe public outputs (events, getStreamInfo, replayStream, partial)
 * instead of seeding private engine state.
 */
import type { Tool } from "ai";
import {
  StreamManager,
  type TurnCompletion,
  type TurnEngineEvent,
  type TurnExecutionOptions,
} from "./streamManager";
import {
  fakeStreamText,
  noopTokenTracker,
  type StreamManagerTestDeps,
} from "./streamManager.testHarness";
import {
  historyService,
  createTestLanguageModel,
  testStartOptions,
  appendPartialAssistantForTests,
  createStreamResultForTests,
} from "./streamManager.suite.testHarness";
import type { ToolCallDisplayRegistry } from "./toolCallDisplayRegistry";

const END_OF_STREAM = Symbol("end-of-stream");

/**
 * A provider fullStream the test feeds one chunk at a time. push() resolves only
 * after StreamManager finished processing each chunk and asked for the next one,
 * so tests observe (and replay) a live stream at an exact point. If the consumer
 * stops iterating (a chunk threw, or the stream exited early), push() rejects
 * instead of waiting for a next pull that never comes.
 */
export function createChunkFeed() {
  let deliver: ((chunk: unknown) => void) | undefined;
  let signalWaiting!: () => void;
  let waiting = new Promise<void>((resolve) => (signalWaiting = resolve));
  let closed = false;
  async function* fullStream() {
    try {
      while (true) {
        const chunk = await new Promise<unknown>((resolve) => {
          deliver = resolve;
          signalWaiting();
        });
        if (chunk === END_OF_STREAM) return;
        yield chunk;
      }
    } finally {
      // Also runs when the consumer returns early (for-await exits on a throw or
      // break); wake a pending push() so it reports the closed stream.
      closed = true;
      signalWaiting();
    }
  }
  const assertOpen = (when: string) => {
    if (closed) throw new Error(`chunk feed: the stream stopped consuming ${when}`);
  };
  const send = async (chunk: unknown) => {
    await waiting;
    assertOpen("before this chunk");
    waiting = new Promise<void>((resolve) => (signalWaiting = resolve));
    const next = deliver;
    deliver = undefined;
    if (next == null) throw new Error("chunk feed has no waiting consumer");
    next(chunk);
  };
  return {
    fullStream: fullStream(),
    waiting: () => waiting,
    push: async (...chunks: unknown[]) => {
      for (const chunk of chunks) {
        await send(chunk);
        await waiting;
        assertOpen("after a chunk");
      }
    },
    end: () => send(END_OF_STREAM),
  };
}

export interface LiveStream {
  push: (...chunks: unknown[]) => Promise<void>;
  /** Ends the stream normally and asserts that it completed (not failed or aborted). */
  finish: () => Promise<void>;
}

export type LiveStreamOptions = Partial<TurnExecutionOptions> &
  Pick<TurnExecutionOptions, "workspaceId" | "messageId">;

export interface LiveStreamHarnessDeps extends Omit<
  StreamManagerTestDeps,
  "eventSink" | "streamText"
> {
  /** Shared with the test, as the MCP tool wrapper shares it in production. */
  toolCallDisplayRegistry?: ToolCallDisplayRegistry;
}

/**
 * A real StreamManager whose provider streams come from chunk feeds. Every
 * engine event lands in `events`; `tools()` returns the tool set StreamManager
 * handed to the provider (wrapped by withSequentialExecution), so a test can
 * run execute() the way the AI SDK would.
 */
export function createLiveStreamHarness(deps: LiveStreamHarnessDeps = {}) {
  const events: TurnEngineEvent[] = [];
  let feed: ReturnType<typeof createChunkFeed> | undefined;
  let providerTools: Record<string, Tool> = {};
  const streamText = fakeStreamText((options) => {
    providerTools = (options.tools ?? {}) as Record<string, Tool>;
    // Each started stream consumes its feed once; a retry would see an empty stream.
    const fullStream =
      feed?.fullStream ??
      (async function* () {
        // No feed left: an unexpected second request streams nothing.
      })();
    feed = undefined;
    return createStreamResultForTests(fullStream);
  });
  const streamManager = new StreamManager(
    historyService,
    deps.sessionUsageService,
    deps.getProvidersConfig,
    (event) => {
      events.push(event);
    },
    deps.runner,
    deps.engineScope,
    deps.toolCallDisplayRegistry,
    { streamText, tokenTracker: deps.tokenTracker ?? noopTokenTracker }
  );
  return {
    streamManager,
    events,
    tools: () => providerTools,
    /** Starts a stream and waits until StreamManager awaits its first chunk. */
    async start(options: LiveStreamOptions): Promise<LiveStream> {
      const streamFeed = createChunkFeed();
      feed = streamFeed;
      await appendPartialAssistantForTests(
        options.workspaceId,
        options.messageId,
        options.historySequence ?? 1
      );
      const result = await streamManager.startStream(
        testStartOptions({
          model: createTestLanguageModel(),
          providedRuntimeTempDir: "",
          ...options,
        })
      );
      if (!result.success) throw new Error("Expected stream to start");
      await streamFeed.waiting();
      const { completion } = result.data;
      // The handle settles for failed/aborted streams too; a push() racing it
      // fails with the terminal status instead of hanging until the test timeout.
      const settledEarly = completion.then((settled) => {
        throw new Error(`stream settled while the test was feeding it: ${describe(settled)}`);
      });
      settledEarly.catch(() => undefined);
      return {
        push: async (...chunks) => {
          try {
            await Promise.race([streamFeed.push(...chunks), settledEarly]);
          } catch (error) {
            const settled = await completion;
            throw new Error(`live stream push failed (${describe(settled)})`, { cause: error });
          }
        },
        finish: async () => {
          await streamFeed.push({ type: "finish", finishReason: "stop" });
          await streamFeed.end();
          const settled = await completion;
          if (settled.status !== "completed") {
            throw new Error(`expected the stream to complete, got ${describe(settled)}`);
          }
        },
      };
    },
  };
}

function describe(completion: TurnCompletion): string {
  return completion.status === "failed"
    ? `failed: ${completion.streamError.error}`
    : completion.status;
}

export function eventsOfType<T extends TurnEngineEvent["type"]>(
  events: readonly TurnEngineEvent[],
  type: T
): Array<Extract<TurnEngineEvent, { type: T }>> {
  return events.filter((event): event is Extract<TurnEngineEvent, { type: T }> => {
    return event.type === type;
  });
}
