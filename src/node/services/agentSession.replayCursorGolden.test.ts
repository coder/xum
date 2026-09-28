/**
 * Golden contract for the caught-up cursor emitted by replayHistory.
 *
 * The server cursor's `priorHistoryFingerprint` must always equal the pure fingerprint of
 * the persisted rows below the NEWEST row, and the emitted rows must be exactly the persisted
 * rows the mode selects — for full replays, unchanged since-replays (the switch-back case,
 * where the client anchor already is the newest row), since-replays with new rows, and every
 * downgrade reason. This pins the output while the replay reuses the client-anchor fingerprint
 * for the server cursor whenever both anchors coincide.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import { computePriorHistoryFingerprint } from "@/common/orpc/onChatCursorFingerprint";
import {
  isMuxMessage,
  type CaughtUpMessage,
  type OnChatMode,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Err } from "@/common/types/result";

import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "ws-replay-cursor-golden";

function digest(rows: readonly MuxMessage[]): string[] {
  return rows.map((row) =>
    JSON.stringify({ id: row.id, seq: row.metadata?.historySequence, parts: row.parts })
  );
}

async function replay(
  h: AgentSessionHarness,
  mode?: OnChatMode
): Promise<{ rows: MuxMessage[]; caughtUp: CaughtUpMessage }> {
  const events: WorkspaceChatMessage[] = [];
  await h.session.replayHistory(({ message }) => {
    events.push(message);
  }, mode);
  const caughtUp = events.find(
    (event): event is CaughtUpMessage => "type" in event && event.type === "caught-up"
  );
  if (!caughtUp) throw new Error("Expected caught-up");
  return { rows: events.filter(isMuxMessage), caughtUp };
}

async function persisted(h: AgentSessionHarness): Promise<MuxMessage[]> {
  const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
  if (!result.success) throw new Error(result.error);
  return result.data;
}

function seq(row: MuxMessage): number {
  const value = row.metadata?.historySequence;
  if (value === undefined) throw new Error(`row ${row.id} has no historySequence`);
  return value;
}

describe("replayHistory cursor golden", () => {
  let harness: AgentSessionHarness | undefined;
  afterEach(async () => {
    await harness?.session.dispose();
    await harness?.cleanup();
    harness = undefined;
    mock.restore();
  });

  async function setup(): Promise<{ h: AgentSessionHarness; rows: MuxMessage[] }> {
    const h = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: {
        getStreamInfo: mock(() => undefined),
        replayStream: mock(() => Promise.resolve()),
      },
      initStateManagerOverrides: { replayInit: mock(() => Promise.resolve()) },
    });
    harness = h;
    const appended = await h.historyService.appendManyToHistory(workspaceId, [
      createMuxMessage("u1", "user", "first question"),
      createMuxMessage("a1", "assistant", "first answer"),
      createMuxMessage("u2", "user", "second question"),
    ]);
    expect(appended.success).toBe(true);
    return { h, rows: await persisted(h) };
  }

  /** The expected server cursor for a given persisted history: anchored at the newest row. */
  function expectedCursor(rows: readonly MuxMessage[]) {
    const newest = rows[rows.length - 1];
    return {
      messageId: newest.id,
      historySequence: seq(newest),
      oldestHistorySequence: seq(rows[0]),
      priorHistoryFingerprint: computePriorHistoryFingerprint(rows, seq(newest)),
    };
  }

  it("full replay emits every row and the newest-anchored cursor", async () => {
    const { h, rows } = await setup();
    const result = await replay(h, { type: "full" });
    expect(result.caughtUp.replay).toBe("full");
    expect(digest(result.rows)).toEqual(digest(rows));
    expect(result.caughtUp.cursor?.history).toEqual(expectedCursor(rows));
  });

  it("unchanged since replay (anchor is the newest row) re-emits only the anchor", async () => {
    const { h, rows } = await setup();
    const cursor = expectedCursor(rows);
    const result = await replay(h, { type: "since", cursor: { history: cursor } });
    expect(result.caughtUp.replay).toBe("since");
    expect(result.caughtUp.downgradeReason).toBeUndefined();
    expect(digest(result.rows)).toEqual(digest(rows.slice(-1)));
    expect(result.caughtUp.cursor?.history).toEqual(cursor);
  });

  it("since replay with new rows emits the anchor plus newer rows and advances the cursor", async () => {
    const { h, rows } = await setup();
    const staleCursor = expectedCursor(rows);
    expect(
      (
        await h.historyService.appendManyToHistory(workspaceId, [
          createMuxMessage("a2", "assistant", "second answer"),
          createMuxMessage("u3", "user", "third question"),
        ])
      ).success
    ).toBe(true);
    const latest = await persisted(h);
    const result = await replay(h, { type: "since", cursor: { history: staleCursor } });
    expect(result.caughtUp.replay).toBe("since");
    expect(digest(result.rows)).toEqual(digest(latest.slice(-3)));
    // The server cursor is anchored at the NEWEST row, not at the client's older anchor: the
    // two fingerprints differ, so the second one must be computed independently.
    const cursor = expectedCursor(latest);
    expect(cursor.priorHistoryFingerprint).not.toBe(staleCursor.priorHistoryFingerprint);
    expect(result.caughtUp.cursor?.history).toEqual(cursor);
  });

  it.each([
    [
      "cursor-row-missing",
      (cursor: ReturnType<typeof expectedCursor>) => ({ ...cursor, messageId: "ghost" }),
    ],
    [
      "oldest-mismatch",
      (cursor: ReturnType<typeof expectedCursor>) => ({
        ...cursor,
        oldestHistorySequence: cursor.oldestHistorySequence - 1,
      }),
    ],
    [
      "fingerprint-mismatch",
      (cursor: ReturnType<typeof expectedCursor>) => ({
        ...cursor,
        priorHistoryFingerprint: "not-the-fingerprint",
      }),
    ],
  ] as const)(
    "downgrade %s falls back to a full replay with the golden cursor",
    async (reason, corrupt) => {
      const { h, rows } = await setup();
      const result = await replay(h, {
        type: "since",
        cursor: { history: corrupt(expectedCursor(rows)) },
      });
      expect(result.caughtUp.replay).toBe("full");
      expect(result.caughtUp.downgradeReason).toBe(reason);
      expect(digest(result.rows)).toEqual(digest(rows));
      expect(result.caughtUp.cursor?.history).toEqual(expectedCursor(rows));
    }
  );

  it("downgrade history-read-failed emits no rows and no history cursor", async () => {
    const { h, rows } = await setup();
    spyOn(h.historyService, "getHistoryFromLatestBoundary").mockResolvedValueOnce(Err("boom"));
    const result = await replay(h, {
      type: "since",
      cursor: { history: expectedCursor(rows) },
    });
    expect(result.caughtUp.replay).toBe("full");
    expect(result.caughtUp.downgradeReason).toBe("history-read-failed");
    expect(result.rows).toEqual([]);
    expect(result.caughtUp.cursor?.history).toBeUndefined();
  });
});
