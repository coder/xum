/**
 * onChat replay batching (#4868): with `batchReplay`, consecutive text-only history rows reach
 * the listener as `message-batch` events holding the rows' wire-schema parse output. These tests
 * pin that batching changes only the grouping (the flattened rows, their order and every other
 * event match single-row replay), the caps and flush rules that bound a batch's size and latency,
 * and that a replay failure cannot lose rows still waiting in a batch.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHAT_FILE_NAME } from "@/common/constants/paths";
import type { MuxMessage } from "@/common/types/message";
import type { CaughtUpMessage, WorkspaceChatMessage } from "@/common/orpc/types";
import { EventLoopYielder } from "@/node/utils/concurrency/eventLoopYielder";
import { log } from "./log";
import { ONCHAT_REPLAY_TIMING_LOG_MESSAGE } from "./onChatReplayTiming";
import type { AgentSessionChatEvent } from "./agentSession";
import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "ws-replay-batching";
const SKIP_WARNING = "onChat replay: skipping persisted row that fails the wire schema";

interface StreamInfo {
  messageId: string;
  startTime: number;
  parts: Array<{ type: "text"; text: string; timestamp?: number }>;
  toolCompletionTimestamps: Map<string, number>;
}

async function createHarness(
  rows: unknown[],
  options?: { streamInfo?: StreamInfo; onReplayStream?: () => void; onReplayInit?: () => void }
): Promise<AgentSessionHarness> {
  const harness = await createAgentSessionHarness({
    workspaceId,
    aiServiceOverrides: {
      getStreamInfo: mock((_workspaceId: string) => options?.streamInfo),
      replayStream: mock((_workspaceId: string, _opts?: { afterTimestamp?: number }) => {
        options?.onReplayStream?.();
        return Promise.resolve();
      }),
    },
    initStateManagerOverrides: {
      replayInit: mock((_workspaceId: string) => {
        options?.onReplayInit?.();
        return Promise.resolve();
      }),
    },
  });
  // Raw lines so the corpus can hold rows the history writer would refuse (self-healing skip).
  const sessionDir = path.join(harness.config.sessionsDir, workspaceId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, CHAT_FILE_NAME),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
  );
  return harness;
}

function textRow(id: string, seq: number, text = `text ${id}`): unknown {
  return {
    id,
    role: seq % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text }],
    metadata: { historySequence: seq, timestamp: 1_000 + seq },
  };
}

function reasoningRow(id: string, seq: number): unknown {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "answer" },
    ],
    metadata: { historySequence: seq, timestamp: 1_000 + seq },
  };
}

function toolRow(id: string, seq: number): unknown {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: `call-${id}`,
        toolName: "bash",
        input: { script: "ls" },
        state: "output-available",
        output: { stdout: "a", exitCode: 0 },
      },
    ],
    metadata: { historySequence: seq, timestamp: 1_000 + seq },
  };
}

function fileRow(id: string, seq: number): unknown {
  return {
    id,
    role: "user",
    parts: [
      { type: "text", text: "see attached" },
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA" },
    ],
    metadata: { historySequence: seq, timestamp: 1_000 + seq },
  };
}

function textRows(count: number, firstSeq = 0, text?: (index: number) => string): unknown[] {
  return Array.from({ length: count }, (_, index) =>
    textRow(`t${firstSeq + index}`, firstSeq + index, text?.(index))
  );
}

async function replay(
  harness: AgentSessionHarness,
  batchReplay: boolean,
  beforeReplayCompletion?: (events: AgentSessionChatEvent[]) => void
): Promise<AgentSessionChatEvent[]> {
  const events: AgentSessionChatEvent[] = [];
  await harness.session.replayHistory(
    (event) => events.push(event),
    { type: "full" },
    beforeReplayCompletion ? () => beforeReplayCompletion(events) : undefined,
    { batchReplay }
  );
  return events;
}

function rowId(message: WorkspaceChatMessage): string {
  if (message.type !== "message") throw new Error(`expected a message row, got ${message.type}`);
  return message.id;
}

/** Each row event as `message:<id>` or `batch:<id>,<id>…`; other events are dropped. */
function shapes(events: AgentSessionChatEvent[]): string[] {
  const result: string[] = [];
  for (const { message } of events) {
    if (message.type === "message-batch") {
      result.push(`batch:${message.messages.map(rowId).join(",")}`);
    } else if (message.type === "message") {
      result.push(`message:${message.id}`);
    }
  }
  return result;
}

/** The rows as they would go on the wire, one per row, in order. */
function wireRows(events: AgentSessionChatEvent[]): WorkspaceChatMessage[] {
  return events.flatMap(({ message, wireMessage }) => {
    if (message.type === "message-batch") {
      // Batches are only produced on the self-validating path: both fields are parse output.
      expect(wireMessage).toBe(message);
      return message.messages;
    }
    if (message.type !== "message") return [];
    if (!wireMessage) throw new Error(`row ${message.id} has no wire message`);
    return [wireMessage];
  });
}

