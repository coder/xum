/**
 * onChat windowed full replay (#4961), through the real oRPC procedure. A subscriber that sends
 * `replayWindow: true` receives only the newest rows of the active epoch on a full replay; every
 * other subscriber keeps today's bytes, even while an opted-in one replays concurrently. A since
 * reconnect with a windowed cursor resumes with just the delta, read from the client's range only;
 * every doubt downgrades to a fresh window, never to a full-epoch read. A window read that finds no
 * clean turn start falls back to the full replay.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRouterClient } from "@orpc/server";
import { CHAT_FILE_NAME } from "@/common/constants/paths";
import type {
  CaughtUpMessage,
  OnChatDowngradeReason,
  OnChatMode,
  WorkspaceChatMessage,
} from "@/common/orpc/types";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  ONCHAT_REPLAY_WINDOW_MAX_BYTES,
  ONCHAT_REPLAY_WINDOW_MAX_ROWS,
} from "@/constants/orpcSubscriptions";
import {
  createAgentSessionHarness,
  type AgentSessionHarness,
} from "@/node/services/agentSession.testHarness";
import type { ORPCContext } from "./context";
import { router } from "./router";

const workspaceId = "ws-replay-window";

/** HistoryService assigns sequences in append order, so row i gets sequence i. */
const row = (sequence: number, role: "user" | "assistant") =>
  createMuxMessage(`m${sequence}`, role, `text ${sequence}`, { timestamp: 1_000 + sequence });

/** More rows than one window holds, so a windowed replay must cut. */
const EPOCH_ROWS = ONCHAT_REPLAY_WINDOW_MAX_ROWS + 100;

async function createHarness(rows: MuxMessage[]): Promise<AgentSessionHarness> {
  const harness = await createAgentSessionHarness({
    workspaceId,
    aiServiceOverrides: {
      getStreamInfo: mock((_workspaceId: string) => undefined),
      replayStream: mock((_workspaceId: string, _opts?: { afterTimestamp?: number }) =>
        Promise.resolve()
      ),
    },
    initStateManagerOverrides: { replayInit: mock((_workspaceId: string) => Promise.resolve()) },
  });
  if (rows.length > 0) {
    expect((await harness.historyService.appendManyToHistory(workspaceId, rows)).success).toBe(
      true
    );
  }
  return harness;
}

/** Legacy rows predate sequences; only a raw write can produce them. */
async function writeRawChat(harness: AgentSessionHarness, rows: string[]): Promise<void> {
  const sessionDir = path.join(harness.config.sessionsDir, workspaceId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, CHAT_FILE_NAME), rows.join("\n") + "\n");
}

function createClient(harness: AgentSessionHarness) {
  const context = {
    workspaceService: { getOrCreateSession: () => harness.session },
  } as unknown as ORPCContext;
  return createRouterClient(router(), { context });
}

async function collectReplay(
  client: ReturnType<typeof createClient>,
  input: { mode?: OnChatMode; replayWindow?: boolean }
): Promise<{ rows: WorkspaceChatMessage[]; caughtUp: CaughtUpMessage }> {
  const iterator = await client.workspace.onChat({ workspaceId, ...input });
  const rows: WorkspaceChatMessage[] = [];
  for await (const event of iterator) {
    if (event.type === "caught-up") {
      await iterator.return?.(undefined);
      return { rows, caughtUp: event };
    }
    if (event.type === "message") rows.push(event);
  }
  throw new Error("onChat ended before caught-up");
}

const ids = (rows: WorkspaceChatMessage[]) => rows.map((r) => ("id" in r ? r.id : r.type));
const bytes = (rows: WorkspaceChatMessage[]) => rows.map((r) => JSON.stringify(r));

