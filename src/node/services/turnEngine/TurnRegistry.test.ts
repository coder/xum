import { describe, expect, test } from "bun:test";
import { Scope } from "effect";

import type { StreamAbortReason } from "@/common/types/stream";
import { closeScopeBounded } from "@/node/services/di/appRuntime";
import { defaultEffectRunner } from "@/node/services/di/effectRunner";
import type {
  ActiveStreamInfo,
  MockStreamLifecycle,
  TurnCompletion,
  TurnCompletionController,
  TurnEngineEvent,
  WorkspaceId,
} from "@/node/services/turnEngine/types";
import type { WorkspaceStreamInfo } from "@/node/services/turnEngine/turnState";

import { TurnEvents } from "./TurnEvents";
import { StreamState, TurnRegistry } from "./TurnRegistry";

const WS = "turn-registry-ws" as WorkspaceId;

interface Cleanup {
  messageId: string;
  abortReason: StreamAbortReason;
  abandonPartial?: boolean;
}

/**
 * A TurnRegistry whose abort cleanup does what StreamManager's does to the slot:
 * it settles the turn's completion and frees the slot if the turn still owns it.
 */
function createRegistry(options: { engineScope?: Scope.Closeable } = {}) {
  const events: TurnEngineEvent[] = [];
  const flushes: string[] = [];
  const cleanups: Cleanup[] = [];
  let mock: MockStreamLifecycle | undefined;
  const registry: TurnRegistry = new TurnRegistry({
    effectRunner: defaultEffectRunner,
    engineScope: options.engineScope,
    turnEvents: new TurnEvents((event) => void events.push(event), {
      flushPartialWrite: () => Promise.resolve(),
    }),
    mockStreamLifecycle: () => mock,
    flushPartialWrite: (_id, info) => {
      flushes.push(info.messageId);
      return Promise.resolve();
    },
    cleanupAbortedStream: async (id, info, abortReason, abandonPartial) => {
      cleanups.push({ messageId: info.messageId, abortReason, abandonPartial });
      await info.processingPromise;
      info.completionController.settle({ status: "aborted", abortReason });
      if (registry.workspaceStreams.get(id) === info) registry.workspaceStreams.delete(id);
    },
  });
  return {
    registry,
    events,
    flushes,
    cleanups,
    setMock: (next: MockStreamLifecycle | undefined) => {
      mock = next;
    },
  };
}

/** A settle-once completion, like StreamManager's createTurnCompletionController. */
function completionController(): TurnCompletionController {
  const completion = Promise.withResolvers<TurnCompletion>();
  let settled = false;
  return {
    promise: completion.promise,
    settle: (value) => {
      if (settled) return;
      settled = true;
      completion.resolve(value);
    },
  };
}

function streamFixture(overrides: Partial<WorkspaceStreamInfo> = {}): WorkspaceStreamInfo {
  const info: Partial<WorkspaceStreamInfo> = {
    messageId: "msg-1",
    state: StreamState.STREAMING,
    model: "anthropic:claude-test",
    historySequence: 3,
    startTime: 1,
    parts: [],
    currentStepStartIndex: 0,
    stepStartIndices: [0],
    processingPromise: Promise.resolve(),
    abortController: new AbortController(),
    softInterrupt: { pending: false },
    completionController: completionController(),
    ...overrides,
  };
  return info as WorkspaceStreamInfo;
}