function caughtUp(events: AgentSessionChatEvent[]): CaughtUpMessage {
  const event = events.find(({ message }) => message.type === "caught-up")?.message;
  if (event?.type !== "caught-up") throw new Error("replay ended without caught-up");
  return event;
}

function timingLogFields(spies: Array<{ mock: { calls: unknown[][] } }>): unknown[] {
  return spies.flatMap((spy) =>
    spy.mock.calls.filter((call) => call[0] === ONCHAT_REPLAY_TIMING_LOG_MESSAGE).map((c) => c[1])
  );
}

describe("onChat replay batching (#4868)", () => {
  let harness: AgentSessionHarness | undefined;
  afterEach(async () => {
    mock.restore();
    await harness?.session.dispose();
    await harness?.cleanup();
    harness = undefined;
  });

  it("changes only the grouping: same rows, same other events, same counts and skips", async () => {
    const rows = [
      ...textRows(70),
      toolRow("tool", 70),
      reasoningRow("reasoning", 71),
      // Self-healing: fails the wire schema, so it must stay skipped in both modes.
      { ...(textRow("corrupt", 72) as object), metadata: { historySequence: "72" } },
      fileRow("file", 73),
      ...textRows(3, 74),
    ];
    // Init replay emits after the partial row: batching must not hold the partial past it.
    const created = await createHarness(rows, {
      onReplayInit: () =>
        created.session.emitChatEvent({
          type: "init-end",
          exitCode: 0,
          timestamp: 3_000,
          replay: true,
        }),
    });
    harness = created;
    const partial = {
      id: "partial",
      role: "assistant",
      parts: [{ type: "text", text: "streaming", state: "streaming" }],
      metadata: { historySequence: 77, timestamp: 2_000, partial: true },
    } as unknown as MuxMessage;
    expect((await harness.historyService.writePartial(workspaceId, partial)).success).toBe(true);

    const warn = spyOn(log, "warn");
    const debug = spyOn(log, "debug");
    const info = spyOn(log, "info");
    const single = await replay(harness, false);
    const batched = await replay(harness, true);

    // Flag off: one plain event per row, exactly as before batching existed.
    expect(single.some(({ message }) => message.type === "message-batch")).toBe(false);
    expect(batched.some(({ message }) => message.type === "message-batch")).toBe(true);

    const expectedIds = [
      ...Array.from({ length: 70 }, (_, index) => `t${index}`),
      "tool",
      "reasoning",
      "file",
      "t74",
      "t75",
      "t76",
      "partial",
    ];
    expect(wireRows(single).map(rowId)).toEqual(expectedIds);
    // Unpacking the batches gives exactly the single-row event sequence: the same rows (wire
    // bytes) and the same other events (init replay, terminal state, queue snapshot, caught-up)
    // in the same places.
    const flattened = (events: AgentSessionChatEvent[]) =>
      events.flatMap((event) =>
        event.message.type === "message" || event.message.type === "message-batch"
          ? wireRows([event]).map((row) => JSON.stringify(row))
          : [JSON.stringify(event.message)]
      );
    expect(flattened(batched)).toEqual(flattened(single));
    const types = single.map(({ message }) => message.type);
    expect(types.indexOf("init-end")).toBeGreaterThan(types.lastIndexOf("message"));
    // The partial row goes out alone after every batch, even though it is text-only.
    expect(shapes(batched).at(-1)).toBe("message:partial");

    const skipped = warn.mock.calls.filter((call) => call[0] === SKIP_WARNING);
    expect(skipped.map((call) => (call[1] as { messageId?: string }).messageId)).toEqual([
      "corrupt",
      "corrupt",
    ]);

    // The replay log keeps counting rows, not events.
    const [singleTiming, batchedTiming] = timingLogFields([debug, info]) as Array<{
      sentRowCount: number;
    }>;
    expect(singleTiming.sentRowCount).toBe(expectedIds.length - 1);
    expect(batchedTiming.sentRowCount).toBe(singleTiming.sentRowCount);
  });

  it("splits batches at the row cap and the text cap, and sends an oversized row alone", async () => {
    const sixtyFourKiB = "x".repeat(64 * 1024);
    harness = await createHarness([
      // 150 small rows: row cap of 64.
      ...textRows(150),
      toolRow("tool", 150),
      // Rows at the 64 KiB per-row limit still batch; 4 fill the 256 KiB text cap exactly.
      ...textRows(6, 151, () => sixtyFourKiB),
      // Over the 64 KiB per-row limit: sent alone even between batchable rows.
      textRow("huge", 157, "y".repeat(64 * 1024 + 1)),
      ...textRows(2, 158),
    ]);

    const counts = shapes(await replay(harness, true)).map((shape) =>
      shape.startsWith("batch:") ? shape.split(",").length : shape
    );
    expect(counts).toEqual([64, 64, 22, "message:tool", 4, 2, "message:huge", 2]);
  });

  it("sends non-text rows alone after the pending batch, and a lone text row unbatched", async () => {
    harness = await createHarness([
      textRow("a", 0),
      textRow("b", 1),
      toolRow("tool", 2),
      textRow("lone", 3),
      fileRow("file", 4),
      reasoningRow("c", 5),
      textRow("d", 6),
    ]);

    expect(shapes(await replay(harness, true))).toEqual([
      "batch:a,b",
      "message:tool",
      "message:lone",
      "message:file",
      "batch:c,d",
    ]);
  });

  it("delivers batched rows before yielding the event loop", async () => {
    harness = await createHarness(textRows(10));
    // Make only the replay loop's 4th row find its emit slice used up. The history read also
    // polls isDue, so arm the countdown once the step right before the loop has finished.
    let armed = false;
    const hasHistoryBeforeSequence = harness.historyService.hasHistoryBeforeSequence.bind(
      harness.historyService
    );
    spyOn(harness.historyService, "hasHistoryBeforeSequence").mockImplementation(
      async (...args) => {
        const result = await hasHistoryBeforeSequence(...args);
        armed = true;
        return result;
      }
    );
    let loopChecks = 0;
    spyOn(EventLoopYielder.prototype, "isDue").mockImplementation(
      () => armed && ++loopChecks === 4
    );
    const events: AgentSessionChatEvent[] = [];
    const deliveredAtYield: string[][] = [];
    spyOn(EventLoopYielder.prototype, "yield").mockImplementation(() => {
      deliveredAtYield.push(wireRows(events).map(rowId));
      return Promise.resolve();
    });

    await harness.session.replayHistory(
      (event) => events.push(event),
      { type: "full" },
      undefined,
      {
        batchReplay: true,
      }
    );

    expect(deliveredAtYield).toEqual([["t0", "t1", "t2"]]);
    expect(shapes(events)).toEqual(["batch:t0,t1,t2", "batch:t3,t4,t5,t6,t7,t8,t9"]);
  });

  it("delivers pending rows before completion when replay fails mid-loop", async () => {
    harness = await createHarness(textRows(5));
    // A row that throws when the replay loop copies it: an unexpected failure while rows 0-2 are
    // still waiting in a batch.
    const poisoned = {
      id: "poisoned",
      role: "user",
      metadata: { historySequence: 3, timestamp: 1_003 },
    };
    Object.defineProperty(poisoned, "parts", {
      enumerable: true,
      get: () => {
        throw new Error("row read failed");
      },
    });
    const getHistory = harness.historyService.getHistoryFromLatestBoundary.bind(
      harness.historyService
    );
    spyOn(harness.historyService, "getHistoryFromLatestBoundary").mockImplementation(
      async (...args) => {
        const result = await getHistory(...args);
        if (result.success) result.data.splice(3, 1, poisoned as unknown as MuxMessage);
        return result;
      }
    );
    spyOn(log, "error").mockImplementation(() => undefined);

    let deliveredBeforeCompletion: string[] = [];
    const events = await replay(harness, true, (delivered) => {
      deliveredBeforeCompletion = wireRows(delivered).map(rowId);
    });

    expect(deliveredBeforeCompletion).toEqual(["t0", "t1", "t2"]);
    expect(shapes(events)).toEqual(["batch:t0,t1,t2"]);
    const rowsIndex = events.findIndex(({ message }) => message.type === "message-batch");
    const caughtUpIndex = events.findIndex(({ message }) => message.type === "caught-up");
    expect(rowsIndex).toBeLessThan(caughtUpIndex);
    expect(caughtUp(events).historyReplayStatus).toBe("failed");
  });

  it("delivers batched rows before replayed stream events", async () => {
    const streamInfo: StreamInfo = {
      messageId: "streaming",
      startTime: 5_000,
      parts: [],
      toolCompletionTimestamps: new Map(),
    };
    const created = await createHarness(textRows(3), {
      streamInfo,
      onReplayStream: () =>
        created.session.emitChatEvent({
          type: "stream-start",
          workspaceId,
          messageId: "streaming",
          replay: true,
          model: "anthropic:claude-test",
          historySequence: 3,
          startTime: 5_000,
        }),
    });
    harness = created;

    const types = (await replay(harness, true))
      .map(({ message }) => message.type)
      .filter((type) => type === "message-batch" || type === "message" || type === "stream-start");
    expect(types).toEqual(["message-batch", "stream-start"]);
  });
});
