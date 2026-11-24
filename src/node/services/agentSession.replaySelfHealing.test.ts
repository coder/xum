/**
 * onChat replay self-healing: a persisted row that fails the wire schema must be
 * skipped (rest of the transcript intact, caught-up still delivered) instead of
 * killing the subscription. oRPC output-validates every yielded event, so before
 * this guard one corrupt chat.jsonl row terminated the iterator and permanently
 * bricked workspace fetch in server mode.
 */
import { describe, expect, it, mock, afterEach } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHAT_FILE_NAME } from "@/common/constants/paths";
import type { MuxMessage } from "@/common/types/message";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import {
  isMuxMessage,
  type CaughtUpMessage,
  type OnChatMode,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import { createAgentSessionHarness } from "./agentSession.testHarness";

async function createReplayHarness(workspaceId: string) {
  return await createAgentSessionHarness({
    workspaceId,
    aiServiceOverrides: {
      getStreamInfo: mock((_workspaceId: string) => undefined),
      replayStream: mock((_workspaceId: string, _opts?: { afterTimestamp?: number }) =>
        Promise.resolve()
      ),
    },
    initStateManagerOverrides: { replayInit: mock((_workspaceId: string) => Promise.resolve()) },
  });
}

function textMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  timestamp: number
): MuxMessage {
  return { id, role, parts: [{ type: "text", text, timestamp }], metadata: { timestamp } };
}

async function replayAll(
  session: Awaited<ReturnType<typeof createReplayHarness>>["session"],
  mode: OnChatMode = { type: "full" }
): Promise<WorkspaceChatMessage[]> {
  const events: WorkspaceChatMessage[] = [];
  await session.replayHistory(({ message }: { message: WorkspaceChatMessage }) => {
    events.push(message);
  }, mode);
  return events;
}