describe("TurnRegistry", () => {
  test("concurrent hard stops flush once and run one abort cleanup with the first reason", async () => {
    const { registry, flushes, cleanups } = createRegistry();
    const info = streamFixture();
    registry.workspaceStreams.set(WS, info);

    const results = await Promise.all([
      registry.stopStream(WS, { abortReason: "user", abandonPartial: true }),
      registry.stopStream(WS, { abortReason: "system" }),
    ]);

    expect(results.every((result) => result.success)).toBe(true);
    expect(flushes).toEqual(["msg-1"]);
    expect(cleanups).toEqual([{ messageId: "msg-1", abortReason: "user", abandonPartial: true }]);
    expect(info.abortController.signal.aborted).toBe(true);
    expect(registry.isStreaming(WS)).toBe(false);
  });

  test("a hard stop without a reason aborts the turn as system", async () => {
    const { registry, cleanups } = createRegistry();
    registry.workspaceStreams.set(WS, streamFixture());

    await registry.stopStream(WS);

    expect(cleanups).toEqual([{ messageId: "msg-1", abortReason: "system" }]);
  });

  test("a soft stop ends the turn at the next boundary, and a later hard stop joins it", async () => {
    const { registry, cleanups } = createRegistry();
    const info = streamFixture();
    registry.workspaceStreams.set(WS, info);

    await registry.stopStream(WS, { soft: true, abortReason: "user" });
    expect(cleanups).toEqual([]);
    expect(info.abortController.signal.aborted).toBe(false);

    await registry.checkSoftCancelStream(WS, info);
    await registry.stopStream(WS, { abortReason: "system" });

    expect(info.abortController.signal.aborted).toBe(true);
    expect(cleanups).toEqual([{ messageId: "msg-1", abortReason: "user", abandonPartial: false }]);
  });

  test("a boundary without a soft stop leaves the turn running", async () => {
    const { registry, flushes, cleanups } = createRegistry();
    const info = streamFixture();
    registry.workspaceStreams.set(WS, info);

    await registry.checkSoftCancelStream(WS, info);

    expect(flushes).toEqual([]);
    expect(cleanups).toEqual([]);
    expect(registry.getStreamState(WS)).toBe(StreamState.STREAMING);
  });

  test("a stop aimed at an earlier execution leaves the replacement running", async () => {
    const { registry, cleanups, events } = createRegistry();
    registry.workspaceStreams.set(WS, streamFixture({ messageId: "replacement" }));

    const result = await registry.stopStream(WS, { expectedMessageId: "earlier" });

    expect(result.success).toBe(true);
    expect(cleanups).toEqual([]);
    expect(events).toEqual([]);
    expect(registry.isStreaming(WS)).toBe(true);
  });

  test("a stop during a pending start aborts it and delivers one startup stream-abort", async () => {
    const { registry, events } = createRegistry();
    const handle = registry.beginStreamStart({ workspaceId: WS, acpPromptId: "prompt-1" });

    await registry.stopStream(WS);
    await registry.stopStream(WS, { abortReason: "user" });

    expect(handle.abortSignal.aborted).toBe(true);
    expect(registry.getStartupAbortReason(handle.abortSignal)).toBe("startup");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "stream-abort",
      messageId: handle.syntheticMessageId,
      abortReason: "startup",
      acpPromptId: "prompt-1",
    });

    // Once the start finishes, a stop finds nothing and reports a bare abort.
    handle.finish();
    await registry.stopStream(WS, { abortReason: "user" });
    await registry.stopStream(WS, { emitIfMissing: false });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "stream-abort", messageId: "", abortReason: "user" });
  });

  test("finishing a superseded pending start keeps the newer start stoppable", async () => {
    const { registry } = createRegistry();
    const first = registry.beginStreamStart({ workspaceId: WS });
    const second = registry.beginStreamStart({ workspaceId: WS });

    first.finish();
    await registry.stopStream(WS);

    expect(first.abortSignal.aborted).toBe(false);
    expect(second.abortSignal.aborted).toBe(true);
  });

  test("a caller's abort signal reaches a pending start until it finishes", () => {
    const { registry } = createRegistry();
    const caller = new AbortController();
    const handle = registry.beginStreamStart({ workspaceId: WS, abortSignal: caller.signal });
    handle.finish();
    const linked = registry.beginStreamStart({ workspaceId: WS, abortSignal: caller.signal });

    caller.abort("user");

    expect(handle.abortSignal.aborted).toBe(false);
    expect(linked.abortSignal.aborted).toBe(true);
  });

  test("a mock lifecycle set after construction answers the lifecycle calls", async () => {
    const { registry, cleanups, events, setMock } = createRegistry();
    registry.workspaceStreams.set(WS, streamFixture());
    const stops: string[] = [];
    const snapshot: ActiveStreamInfo = {
      messageId: "mock-msg",
      model: "mock:model",
      historySequence: 1,
      startTime: 1,
      parts: [],
      currentStepStartIndex: 0,
      stepStartIndices: [],
      toolCompletionTimestamps: new Map(),
    };
    setMock({
      isStreaming: () => false,
      stop: (workspaceId) => {
        stops.push(workspaceId);
        return Promise.resolve();
      },
      getStreamInfo: () => snapshot,
      replayStream: () => Promise.resolve(),
    });

    expect(registry.isStreaming(WS)).toBe(false);
    expect(registry.getStreamInfo(WS)).toBe(snapshot);
    await registry.stopStream(WS);
    // The mock owns the abort it reports, so a stop with no registered stream adds none.
    registry.workspaceStreams.delete(WS);
    await registry.stopStream(WS);

    expect(stops).toEqual([WS, WS]);
    expect(cleanups).toEqual([]);
    expect(events).toEqual([]);
  });

  test("a new start cancels a live turn as system, but not an idle one", async () => {
    const { registry, cleanups } = createRegistry();
    registry.workspaceStreams.set(WS, streamFixture({ state: StreamState.IDLE }));
    const idleToken = await registry.ensureStreamSafety(WS);

    const live = streamFixture({ messageId: "live" });
    registry.workspaceStreams.set(WS, live);
    const token = await registry.ensureStreamSafety(WS);

    expect(idleToken).toMatch(/^[0-9a-f]{1,8}$/);
    expect(token).toMatch(/^[0-9a-f]{1,8}$/);
    expect(cleanups).toEqual([{ messageId: "live", abortReason: "system" }]);
    expect(live.abortController.signal.aborted).toBe(true);
  });

  test("closing the engine scope stops a supervised turn as system and waits for it", async () => {
    const engineScope = Scope.makeUnsafe("parallel");
    const { registry, cleanups } = createRegistry({ engineScope });
    const running = streamFixture({ messageId: "running" });
    const settled = streamFixture({ messageId: "settled" });
    registry.workspaceStreams.set(WS, running);
    registry.superviseEngine(WS, running);
    registry.superviseEngine("other-ws" as WorkspaceId, settled);
    settled.completionController.settle({ status: "aborted", abortReason: "user" });

    await closeScopeBounded(engineScope);

    expect(cleanups).toEqual([{ messageId: "running", abortReason: "system" }]);
    expect(await running.completionController.promise).toEqual({
      status: "aborted",
      abortReason: "system",
    });
  });

  test("without an engine scope a turn is not supervised", () => {
    const { registry } = createRegistry();
    const info = streamFixture();

    registry.superviseEngine(WS, info);

    expect(info.engineFiber).toBeUndefined();
  });

  test("start locks serialize one workspace and leave others free", async () => {
    const { registry } = createRegistry();
    const order: string[] = [];
    const held = await registry.acquireStreamStartLock(WS);

    const waiter = registry.acquireStreamStartLock(WS).then(async (lock) => {
      order.push("same workspace");
      await lock[Symbol.asyncDispose]();
    });
    const other = await registry.acquireStreamStartLock("other-ws");
    order.push("other workspace");
    await other[Symbol.asyncDispose]();
    await held[Symbol.asyncDispose]();
    await waiter;

    expect(order).toEqual(["other workspace", "same workspace"]);
  });

  test("stream info is reported for starting and streaming turns, finalizing ones on request", () => {
    const { registry } = createRegistry();
    registry.workspaceStreams.set(
      WS,
      streamFixture({ state: StreamState.COMPLETED, stepStartIndices: [0, 2] })
    );

    expect(registry.getStreamInfo(WS)).toBeUndefined();
    const finalizing = registry.getStreamInfo(WS, true);
    expect(finalizing).toMatchObject({ messageId: "msg-1", historySequence: 3 });
    expect(finalizing?.toolCompletionTimestamps).toEqual(new Map());

    registry.workspaceStreams.set(WS, streamFixture({ state: StreamState.STARTING }));
    expect(registry.getStreamInfo(WS)?.messageId).toBe("msg-1");
    expect(registry.getActiveStreams()).toEqual([WS]);
    expect(registry.getStreamState("missing-ws")).toBe(StreamState.IDLE);
  });
});
