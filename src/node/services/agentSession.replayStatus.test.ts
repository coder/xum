/**
 * caught-up must state whether the history it closes is authoritative. It is emitted from a
 * `finally` so the client never hangs, which is exactly why a failed read must not look like
 * a complete replay: the client's mutation barrier opens only on `complete`.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import {
  isCaughtUpMessage,
  isMuxMessage,
  isQueuedMessageChanged,
  type CaughtUpMessage,
  type OnChatMode,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import { Err } from "@/common/types/result";

import { createAgentSessionHarness, type AgentSessionHarness } from "./agentSession.testHarness";

const workspaceId = "ws-replay-status";

async function replay(
  h: AgentSessionHarness,
  mode?: OnChatMode
): Promise<{ events: WorkspaceChatMessage[]; caughtUp: CaughtUpMessage }> {
  const events: WorkspaceChatMessage[] = [];
  await h.session.replayHistory(({ message }) => {
    events.push(message);
  }, mode);
  const caughtUp = events.find(isCaughtUpMessage);
  if (!caughtUp) throw new Error("Expected caught-up");
  // caught-up closes the attempt: nothing may follow it.
  expect(events.at(-1)).toBe(caughtUp);
  return { events, caughtUp };
}

describe("replayHistory historyReplayStatus", () => {
  let harness: AgentSessionHarness | undefined;
  afterEach(async () => {
    await harness?.session.dispose();
    await harness?.cleanup();
    harness = undefined;
    mock.restore();
  });

  async function setup(seed = true): Promise<AgentSessionHarness> {
    const h = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: {
        getStreamInfo: mock(() => undefined),
        replayStream: mock(() => Promise.resolve()),
      },
      initStateManagerOverrides: { replayInit: mock(() => Promise.resolve()) },
    });
    harness = h;
    if (seed) {
      const appended = await h.historyService.appendManyToHistory(workspaceId, [
        createMuxMessage("u1", "user", "question"),
        createMuxMessage("a1", "assistant", "answer"),
      ]);
      expect(appended.success).toBe(true);
    }
    return h;
  }

  it("reports complete for a full replay with rows", async () => {
    const h = await setup();
    const { events, caughtUp } = await replay(h, { type: "full" });
    expect(caughtUp.historyReplayStatus).toBe("complete");
    expect(events.filter(isMuxMessage)).toHaveLength(2);
  });

  it("reports complete for an empty history", async () => {
    const h = await setup(false);
    const { events, caughtUp } = await replay(h);
    expect(caughtUp.historyReplayStatus).toBe("complete");
    expect(caughtUp.replay).toBe("full");
    expect(events.filter(isMuxMessage)).toHaveLength(0);
  });

  it("reports complete for a live replay, which reads no history", async () => {
    const h = await setup();
    const { events, caughtUp } = await replay(h, { type: "live" });
    expect(caughtUp.historyReplayStatus).toBe("complete");
    expect(caughtUp.replay).toBe("live");
    expect(events.filter(isMuxMessage)).toHaveLength(0);
  });

  it.each(["full", "since"] as const)(
    "reports failed when the history read errors (%s request): queue snapshot present, no history cursor",
    async (requested) => {
      const h = await setup();
      h.session.queueMessage("queued while broken");
      spyOn(h.historyService, "getHistoryFromLatestBoundary").mockResolvedValueOnce(Err("boom"));
      const mode: OnChatMode =
        requested === "since"
          ? { type: "since", cursor: { history: { messageId: "a1", historySequence: 1 } } }
          : { type: "full" };
      const { events, caughtUp } = await replay(h, mode);
      expect(caughtUp.historyReplayStatus).toBe("failed");
      expect(caughtUp.replay).toBe("full");
      expect(caughtUp.cursor?.history).toBeUndefined();
      if (requested === "since") expect(caughtUp.downgradeReason).toBe("history-read-failed");
      expect(events.filter(isMuxMessage)).toHaveLength(0);
      const queue = events.find(isQueuedMessageChanged);
      expect(queue?.hasQueuedMessages).toBe(true);
    }
  );

  it("reports failed when emission throws after rows were sent", async () => {
    const h = await setup();
    spyOn(h.initStateManager, "replayInit").mockImplementationOnce(() =>
      Promise.reject(new Error("init replay exploded"))
    );
    const { events, caughtUp } = await replay(h, { type: "full" });
    expect(caughtUp.historyReplayStatus).toBe("failed");
    expect(caughtUp.cursor).toBeUndefined();
    // Rows already emitted stay emitted; the status tells the client not to trust them.
    expect(events.filter(isMuxMessage)).toHaveLength(2);
  });
});