describe("onChat replay self-healing", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });

  it("skips a persisted row that fails the wire schema instead of failing replay", async () => {
    const workspaceId = "ws-replay-self-healing";
    const harness = await createReplayHarness(workspaceId);
    cleanup = harness.cleanup;
    const { session, historyService } = harness;

    expect(
      (
        await historyService.appendToHistory(
          workspaceId,
          textMessage("user-1", "user", "hi", 1_000)
        )
      ).success
    ).toBe(true);

    // Recorder-bug shape: an output-available tool part whose output key was
    // dropped by JSON serialization (output: undefined). Fails the wire schema.
    const corrupt = {
      id: "assistant-corrupt",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          input: { script: "true" },
          state: "output-available",
        },
      ],
      metadata: { timestamp: 2_000 },
    } as unknown as MuxMessage;
    expect((await historyService.appendToHistory(workspaceId, corrupt)).success).toBe(true);

    expect(
      (
        await historyService.appendToHistory(
          workspaceId,
          textMessage("assistant-2", "assistant", "done", 3_000)
        )
      ).success
    ).toBe(true);

    const events = await replayAll(session);

    // The corrupt row is skipped; every other row still replays in order.
    expect(events.filter(isMuxMessage).map((row) => row.id)).toEqual(["user-1", "assistant-2"]);
    // caught-up still arrives so the client leaves its loading state.
    expect(events.some((event) => "type" in event && event.type === "caught-up")).toBe(true);
    // The invariant the guard protects: every replayed event survives the oRPC
    // output validation that killed the subscription before.
    for (const event of events) {
      expect(WorkspaceChatMessageSchema.safeParse(event).success).toBe(true);
    }
  });

  it.each([
    ["oldest", [0]],
    ["middle", [1]],
    ["newest", [2]],
    ["all", [0, 1, 2]],
  ] as const)(
    "recovers replay and pagination with %s string sequences",
    async (_position, corruptIndices) => {
      const workspaceId = "ws-replay-string-sequence";
      const {
        session,
        historyService,
        config,
        cleanup: disposeHistory,
      } = await createReplayHarness(workspaceId);
      cleanup = async () => {
        await session.dispose();
        await disposeHistory();
      };
      const rows = [0, 1, 2].map((index) => ({
        ...textMessage(`row-${index}`, "user", `message ${index}`, 1_000 + index),
        metadata: { timestamp: 1_000 + index, historySequence: 7 + index },
      }));
      for (const row of rows) {
        expect(await historyService.appendToHistory(workspaceId, row)).toEqual({
          success: true,
          data: undefined,
        });
      }

      // Bypass the writer's assertion to reproduce already-corrupt disk data, not
      // a supported write. Replay must neither coerce it nor rewrite the raw log.
      const corrupt = new Set<number>(corruptIndices);
      const raw =
        rows
          .map((row, index) =>
            JSON.stringify({
              ...row,
              metadata: {
                ...row.metadata,
                historySequence: corrupt.has(index)
                  ? String(row.metadata.historySequence)
                  : row.metadata.historySequence,
              },
            })
          )
          .join("\n") + "\n";
      const historyPath = path.join(config.sessionsDir, workspaceId, CHAT_FILE_NAME);
      await writeFile(historyPath, raw);

      const events = await replayAll(session);
      const healthy = rows.filter((_row, index) => !corrupt.has(index));
      expect(events.filter(isMuxMessage).map((row) => row.id)).toEqual(
        healthy.map((row) => row.id)
      );
      const caughtUp = events.find((event): event is CaughtUpMessage => event.type === "caught-up");
      expect(caughtUp?.historyReplayStatus).toBe("complete");
      expect(caughtUp?.hasOlderHistory).toBe(false);
      expect(caughtUp?.cursor?.history?.historySequence).toBe(
        healthy.at(-1)?.metadata.historySequence
      );
      expect(caughtUp?.cursor?.history?.oldestHistorySequence).toBe(
        healthy[0]?.metadata.historySequence
      );
      for (const event of events) {
        expect(WorkspaceChatMessageSchema.safeParse(event).success).toBe(true);
      }
      expect(await readFile(historyPath, "utf8")).toBe(raw);

      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            textMessage("next", "assistant", "next turn", 2_000)
          )
        ).success
      ).toBe(true);
      const cursor = caughtUp?.cursor?.history;
      const resumed = await replayAll(
        session,
        cursor ? { type: "since", cursor: { history: cursor } } : { type: "full" }
      );
      expect(resumed.filter(isMuxMessage).map((row) => row.id)).toEqual(
        cursor ? [cursor.messageId, "next"] : ["next"]
      );
      const resumedCaughtUp = resumed.find(
        (event): event is CaughtUpMessage => event.type === "caught-up"
      );
      expect(resumedCaughtUp?.historyReplayStatus).toBe("complete");
      expect(resumedCaughtUp?.replay).toBe(cursor ? "since" : "full");
      expect(resumedCaughtUp?.cursor?.history?.historySequence).toBe(10);
      for (const event of resumed) {
        expect(WorkspaceChatMessageSchema.safeParse(event).success).toBe(true);
      }

      // A valid replay cursor can page backwards past the corrupt rows and reach
      // the end, rather than handing the pagination API a string cursor forever.
      const page = await historyService.getHistoryBoundaryWindow(workspaceId, 10);
      expect(page.success).toBe(true);
      if (!page.success) throw new Error(page.error);
      expect(page.data.messages.map((row) => row.id)).toEqual(healthy.map((row) => row.id));
      expect(page.data.hasOlder).toBe(false);
      if (healthy.length > 0) {
        const end = await historyService.getHistoryBoundaryWindow(
          workspaceId,
          healthy[0].metadata.historySequence
        );
        expect(end).toEqual({ success: true, data: { messages: [], hasOlder: false } });
      }
    }
  );

  it("replays rows whose nested kernel calls were persisted without input", async () => {
    // Regression for real-world data: zero-arg kernel capability calls
    // (mux.tool()) persisted nestedCalls entries without an input key. Such
    // rows must replay (not be skipped) so the transcript stays complete.
    const workspaceId = "ws-replay-nested-no-input";
    const harness = await createReplayHarness(workspaceId);
    cleanup = harness.cleanup;
    const { session, historyService } = harness;

    const legacyRow = {
      id: "assistant-nested",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "parent-1",
          toolName: "code_execution",
          input: { code: "mux.linear_get_issue_status()" },
          state: "output-available",
          output: { result: "ok" },
          nestedCalls: [
            {
              toolCallId: "nested-1",
              toolName: "linear_get_issue_status",
              state: "output-available",
              output: { error: "missing args" },
              timestamp: 1_500,
            },
          ],
        },
      ],
      metadata: { timestamp: 1_000 },
    } as unknown as MuxMessage;
    expect((await historyService.appendToHistory(workspaceId, legacyRow)).success).toBe(true);

    const events = await replayAll(session);

    expect(events.filter(isMuxMessage).map((row) => row.id)).toEqual(["assistant-nested"]);
    for (const event of events) {
      expect(WorkspaceChatMessageSchema.safeParse(event).success).toBe(true);
    }
  });
});
