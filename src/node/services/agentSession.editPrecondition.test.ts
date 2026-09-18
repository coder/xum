/**
 * Content-verified edit precondition: an edit carries evidence of exactly the range it deletes
 * (truncation target through the newest committed row) as the client held it; the history
 * service verifies it under the write lock and refuses with `history-changed` on any drift,
 * without writing anything.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "fs/promises";
import path from "path";

import * as schemas from "@/common/orpc/schemas";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import {
  isMuxMessage,
  type HistoryEditPrecondition,
  type SendMessageOptions,
  type WorkspaceChatMessage,
} from "@/common/orpc/types";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { buildHistoryEditPrecondition } from "@/common/utils/history/editTruncation";

import {
  createAgentSessionHarness,
  createStartedTurnHandle,
  type AgentSessionHarness,
} from "./agentSession.testHarness";
import { HISTORY_EDIT_PRECONDITION_MISMATCH } from "./historyService";

const workspaceId = "ws-edit-precondition";

async function waitForCondition(condition: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}
const model = "anthropic:claude-test";
const baseOptions: SendMessageOptions = { model, agentId: "exec" };

describe("AgentSession edit precondition", () => {
  let harness: AgentSessionHarness | undefined;
  afterEach(async () => {
    await harness?.session.dispose();
    await harness?.cleanup();
    harness = undefined;
    mock.restore();
  });

  async function setup(streamMessage?: AgentSessionHarness["aiService"]["streamMessage"]) {
    const h = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: streamMessage ? { streamMessage } : undefined,
      captureEvents: true,
    });
    harness = h;
    return h;
  }

  async function seed(h: AgentSessionHarness, rows: MuxMessage[]): Promise<MuxMessage[]> {
    const appended = await h.historyService.appendManyToHistory(workspaceId, rows);
    expect(appended.success).toBe(true);
    return persisted(h);
  }

  async function persisted(h: AgentSessionHarness): Promise<MuxMessage[]> {
    const result = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!result.success) throw new Error(result.error);
    return result.data;
  }

  /**
   * What a client holds: rows as delivered over oRPC, i.e. after the wire schema stripped keys
   * it does not know (persisted text parts carry `state: "done"`, wire parts do not).
   */
  function wire(rows: readonly MuxMessage[]): MuxMessage[] {
    return rows.map((row) => MuxMessageSchema.parse(row) as MuxMessage);
  }

  function fence(rows: readonly MuxMessage[], editMessageId: string): HistoryEditPrecondition {
    const precondition = buildHistoryEditPrecondition(wire(rows), editMessageId);
    if (!precondition) throw new Error(`cannot fence ${editMessageId}`);
    return precondition;
  }

  const threeTurns = () => [
    createMuxMessage("u1", "user", "first question"),
    createMuxMessage("a1", "assistant", "first answer"),
    createMuxMessage("u2", "user", "second question"),
    createMuxMessage("a2", "assistant", "second answer"),
  ];

  async function chatFileBytes(h: AgentSessionHarness): Promise<Buffer> {
    return fs.readFile(path.join(h.config.sessionsDir, workspaceId, "chat.jsonl"));
  }

  it("(a,i) a matching precondition truncates the range and appends the edit", async () => {
    const h = await setup();
    const rows = await seed(h, threeTurns());
    expect(rows[0].metadata?.historySequence).toBe(0);
    const result = await h.session.sendMessage("second question, edited", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: fence(rows, "u2"),
    });
    expect(result).toEqual(Ok(undefined));
    await h.session.waitForIdle();
    const after = await persisted(h);
    expect(after.slice(0, 2).map((row) => row.id)).toEqual(["u1", "a1"]);
    expect(after.find((row) => row.id === "u2")).toBeUndefined();
    expect(after.find((row) => row.id === "a2")).toBeUndefined();
    expect(
      after.some((row) => row.parts.some((p) => p.type === "text" && p.text.includes("edited")))
    ).toBe(true);
  });

  it("(b) a row appended after the capture refuses the edit and leaves the file untouched", async () => {
    const h = await setup();
    const rows = await seed(h, threeTurns());
    const precondition = fence(rows, "u2");
    expect(
      (await h.historyService.appendToHistory(workspaceId, createMuxMessage("u3", "user", "late")))
        .success
    ).toBe(true);
    const before = await chatFileBytes(h);
    const result = await h.session.sendMessage("edited", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: precondition,
    });
    expect(result).toEqual({ success: false, error: { type: "history-changed" } });
    expect(await chatFileBytes(h)).toEqual(before);
  });

  it("(c) a same-id rewrite inside the range refuses the edit", async () => {
    const h = await setup();
    const rows = await seed(h, threeTurns());
    const precondition = fence(rows, "u2");
    const a2 = rows.find((row) => row.id === "a2")!;
    expect(
      (
        await h.historyService.updateHistory(workspaceId, {
          ...a2,
          parts: [{ type: "text", text: "second answer, rewritten" }],
        })
      ).success
    ).toBe(true);
    const result = await h.session.sendMessage("edited", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: precondition,
    });
    expect(result).toEqual({ success: false, error: { type: "history-changed" } });
    expect((await persisted(h)).map((row) => row.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("(d) a change to a row older than the truncation target is out of range and accepted", async () => {
    const h = await setup();
    const rows = await seed(h, threeTurns());
    const precondition = fence(rows, "u2");
    const a1 = rows.find((row) => row.id === "a1")!;
    expect(
      (
        await h.historyService.updateHistory(workspaceId, {
          ...a1,
          parts: [{ type: "text", text: "first answer, annotated" }],
        })
      ).success
    ).toBe(true);
    const result = await h.session.sendMessage("edited", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: precondition,
    });
    expect(result).toEqual(Ok(undefined));
  });

  it("(j) a client range missing a middle row is refused: completeness is verified server-side", async () => {
    const h = await setup();
    const rows = await seed(h, threeTurns());
    const complete = fence(rows, "u2");
    const gappy = fence(
      rows.filter((row) => row.id !== "a2").concat(rows.filter((row) => row.id === "a2")),
      "u2"
    );
    expect(gappy).toEqual(complete); // order does not matter, content does
    const missingMiddle = fence(
      rows.filter((row) => row.id !== "a2"),
      "u2"
    );
    expect(missingMiddle.rangeRowCount).toBe(1);
    const result = await h.session.sendMessage("edited", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: {
        ...missingMiddle,
        newestMessageId: "a2",
        newestHistorySequence: 3,
      },
    });
    expect(result).toEqual({ success: false, error: { type: "history-changed" } });
  });

  it("(e′) the range starts at the snapshot preceding the edited row on both sides", async () => {
    const h = await setup();
    const rows = await seed(h, [
      createMuxMessage("u1", "user", "first"),
      createMuxMessage("a1", "assistant", "answer"),
      createMuxMessage("snap", "user", "@file snapshot", {
        synthetic: true,
        fileAtMentionSnapshot: [],
      }),
      createMuxMessage("u2", "user", "second"),
      createMuxMessage("a2", "assistant", "answer 2"),
    ]);
    const precondition = fence(rows, "u2");
    expect(precondition.rangeStartMessageId).toBe("snap");
    // A client that starts the range at the edited row instead is refused.
    const wrongStart = fence(
      rows.filter((row) => row.id !== "snap"),
      "u2"
    );
    expect(wrongStart.rangeStartMessageId).toBe("u2");
    expect(
      await h.session.sendMessage("edited", {
        ...baseOptions,
        editMessageId: "u2",
        historyEditPrecondition: wrongStart,
      })
    ).toEqual({ success: false, error: { type: "history-changed" } });
    expect(
      await h.session.sendMessage("edited", {
        ...baseOptions,
        editMessageId: "u2",
        historyEditPrecondition: precondition,
      })
    ).toEqual(Ok(undefined));
    await h.session.waitForIdle();
    expect((await persisted(h)).some((row) => row.id === "snap")).toBe(false);
  });

  it("(e) a pre-boundary target is fenced over archive + active rows", async () => {
    const h = await setup();
    const sessionDir = path.join(h.config.sessionsDir, workspaceId);
    await fs.mkdir(sessionDir, { recursive: true });
    const archived = [
      createMuxMessage("u0", "user", "archived question", { historySequence: 0, timestamp: 1 }),
      createMuxMessage("a0", "assistant", "archived answer", { historySequence: 1, timestamp: 2 }),
    ];
    const active = [
      createMuxMessage("summary", "assistant", "Summary", {
        historySequence: 2,
        timestamp: 3,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createMuxMessage("u1", "user", "post-boundary question", {
        historySequence: 3,
        timestamp: 4,
      }),
    ];
    await fs.writeFile(
      path.join(sessionDir, "chat-archive.jsonl"),
      archived.map((row) => JSON.stringify(row)).join("\n") + "\n"
    );
    await fs.writeFile(
      path.join(sessionDir, "chat.jsonl"),
      active.map((row) => JSON.stringify(row)).join("\n") + "\n"
    );
    const full = [...archived, ...active];
    const precondition = fence(full, "u0");
    expect(precondition.rangeRowCount).toBe(4);
    // Evidence built from the active epoch alone (without the paged-in archive) is incomplete.
    const activeOnly = { ...fence(active, "u1"), editMessageId: "u0", rangeStartMessageId: "u0" };
    expect(
      await h.session.sendMessage("edited archived", {
        ...baseOptions,
        editMessageId: "u0",
        historyEditPrecondition: { ...activeOnly, rangeStartHistorySequence: 0 },
      })
    ).toEqual({ success: false, error: { type: "history-changed" } });
    expect(
      await h.session.sendMessage("edited archived", {
        ...baseOptions,
        editMessageId: "u0",
        historyEditPrecondition: precondition,
      })
    ).toEqual(Ok(undefined));
    await h.session.waitForIdle();
    const after = await persisted(h);
    expect(after.some((row) => row.id === "a0" || row.id === "u1")).toBe(false);
  });

  /**
   * A stream that stays in its preparing phase until aborted (the edit interrupts it) or
   * released. A released turn has no engine behind it, so its handle also retires with the
   * session (`closingSignal`) — a refused edit now leaves that turn running (see f3).
   */
  function preparingStream() {
    const resolvers: Array<() => void> = [];
    const streamMessage: AgentSessionHarness["aiService"]["streamMessage"] = (opts) =>
      new Promise((resolve) => {
        const resolveOk = () =>
          resolve(
            Ok(
              createStartedTurnHandle(
                AbortSignal.any([opts.abortSignal!, harness!.session.closingSignal])
              )
            )
          );
        if (opts.abortSignal?.aborted === true) return resolveOk();
        opts.abortSignal?.addEventListener("abort", resolveOk, { once: true });
        resolvers.push(resolveOk);
      });
    return { streamMessage, release: () => resolvers.forEach((resolve) => resolve()) };
  }

  it("(f1) an edit during a stream whose interruption leaves the range unchanged succeeds", async () => {
    const stream = preparingStream();
    const h = await setup(stream.streamMessage);
    await seed(h, threeTurns());
    const firstSend = h.session.sendMessage("third question", baseOptions);
    expect(await waitForCondition(() => h.session.isPreparingTurn())).toBe(true);
    // Captured after the in-flight turn's user row landed: the client sees u1..u3.
    const live = await persisted(h);
    expect(live.at(-1)?.role).toBe("user");
    const result = await h.session.sendMessage("edited during stream", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: fence(live, "u2"),
    });
    stream.release();
    await firstSend;
    expect(result).toEqual(Ok(undefined));
    const after = await persisted(h);
    expect(after.slice(0, 2).map((row) => row.id)).toEqual(["u1", "a1"]);
    expect(after.some((row) => row.id === "u2" || row.id === "a2")).toBe(false);
  });

  it("(f2) a row committed inside the range while a stream is active is refused, nothing torn", async () => {
    const stream = preparingStream();
    const h = await setup(stream.streamMessage);
    const rows = await seed(h, threeTurns());
    // Captured before the next turn committed its user row inside the fenced range.
    const precondition = fence(rows, "u2");
    const firstSend = h.session.sendMessage("third question", baseOptions);
    expect(await waitForCondition(() => h.session.isPreparingTurn())).toBe(true);
    // The refusal must leave the newer turn's context state alone too: `reset("edit")` aborts
    // its compactor and prefix-swap bookkeeping, so it may only run once the edit proceeds.
    const contextController = (
      h.session as unknown as { contextController: { reset: (reason: string) => void } }
    ).contextController;
    const reset = spyOn(contextController, "reset");
    const result = await h.session.sendMessage("edited during stream", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: precondition,
    });
    expect(reset).not.toHaveBeenCalled();
    reset.mockRestore();
    stream.release();
    await firstSend;
    expect(result).toEqual({ success: false, error: { type: "history-changed" } });
    const ids = (await persisted(h)).map((row) => row.id);
    expect(ids.slice(0, 4)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(ids).toHaveLength(5);
  });

  it("verifies against the committed partial of an interrupted turn, as the client saw it", async () => {
    const h = await setup();
    const rows = await seed(h, [
      createMuxMessage("u1", "user", "first"),
      createMuxMessage("a1", "assistant", "answer"),
      createMuxMessage("u2", "user", "second"),
      // Empty placeholder appended before streaming; the streamed text lives in partial.json.
      createMuxMessage("a2", "assistant", ""),
    ]);
    const placeholder = rows.find((row) => row.id === "a2")!;
    const partial = createMuxMessage("a2", "assistant", "streamed before the interrupt", {
      historySequence: placeholder.metadata?.historySequence,
      timestamp: placeholder.metadata?.timestamp,
      partial: true,
    });
    expect((await h.historyService.writePartial(workspaceId, partial)).success).toBe(true);
    // Replay hands the client the partial instead of the placeholder.
    const events: WorkspaceChatMessage[] = [];
    await h.session.replayHistory(({ message }) => {
      events.push(message);
    });
    const clientRows = events.filter(isMuxMessage);
    expect(clientRows.find((row) => row.id === "a2")?.parts).toEqual(partial.parts);
    const result = await h.session.sendMessage("second, edited", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: fence(clientRows, "u2"),
    });
    expect(result).toEqual(Ok(undefined));
    await h.session.waitForIdle();
    expect((await persisted(h)).some((row) => row.id === "a2")).toBe(false);
  });

  it("accepts an edit after a failed turn whose error partial holds no content", async () => {
    const h = await setup();
    const rows = await seed(h, [
      createMuxMessage("u1", "user", "first"),
      createMuxMessage("a1", "assistant", "answer"),
      createMuxMessage("u2", "user", "second"),
      createMuxMessage("a2", "assistant", ""),
    ]);
    const placeholder = rows.find((row) => row.id === "a2")!;
    // A pre-content failure (e.g. context_exceeded) leaves an error partial with no parts over
    // the empty placeholder. The client keeps the errored row; the fence must not commit the
    // partial first, which would delete the placeholder and move the newest row.
    const errorPartial = createMuxMessage("a2", "assistant", "", {
      historySequence: placeholder.metadata?.historySequence,
      timestamp: placeholder.metadata?.timestamp,
      partial: true,
      error: "Context length exceeded",
      errorType: "context_exceeded",
    });
    expect((await h.historyService.writePartial(workspaceId, errorPartial)).success).toBe(true);
    const events: WorkspaceChatMessage[] = [];
    await h.session.replayHistory(({ message }) => {
      events.push(message);
    });
    const clientRows = events.filter(isMuxMessage);
    expect(clientRows.at(-1)?.id).toBe("a2");
    const result = await h.session.sendMessage("second, edited", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: fence(clientRows, "u2"),
    });
    expect(result).toEqual(Ok(undefined));
    await h.session.waitForIdle();
    expect((await persisted(h)).some((row) => row.id === "a2")).toBe(false);
  });

  it("(g) unfencedEdit keeps today's behavior", async () => {
    const h = await setup();
    await seed(h, threeTurns());
    expect(
      await h.session.sendMessage("edited", {
        ...baseOptions,
        editMessageId: "u2",
        unfencedEdit: true,
      })
    ).toEqual(Ok(undefined));
  });

  it("(h) the RPC input requires exactly one fence for an edit", () => {
    const input = (options: Record<string, unknown>) =>
      schemas.workspace.sendMessage.input.safeParse({
        workspaceId,
        message: "edited",
        options: { ...baseOptions, ...options },
      }).success;
    expect(input({ editMessageId: "u2" })).toBe(false);
    expect(input({ editMessageId: "u2", unfencedEdit: true })).toBe(true);
    expect(
      input({
        editMessageId: "u2",
        historyEditPrecondition: {
          editMessageId: "u2",
          rangeStartMessageId: "u2",
          rangeStartHistorySequence: 0,
          newestMessageId: "a2",
          newestHistorySequence: 3,
          rangeRowCount: 2,
          rangeFingerprint: "abcd1234",
        },
      })
    ).toBe(true);
    expect(
      input({
        editMessageId: "u2",
        unfencedEdit: true,
        historyEditPrecondition: {
          editMessageId: "u2",
          rangeStartMessageId: "u2",
          rangeStartHistorySequence: 0,
          newestMessageId: "a2",
          newestHistorySequence: 3,
          rangeRowCount: 2,
          rangeFingerprint: "abcd1234",
        },
      })
    ).toBe(false);
    // Plain sends need no fence.
    expect(input({})).toBe(true);
  });

  it("(f3) a stale fence is refused BEFORE the active turn is interrupted, and its queue survives", async () => {
    const stream = preparingStream();
    const h = await setup(stream.streamMessage);
    const rows = await seed(h, threeTurns());
    // Captured before the next turn committed its user row inside the fenced range.
    const precondition = fence(rows, "u2");
    const firstSend = h.session.sendMessage("third question", baseOptions);
    expect(await waitForCondition(() => h.session.isPreparingTurn())).toBe(true);
    // A follow-up the user queued behind the active turn.
    h.session.queueMessage("queued follow-up", baseOptions);
    const result = await h.session.sendMessage("edited during stream", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: precondition,
    });
    expect(result).toEqual({ success: false, error: { type: "history-changed" } });
    // The newer turn the fence protects is still running: the refusal happened before the
    // interruption, and the queue was neither consumed nor returned to the input.
    expect(h.session.isPreparingTurn()).toBe(true);
    expect(h.events.some((event) => event.type === "restore-to-input")).toBe(false);
    stream.release();
    await firstSend;
    h.session.restoreQueueToInput();
    expect(
      h.events.filter((event) => event.type === "restore-to-input").map((event) => event.text)
    ).toEqual(["queued follow-up"]);
  });

  it("(f4) an accepted edit still returns the queue to the input, after the fence held", async () => {
    const stream = preparingStream();
    const h = await setup(stream.streamMessage);
    await seed(h, threeTurns());
    const firstSend = h.session.sendMessage("third question", baseOptions);
    expect(await waitForCondition(() => h.session.isPreparingTurn())).toBe(true);
    h.session.queueMessage("queued follow-up", baseOptions);
    const live = await persisted(h);
    const result = await h.session.sendMessage("edited during stream", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: fence(live, "u2"),
    });
    stream.release();
    await firstSend;
    expect(result).toEqual(Ok(undefined));
    expect(
      h.events.filter((event) => event.type === "restore-to-input").map((event) => event.text)
    ).toEqual(["queued follow-up"]);
  });

  it("a fenced edit whose target vanished is a conflict, not the missing-target leniency", async () => {
    const h = await setup();
    const rows = await seed(h, threeTurns());
    const precondition = fence(rows, "u2");
    // Another client truncated from u2 meanwhile: the edited row is gone.
    expect((await h.historyService.truncateAfterMessage(workspaceId, "u2")).success).toBe(true);
    const before = await chatFileBytes(h);
    const result = await h.session.sendMessage("edited", {
      ...baseOptions,
      editMessageId: "u2",
      historyEditPrecondition: precondition,
    });
    expect(result).toEqual({ success: false, error: { type: "history-changed" } });
    expect(await chatFileBytes(h)).toEqual(before);
  });

  it("a completed empty assistant row is settled: a client still holding the placeholder conflicts", async () => {
    const h = await setup();
    const rows = await seed(h, [
      createMuxMessage("u1", "user", "first"),
      createMuxMessage("a1", "assistant", "answer"),
      createMuxMessage("u2", "user", "second"),
      createMuxMessage("a2", "assistant", ""),
    ]);
    // The client captured its evidence while a2 was the pre-stream placeholder.
    const precondition = fence(rows, "u2");
    const placeholder = rows.find((row) => row.id === "a2")!;
    // The turn then finished without parts (refusal): stream end stamps completion metadata.
    const completed = createMuxMessage("a2", "assistant", "", {
      ...placeholder.metadata,
      finishReason: "content-filter",
      duration: 1_200,
      usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
    });
    expect((await h.historyService.updateHistory(workspaceId, completed)).success).toBe(true);
    expect(
      await h.session.sendMessage("second, edited", {
        ...baseOptions,
        editMessageId: "u2",
        historyEditPrecondition: precondition,
      })
    ).toEqual({ success: false, error: { type: "history-changed" } });
    // Evidence captured over the completed row matches it.
    expect(
      await h.session.sendMessage("second, edited", {
        ...baseOptions,
        editMessageId: "u2",
        historyEditPrecondition: fence(await persisted(h), "u2"),
      })
    ).toEqual(Ok(undefined));
  });

  it("verifies the client's range start against the rows replay delivers, not unparseable ones", async () => {
    const h = await setup();
    const sessionDir = path.join(h.config.sessionsDir, workspaceId);
    await fs.mkdir(sessionDir, { recursive: true });
    const readable = (id: string, role: "user" | "assistant", text: string, seq: number) =>
      createMuxMessage(id, role, text, { historySequence: seq, timestamp: seq + 1 });
    // A synthetic snapshot row directly before the edited message that the readable floor
    // admits (valid id/role/parts) but the wire schema rejects (non-numeric timestamp): replay
    // never delivers it, so the client cannot know the server's cut starts there.
    const malformedSnapshot = {
      id: "snap-bad",
      role: "user",
      parts: [{ type: "text", text: "notes.md contents" }],
      metadata: {
        historySequence: 2,
        timestamp: "corrupt",
        synthetic: true,
        fileAtMentionSnapshot: ["notes.md"],
      },
    };
    const persistedRows = [
      readable("u1", "user", "first", 0),
      readable("a1", "assistant", "answer", 1),
      malformedSnapshot,
      readable("u2", "user", "second", 3),
      readable("a2", "assistant", "second answer", 4),
    ];
    await fs.writeFile(
      path.join(sessionDir, "chat.jsonl"),
      persistedRows.map((row) => JSON.stringify(row)).join("\n") + "\n"
    );
    const events: WorkspaceChatMessage[] = [];
    await h.session.replayHistory(({ message }) => {
      events.push(message);
    });
    const clientRows = events.filter(isMuxMessage);
    expect(clientRows.map((row) => row.id)).toEqual(["u1", "a1", "u2", "a2"]);
    const precondition = fence(clientRows, "u2");
    // The client's range starts at u2 (it never saw the snapshot); the server's cut starts at
    // the snapshot. The fence accepts and the cut removes the snapshot with the edited turn.
    expect(precondition.rangeStartMessageId).toBe("u2");
    expect(
      await h.session.sendMessage("second, edited", {
        ...baseOptions,
        editMessageId: "u2",
        historyEditPrecondition: precondition,
      })
    ).toEqual(Ok(undefined));
    await h.session.waitForIdle();
    const after = await fs.readFile(path.join(sessionDir, "chat.jsonl"), "utf8");
    expect(after.includes("snap-bad")).toBe(false);
    expect(after.includes('"a2"')).toBe(false);
  });

  it("ignores a persisted row with a malformed sequence as evidence, like the client does", async () => {
    const h = await setup();
    const sessionDir = path.join(h.config.sessionsDir, workspaceId);
    await fs.mkdir(sessionDir, { recursive: true });
    const readable = (id: string, role: "user" | "assistant", text: string, seq: number) =>
      createMuxMessage(id, role, text, { historySequence: seq, timestamp: seq + 1 });
    // Wire-parseable (a number is a number) but not a valid sequence: the client drops it from
    // its evidence, so the server must not pick it as the newest row of the removed range.
    const persistedRows = [
      readable("u1", "user", "first", 0),
      readable("a1", "assistant", "answer", 1),
      readable("u2", "user", "second", 2),
      readable("a2", "assistant", "second answer", 3),
      readable("junk", "assistant", "fractional sequence", 3.5),
    ];
    await fs.writeFile(
      path.join(sessionDir, "chat.jsonl"),
      persistedRows.map((row) => JSON.stringify(row)).join("\n") + "\n"
    );
    const events: WorkspaceChatMessage[] = [];
    await h.session.replayHistory(({ message }) => {
      events.push(message);
    });
    const precondition = fence(events.filter(isMuxMessage), "u2");
    expect(precondition.newestMessageId).toBe("a2");
    expect(
      await h.session.sendMessage("second, edited", {
        ...baseOptions,
        editMessageId: "u2",
        historyEditPrecondition: precondition,
      })
    ).toEqual(Ok(undefined));
    await h.session.waitForIdle();
    const after = await fs.readFile(path.join(sessionDir, "chat.jsonl"), "utf8");
    expect(after.includes('"junk"')).toBe(false);
    expect(after.includes('"a2"')).toBe(false);
  });

  it("a malformed-sequence row between a snapshot and the edit separates them on both sides", async () => {
    const h = await setup();
    const sessionDir = path.join(h.config.sessionsDir, workspaceId);
    await fs.mkdir(sessionDir, { recursive: true });
    const readable = (id: string, role: "user" | "assistant", text: string, seq: number) =>
      createMuxMessage(id, role, text, { historySequence: seq, timestamp: seq + 1 });
    // The server's cut treats the fractional-sequence row as a barrier (the snapshot is not
    // adjacent to the edit); the client, which receives that row, must derive the same start —
    // it is a barrier for adjacency without being evidence.
    const persistedRows = [
      readable("u1", "user", "first", 0),
      readable("a1", "assistant", "answer", 1),
      createMuxMessage("snap", "user", "notes.md contents", {
        historySequence: 2,
        timestamp: 3,
        synthetic: true,
        fileAtMentionSnapshot: ["notes.md"],
      }),
      readable("junk", "assistant", "fractional sequence", 2.5),
      readable("u2", "user", "second", 3),
      readable("a2", "assistant", "second answer", 4),
    ];
    await fs.writeFile(
      path.join(sessionDir, "chat.jsonl"),
      persistedRows.map((row) => JSON.stringify(row)).join("\n") + "\n"
    );
    const events: WorkspaceChatMessage[] = [];
    await h.session.replayHistory(({ message }) => {
      events.push(message);
    });
    const precondition = fence(events.filter(isMuxMessage), "u2");
    expect(precondition.rangeStartMessageId).toBe("u2");
    expect(
      await h.session.sendMessage("second, edited", {
        ...baseOptions,
        editMessageId: "u2",
        historyEditPrecondition: precondition,
      })
    ).toEqual(Ok(undefined));
    await h.session.waitForIdle();
    const after = await fs.readFile(path.join(sessionDir, "chat.jsonl"), "utf8");
    // The cut starts at u2: the snapshot (and the junk row) stay, the edited turn is gone.
    expect(after.includes('"snap"')).toBe(true);
    expect(after.includes('"a2"')).toBe(false);
  });

  it("a failed partial retirement after the cut is logged, not reported as a failed truncation", async () => {
    const h = await setup();
    const rows = await seed(h, threeTurns());
    const a2 = rows.find((row) => row.id === "a2")!;
    const partial = createMuxMessage("a2", "assistant", "streamed", {
      historySequence: a2.metadata?.historySequence,
      partial: true,
    });
    expect((await h.historyService.writePartial(workspaceId, partial)).success).toBe(true);
    // Reading the partial for retirement fails after the truncated history was published.
    const readPartial = h.historyService.readPartial.bind(h.historyService);
    let failed = false;
    const reading = spyOn(h.historyService, "readPartial").mockImplementation(async (id) => {
      if (!failed) {
        failed = true;
        throw new Error("partial read failed");
      }
      return readPartial(id);
    });
    try {
      const result = await h.historyService.truncateAfterMessage(workspaceId, "u2", {
        precondition: fence(rows, "u2"),
      });
      expect(result.success).toBe(true);
      expect(failed).toBe(true);
      expect((await persisted(h)).map((row) => row.id)).toEqual(["u1", "a1"]);
    } finally {
      reading.mockRestore();
    }
  });

  it("verifies the precondition atomically with the truncation under the history lock", async () => {
    const h = await setup();
    const rows = await seed(h, threeTurns());
    const precondition = fence(rows, "u2");
    // An append racing the truncation is ordered by the write lock: it lands either before
    // (edit refused, append preserved) or after (edit applied, append preserved). Never torn.
    const append = h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("racer", "user", "racing append")
    );
    const edit = h.historyService.truncateAfterMessage(workspaceId, "u2", { precondition });
    const [appended, truncated] = await Promise.all([append, edit]);
    expect(appended.success).toBe(true);
    const after = await persisted(h);
    if (truncated.success) {
      expect(after.map((row) => row.id)).toEqual(["u1", "a1", "racer"]);
    } else {
      expect(truncated.error.startsWith(HISTORY_EDIT_PRECONDITION_MISMATCH)).toBe(true);
      expect(after.map((row) => row.id)).toEqual(["u1", "a1", "u2", "a2", "racer"]);
    }
  });
});
