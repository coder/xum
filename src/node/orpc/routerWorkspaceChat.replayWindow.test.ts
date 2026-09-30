/**
 * onChat windowed full replay (#4961), through the real oRPC procedure. A subscriber that sends
 * `replayWindow: true` receives only the newest rows of the active epoch on a full replay; every
 * other subscriber keeps today's bytes, even while an opted-in one replays concurrently. A since
 * reconnect with a windowed cursor resumes with just the delta, and a window read that finds no
 * clean turn start falls back to the full replay.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRouterClient } from "@orpc/server";
import { CHAT_FILE_NAME } from "@/common/constants/paths";
import type { CaughtUpMessage, OnChatMode, WorkspaceChatMessage } from "@/common/orpc/types";
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

    // A windowed cursor whose rows changed downgrades to the whole active epoch, as today.
    const stale = { ...cursor, priorHistoryFingerprint: "stale" };
    const downgraded = await collectReplay(client, {
      replayWindow: true,
      mode: { type: "since", cursor: { history: stale } },
    });
    expect(downgraded.caughtUp.downgradeReason).toBe("fingerprint-mismatch");
    expect(downgraded.rows.length).toBe(EPOCH_ROWS + 1);
    expect(downgraded.caughtUp.cursor?.history?.oldestHistorySequence).toBe(0);

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
