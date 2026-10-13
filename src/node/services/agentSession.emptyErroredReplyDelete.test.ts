import { describe, expect, test } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { HistoryService } from "./historyService";
import { createAgentSessionHarness } from "./agentSession.testHarness";

/** A reply that failed before any output: its empty row plus the errored partial. */
async function seedEmptyErroredReply(
  historyService: HistoryService,
  workspaceId: string
): Promise<number> {
  const user = createMuxMessage(`user-${workspaceId}`, "user", "hello");
  expect((await historyService.appendToHistory(workspaceId, user)).success).toBe(true);
  const placeholder: MuxMessage = {
    ...createMuxMessage(`reply-${workspaceId}`, "assistant", ""),
    parts: [],
  };
  expect((await historyService.appendToHistory(workspaceId, placeholder)).success).toBe(true);
  const historySequence = placeholder.metadata?.historySequence;
  if (historySequence === undefined) throw new Error("appendToHistory assigns a sequence");
  const errored: MuxMessage = {
    ...placeholder,
    metadata: { ...placeholder.metadata, partial: true, error: "boom", errorType: "api" },
  };
  expect((await historyService.writePartial(workspaceId, errored)).success).toBe(true);
  return historySequence;
}

describe("AgentSession: a deleted empty failed reply (#6116)", () => {
  test("disposing the session removes its HistoryService listener", async () => {
    const h = await createAgentSessionHarness({ workspaceId: "ws" });
    await using _cleanup = { [Symbol.asyncDispose]: h.cleanup };
    // The harness built one session on this HistoryService.
    expect(h.historyService.emptyErroredReplyDeletedListenerCount).toBe(1);
    await h.session.dispose();
    expect(h.historyService.emptyErroredReplyDeletedListenerCount).toBe(0);
  });

  test("tells its own clients to drop the row", async () => {
    const h = await createAgentSessionHarness({ workspaceId: "ws", captureEvents: true });
    await using _cleanup = { [Symbol.asyncDispose]: h.cleanup };
    await using _session = { [Symbol.asyncDispose]: () => h.session.dispose() };

    // Another workspace's delete is not this session's to publish.
    await seedEmptyErroredReply(h.historyService, "other-ws");
    expect((await h.historyService.commitPartial("other-ws")).success).toBe(true);
    expect(h.events.filter((event) => event.type === "delete")).toEqual([]);

    const sequence = await seedEmptyErroredReply(h.historyService, "ws");
    expect((await h.historyService.commitPartial("ws")).success).toBe(true);
    expect(h.events.filter((event) => event.type === "delete")).toEqual([
      { type: "delete", historySequences: [sequence] },
    ]);
    const history = await h.historyService.getHistoryFromLatestBoundary("ws");
    expect(history.success && history.data.map((row) => row.id)).toEqual(["user-ws"]);
  });
});