describe("onChat windowed full replay (#4961)", () => {
  let harness: AgentSessionHarness | undefined;
  afterEach(async () => {
    mock.restore();
    await harness?.session.dispose();
    await harness?.cleanup();
    harness = undefined;
  });

  test("only an opted-in subscriber gets the window, also when both replay concurrently", async () => {
    const rows = Array.from({ length: EPOCH_ROWS }, (_, i) =>
      row(i, i % 2 === 0 ? "user" : "assistant")
    );
    harness = await createHarness(rows);
    const client = createClient(harness);
    const alone = await collectReplay(client, {});
    expect(alone.rows.length).toBe(EPOCH_ROWS);

    const [opted, plain] = await Promise.all([
      collectReplay(client, { replayWindow: true }),
      collectReplay(client, {}),
    ]);
    // The subscriber that did not opt in keeps today's bytes and caught-up.
    expect(bytes(plain.rows)).toEqual(bytes(alone.rows));
    expect(plain.caughtUp).toEqual(alone.caughtUp);

    // The window is the reader's window: the full replay's tail from a clean turn start.
    const window = await harness.historyService.getHistoryWindowFromLatestBoundary(workspaceId, {
      maxRows: ONCHAT_REPLAY_WINDOW_MAX_ROWS,
      maxBytes: ONCHAT_REPLAY_WINDOW_MAX_BYTES,
    });
    if (!window.success || window.data.kind !== "window") throw new Error("expected a window");
    expect(ids(opted.rows)).toEqual(window.data.messages.map((m) => m.id));
    expect(bytes(opted.rows)).toEqual(bytes(alone.rows.slice(-opted.rows.length)));
    expect(opted.rows.length).toBeLessThanOrEqual(ONCHAT_REPLAY_WINDOW_MAX_ROWS);
    // m100 starts the budget but its predecessor is outside it, so the window starts at m102.
    expect(ids(opted.rows)[0]).toBe("m102");
    expect(opted.caughtUp.replay).toBe("full");
    expect(opted.caughtUp.hasOlderHistory).toBe(true);
    expect(opted.caughtUp.cursor?.history?.oldestHistorySequence).toBe(102);
    expect(plain.caughtUp.hasOlderHistory).toBe(false);
  });

  test("a since reconnect with a windowed cursor replays just the delta", async () => {
    const rows = Array.from({ length: EPOCH_ROWS }, (_, i) =>
      row(i, i % 2 === 0 ? "user" : "assistant")
    );
    harness = await createHarness(rows);
    const client = createClient(harness);
    const windowed = await collectReplay(client, { replayWindow: true });
    const cursor = windowed.caughtUp.cursor?.history;
    if (!cursor) throw new Error("windowed replay must return a history cursor");

    const appended = {
      id: "after-cursor",
      role: "user",
      parts: [{ type: "text", text: "next" }],
      metadata: { timestamp: 9_000 },
    } as unknown as MuxMessage;
    expect((await harness.historyService.appendToHistory(workspaceId, appended)).success).toBe(
      true
    );
    const since = await collectReplay(client, {
      replayWindow: true,
      mode: { type: "since", cursor: { history: cursor } },
    });
    expect(since.caughtUp.replay).toBe("since");
    expect(since.caughtUp.downgradeReason).toBeUndefined();
    expect(ids(since.rows)).toEqual([cursor.messageId, appended.id]);
    // The new cursor still covers the window, so the next reconnect resumes the same way.
    expect(since.caughtUp.cursor?.history?.oldestHistorySequence).toBe(102);

    // The same windowed cursor from a client that did not opt in is checked against the whole
    // epoch, as today, and downgrades.
    const plain = await collectReplay(client, {
      mode: { type: "since", cursor: { history: cursor } },
    });
    expect(plain.caughtUp.replay).toBe("full");
    expect(plain.caughtUp.downgradeReason).toBe("oldest-mismatch");
    expect(plain.rows.length).toBe(EPOCH_ROWS + 1);
  });

  test("a window whose older rows cannot be paged falls back to the full replay", async () => {
    harness = await createHarness([]);
    // Legacy rows without sequences: no floor with older rows below it can be established.
    const legacy = Array.from({ length: EPOCH_ROWS }, (_, i) =>
      JSON.stringify({
        id: `legacy${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `legacy ${i}` }],
      })
    );
    await writeRawChat(harness, legacy);
    const replay = await collectReplay(createClient(harness), { replayWindow: true });
    expect(replay.rows.length).toBe(EPOCH_ROWS);
    expect(ids(replay.rows)[0]).toBe("legacy0");
  });

  test("a downgraded since and a turn longer than the window fall back to the full replay", async () => {
    // One prompt, then a turn longer than the window: no clean turn start fits.
    const rows = [
      row(0, "user"),
      ...Array.from({ length: EPOCH_ROWS }, (_, i) => row(i + 1, "assistant")),
    ];
    harness = await createHarness(rows);
    const client = createClient(harness);
    const fallback = await collectReplay(client, { replayWindow: true });
    expect(fallback.rows.length).toBe(EPOCH_ROWS + 1);
    expect(fallback.caughtUp.hasOlderHistory).toBe(false);

    // A cursor whose rows changed while disconnected downgrades to the whole epoch.
    const cursor = fallback.caughtUp.cursor?.history;
    if (!cursor) throw new Error("full replay must return a history cursor");
    const stale = { ...cursor, priorHistoryFingerprint: "stale" };
    const since = await collectReplay(client, {
      replayWindow: true,
      mode: { type: "since", cursor: { history: stale } },
    });
    expect(since.caughtUp.replay).toBe("full");
    expect(since.caughtUp.downgradeReason).toBe("fingerprint-mismatch");
    expect(since.rows.length).toBe(EPOCH_ROWS + 1);
  });
});

describe("onChat windowed since (#4961)", () => {
  let harness: AgentSessionHarness | undefined;
  afterEach(async () => {
    mock.restore();
    await harness?.session.dispose();
    await harness?.cleanup();
    harness = undefined;
  });

  const alternating = (count: number, first = 0) =>
    Array.from({ length: count }, (_, i) =>
      row(first + i, (first + i) % 2 === 0 ? "user" : "assistant")
    );

  /** A windowed replay's cursor, then a spy on the full-epoch read no windowed since may use. */
  async function windowedCursor(rows: MuxMessage[]) {
    harness = await createHarness(rows);
    const client = createClient(harness);
    const windowed = await collectReplay(client, { replayWindow: true });
    const cursor = windowed.caughtUp.cursor?.history;
    if (!cursor) throw new Error("windowed replay must return a history cursor");
    const fullReads = spyOn(harness.historyService, "getHistoryFromLatestBoundary");
    const since = (history = cursor) =>
      collectReplay(client, { replayWindow: true, mode: { type: "since", cursor: { history } } });
    return { harness, client, cursor, fullReads, since };
  }

  /** A downgrade is a fresh window (the reader's current window), never a full-epoch read. */
  async function expectWindowDowngrade(
    h: AgentSessionHarness,
    replay: { rows: WorkspaceChatMessage[]; caughtUp: CaughtUpMessage },
    reason: OnChatDowngradeReason,
    fullReads: ReturnType<typeof spyOn>
  ) {
    expect(replay.caughtUp.replay).toBe("full");
    expect(replay.caughtUp.downgradeReason).toBe(reason);
    const window = await h.historyService.getHistoryWindowFromLatestBoundary(workspaceId, {
      maxRows: ONCHAT_REPLAY_WINDOW_MAX_ROWS,
      maxBytes: ONCHAT_REPLAY_WINDOW_MAX_BYTES,
    });
    if (!window.success || window.data.kind !== "window") throw new Error("expected a window");
    expect(ids(replay.rows)).toEqual(window.data.messages.map((m) => m.id));
    expect(fullReads).not.toHaveBeenCalled();
  }

  test("1 and 500 new rows resume with the delta, without a full-epoch read", async () => {
    const { harness: h, cursor, fullReads, since } = await windowedCursor(alternating(EPOCH_ROWS));
    const one = row(EPOCH_ROWS, "user");
    expect((await h.historyService.appendToHistory(workspaceId, one)).success).toBe(true);
    const first = await since();
    expect(first.caughtUp.replay).toBe("since");
    expect(ids(first.rows)).toEqual([cursor.messageId, one.id]);

    const next = first.caughtUp.cursor?.history;
    if (!next) throw new Error("since replay must return a history cursor");
    const delta = alternating(500, EPOCH_ROWS + 1);
    expect((await h.historyService.appendManyToHistory(workspaceId, delta)).success).toBe(true);
    const second = await since(next);
    expect(second.caughtUp.replay).toBe("since");
    expect(ids(second.rows)).toEqual([one.id, ...delta.map((m) => m.id)]);
    expect(second.caughtUp.cursor?.history?.oldestHistorySequence).toBe(102);
    expect(fullReads).not.toHaveBeenCalled();
  });

  test("an edit in the client's range downgrades to a window", async () => {
    const { harness: h, fullReads, since } = await windowedCursor(alternating(EPOCH_ROWS));
    const original = row(500, "user");
    const edited = createMuxMessage(original.id, "user", "edited", {
      ...original.metadata,
      historySequence: 500,
    });
    expect((await h.historyService.updateHistory(workspaceId, edited)).success).toBe(true);
    await expectWindowDowngrade(h, await since(), "fingerprint-mismatch", fullReads);
  });

  test("a delete in the client's range downgrades to a window", async () => {
    const { harness: h, fullReads, since } = await windowedCursor(alternating(EPOCH_ROWS));
    expect((await h.historyService.deleteMessage(workspaceId, "m600")).success).toBe(true);
    await expectWindowDowngrade(h, await since(), "fingerprint-mismatch", fullReads);
  });

  test("a cursor row that is gone downgrades to a window", async () => {
    const { harness: h, cursor, fullReads, since } = await windowedCursor(alternating(EPOCH_ROWS));
    const gone = { ...cursor, messageId: "not-a-row" };
    await expectWindowDowngrade(h, await since(gone), "cursor-row-missing", fullReads);
  });

  test("a floor row that is gone downgrades to a window", async () => {
    const { harness: h, fullReads, since } = await windowedCursor(alternating(EPOCH_ROWS));
    expect((await h.historyService.deleteMessage(workspaceId, "m102")).success).toBe(true);
    await expectWindowDowngrade(h, await since(), "outside-window", fullReads);
  });

  test("a compaction since the anchor downgrades to a window", async () => {
    const { harness: h, fullReads, since } = await windowedCursor(alternating(EPOCH_ROWS));
    const boundary = createMuxMessage("boundary", "assistant", "summary", {
      compactionBoundary: true,
      compacted: "user",
      compactionEpoch: 1,
    });
    expect((await h.historyService.appendToHistory(workspaceId, boundary)).success).toBe(true);
    const compacted = await since();
    await expectWindowDowngrade(h, compacted, "outside-window", fullReads);
    expect(ids(compacted.rows)).toEqual(["boundary"]);
  });

  test("a delta larger than the window downgrades to a window", async () => {
    const { harness: h, fullReads, since } = await windowedCursor(alternating(EPOCH_ROWS));
    const delta = alternating(ONCHAT_REPLAY_WINDOW_MAX_ROWS + 1, EPOCH_ROWS);
    expect((await h.historyService.appendManyToHistory(workspaceId, delta)).success).toBe(true);
    await expectWindowDowngrade(h, await since(), "outside-window", fullReads);
  });

  test("a duplicated anchor sequence downgrades to a window", async () => {
    harness = await createHarness([]);
    // Only a raw write can repeat a sequence.
    const raw = alternating(10).map((m, i) =>
      JSON.stringify({ ...m, metadata: { ...m.metadata, historySequence: i } })
    );
    await writeRawChat(harness, raw);
    const client = createClient(harness);
    const windowed = await collectReplay(client, { replayWindow: true });
    const cursor = windowed.caughtUp.cursor?.history;
    if (!cursor) throw new Error("windowed replay must return a history cursor");
    const copy = JSON.stringify({
      ...row(9, "assistant"),
      id: "copy9",
      metadata: { historySequence: 9 },
    });
    await writeRawChat(harness, [...raw, copy]);
    const fullReads = spyOn(harness.historyService, "getHistoryFromLatestBoundary");
    const since = await collectReplay(client, {
      replayWindow: true,
      mode: { type: "since", cursor: { history: cursor } },
    });
    await expectWindowDowngrade(harness, since, "outside-window", fullReads);
  });

  test("only an opted-in since reads the range, also when both reconnect concurrently", async () => {
    harness = await createHarness(alternating(EPOCH_ROWS));
    const client = createClient(harness);
    const windowed = (await collectReplay(client, { replayWindow: true })).caughtUp.cursor?.history;
    const whole = (await collectReplay(client, {})).caughtUp.cursor?.history;
    if (!windowed || !whole) throw new Error("replays must return history cursors");
    const appended = row(EPOCH_ROWS, "user");
    expect((await harness.historyService.appendToHistory(workspaceId, appended)).success).toBe(
      true
    );
    const plainSince = { mode: { type: "since" as const, cursor: { history: whole } } };
    const alone = await collectReplay(client, plainSince);
    expect(alone.caughtUp.replay).toBe("since");

    const [opted, plain] = await Promise.all([
      collectReplay(client, {
        replayWindow: true,
        mode: { type: "since", cursor: { history: windowed } },
      }),
      collectReplay(client, plainSince),
    ]);
    // The subscriber that did not opt in keeps today's bytes and caught-up.
    expect(bytes(plain.rows)).toEqual(bytes(alone.rows));
    expect(plain.caughtUp).toEqual(alone.caughtUp);
    expect(plain.caughtUp.cursor?.history?.oldestHistorySequence).toBe(0);
    expect(opted.caughtUp.replay).toBe("since");
    expect(ids(opted.rows)).toEqual([windowed.messageId, appended.id]);
    expect(opted.caughtUp.cursor?.history?.oldestHistorySequence).toBe(102);
  });
});
