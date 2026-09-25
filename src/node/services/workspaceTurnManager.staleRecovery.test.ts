import { StreamManager } from "./streamManager";
import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import type { HistoryService } from "@/node/services/historyService";
import {
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import {
  finalizeWorkspaceTurnStreamEndForTest,
  startWorkspaceTurnForTest,
} from "@/node/services/workspaceTurnManager.testHarness";
import { Ok, Err } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import assert from "node:assert";
import {
  workspaceTurnMuxMetadata,
  workspaceTurnRecord,
  workspaceTurnSnapshot,
} from "@/node/services/taskService.testHarness";

describe("WorkspaceTurnManager", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-taskService-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  function intermediateStopEvent(parentId: string): StreamEndEvent {
    const muxMetadata = workspaceTurnMuxMetadata(parentId);
    return {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "intermediate-stop",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        finishReason: "tool-calls",
        muxMetadata,
        stopCause: { kind: "queued-input", entryId: "continuation-entry", muxMetadata },
      },
      parts: [{ type: "text", text: "Work in progress" }],
    };
  }

  async function persistStopEvent(history: HistoryService, event: StreamEndEvent): Promise<void> {
    const result = await history.appendToHistory(event.workspaceId, {
      id: event.messageId,
      role: "assistant",
      metadata: event.metadata,
      parts: event.parts,
    });
    expect(result.success).toBe(true);
  }

  test("queue stop attribution survives queue removal before finalization and recovery", async () => {
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    const event = intermediateStopEvent(parentId);
    event.metadata.stopCause = { kind: "queued-input", entryId: "manual-entry" };
    await persistStopEvent(historyService, event);
    const store = new TaskHandleStore(config);
    const record = await store.getWorkspaceTurn(parentId, "wst_handle");
    assert(record);
    const internal = taskService as unknown as {
      recoverTerminalWorkspaceTurnFromHistory(
        record: WorkspaceTurnTaskHandleRecord
      ): Promise<WorkspaceTurnTaskHandleRecord | null>;
    };
    const recovered = await internal.recoverTerminalWorkspaceTurnFromHistory(record);
    expect(recovered?.status).toBe("interrupted");
    await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
    expect(await store.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "interrupted",
      error: recovered?.error,
    });
  });

  test.each([false, true])(
    "continuation starts and finishes during finalization await (legacy=%s)",
    async (legacy) => {
      const { config, parentId, taskService, historyService } =
        await startWorkspaceTurnForTest(rootDir);
      const event = intermediateStopEvent(parentId);
      if (legacy) delete event.metadata.stopCause;
      await persistStopEvent(historyService, event);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readHistory = historyService.getHistoryFromLatestBoundary.bind(historyService);
      spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return readHistory(...args);
        }
      );
      const finalizing = finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      await entered.promise;
      const successor: StreamEndEvent = {
        ...event,
        messageId: "finished-continuation",
        metadata: { ...event.metadata, finishReason: "stop", stopCause: undefined },
        parts: [{ type: "text", text: "Completed result" }],
      };
      await persistStopEvent(historyService, successor);
      release.resolve();
      await finalizing;
      expect(
        await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
      ).toMatchObject({
        status: "completed",
        messageId: successor.messageId,
        reportMarkdown: "Completed result",
      });
      const store = new TaskHandleStore(config);
      const completed = await store.getWorkspaceTurn(parentId, "wst_handle");
      await finalizeWorkspaceTurnStreamEndForTest(taskService, successor);
      expect(await store.getWorkspaceTurn(parentId, "wst_handle")).toEqual(completed);
    }
  );

  test.each([false, true])(
    "continuation arriving during history read keeps execution active (legacy=%s)",
    async (legacy) => {
      const pending = mock(() => false);
      const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest(
        rootDir,
        {
          hasPendingWorkspaceTurnContinuation: pending,
        }
      );
      const event = intermediateStopEvent(parentId);
      if (legacy) delete event.metadata.stopCause;
      await persistStopEvent(historyService, event);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readHistory = historyService.getHistoryFromLatestBoundary.bind(historyService);
      spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(
        async (...args) => {
          const snapshot = await readHistory(...args);
          entered.resolve();
          await release.promise;
          return snapshot;
        }
      );
      const finalizing = finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      await entered.promise;
      pending.mockReturnValue(true);
      release.resolve();
      await finalizing;
      expect(
        await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
      ).toMatchObject({
        status: "running",
        deferredMessageIds: [event.messageId],
      });
    }
  );

  test.each([false, true])(
    "settled repair honors explicit replacement cause (sameOwner=%s)",
    async (sameOwner) => {
      const { config, parentId, taskService, historyService } =
        await startWorkspaceTurnForTest(rootDir);
      const event = intermediateStopEvent(parentId);
      event.metadata.stopCause = {
        kind: "queued-input",
        entryId: "replacement-entry",
        ...(sameOwner ? { muxMetadata: workspaceTurnMuxMetadata(parentId, "wst_successor") } : {}),
      };
      await persistStopEvent(historyService, event);
      await new TaskHandleStore(config).upsertWorkspaceTurn(
        workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
          messageId: "earlier-error",
          error: "Earlier provider failure",
        })
      );
      const repaired = await workspaceTurnSnapshot(taskService, parentId);
      expect(repaired).toMatchObject({ status: "interrupted", messageId: event.messageId });
      if (sameOwner) expect(repaired?.error).toContain("wst_successor");
    }
  );

  test.each([false, true])(
    "recovery preserves pending same-execution continuation (legacy=%s)",
    async (legacy) => {
      const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest(
        rootDir,
        {
          hasPendingWorkspaceTurnContinuation: mock(() => true),
        }
      );
      const event = intermediateStopEvent(parentId);
      if (legacy) delete event.metadata.stopCause;
      await persistStopEvent(historyService, event);
      const store = new TaskHandleStore(config);
      const record = await store.getWorkspaceTurn(parentId, "wst_handle");
      assert(record);
      const internal = taskService as unknown as {
        recoverTerminalWorkspaceTurnFromHistory(
          record: WorkspaceTurnTaskHandleRecord
        ): Promise<WorkspaceTurnTaskHandleRecord | null>;
      };
      expect(await internal.recoverTerminalWorkspaceTurnFromHistory(record)).toBeNull();
      await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      expect(await store.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
        status: "running",
        deferredMessageIds: [event.messageId],
      });
    }
  );

  test.each(["interrupted", "error"] as const)(
    "continuation %s survives a late intermediate finalization",
    async (status) => {
      const { config, parentId, taskService, historyService } =
        await startWorkspaceTurnForTest(rootDir);
      const event = intermediateStopEvent(parentId);
      await persistStopEvent(historyService, event);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readHistory = historyService.getHistoryFromLatestBoundary.bind(historyService);
      spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return readHistory(...args);
        }
      );
      const finalizing = finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      await entered.promise;
      const error =
        status === "interrupted"
          ? "Continuation canceled by user"
          : "Continuation dispatch failed: runtime unavailable";
      await taskService.settleWorkspaceTurnContinuationFailure(
        event.workspaceId,
        workspaceTurnMuxMetadata(parentId),
        status,
        error
      );
      release.resolve();
      await finalizing;
      expect(
        await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
      ).toMatchObject({ status, error });
    }
  );

  test.each(["error", "interrupted"] as const)(
    "old replacement queue stop preserves newer %s during handle lookup",
    async (status) => {
      const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
      const event = intermediateStopEvent(parentId);
      event.metadata.stopCause = { kind: "queued-input", entryId: "replacement" };
      const store = (taskService as unknown as { taskHandleStore: TaskHandleStore })
        .taskHandleStore;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const readHandle = store.getWorkspaceTurn.bind(store);
      spyOn(store, "getWorkspaceTurn").mockImplementationOnce(async (...args) => {
        const snapshot = await readHandle(...args);
        entered.resolve();
        await release.promise;
        return snapshot;
      });
      const finalizing = finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      await entered.promise;
      const error = status === "error" ? "Continuation dispatch failed" : "Continuation canceled";
      await taskService.settleWorkspaceTurnContinuationFailure(
        event.workspaceId,
        workspaceTurnMuxMetadata(parentId),
        status,
        error
      );
      release.resolve();
      await finalizing;
      expect(
        await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
      ).toMatchObject({ status, error });
    }
  );

  test("old queue stop cannot replace a newer terminal message", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    const old = intermediateStopEvent(parentId);
    old.metadata.stopCause = { kind: "queued-input", entryId: "old-replacement" };
    old.metadata.historySequence = 10;
    const newer: StreamEndEvent = {
      ...old,
      messageId: "newer-failure",
      metadata: {
        ...old.metadata,
        stopCause: undefined,
        finishReason: "length",
        historySequence: 20,
      },
    };
    await finalizeWorkspaceTurnStreamEndForTest(taskService, newer);
    await finalizeWorkspaceTurnStreamEndForTest(taskService, old);
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "error",
      messageId: newer.messageId,
    });
  });

  test.each([false, true])(
    "required-tool completion repairs a transient failure (duringLookup=%s)",
    async (duringLookup) => {
      const { config, parentId, taskService, historyService } =
        await startWorkspaceTurnForTest(rootDir);
      const event = intermediateStopEvent(parentId);
      event.metadata.stopCause = { kind: "required-tool" };
      await persistStopEvent(historyService, event);
      const store = (taskService as unknown as { taskHandleStore: TaskHandleStore })
        .taskHandleStore;
      const fail = () =>
        taskService.settleWorkspaceTurnContinuationFailure(
          event.workspaceId,
          workspaceTurnMuxMetadata(parentId),
          "error",
          "Transient provider failure"
        );
      if (duringLookup) {
        const readHandle = store.getWorkspaceTurn.bind(store);
        spyOn(store, "getWorkspaceTurn").mockImplementationOnce(async (...args) => {
          const snapshot = await readHandle(...args);
          await fail();
          return snapshot;
        });
      } else {
        await fail();
      }
      await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      expect(
        await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
      ).toMatchObject({
        status: "completed",
        messageId: event.messageId,
      });
    }
  );

  test("stale recovery defers while a send is in pre-admission", async () => {
    const { config, parentId, taskService, historyService, workspaceMocks } =
      await startWorkspaceTurnForTest(rootDir);
    const event = intermediateStopEvent(parentId);
    await taskService.markWorkspaceTurnStreamEndDeferred(event);
    const record = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    assert(record);
    workspaceMocks.acquireIdleTurnExclusion.mockReturnValueOnce(Err("a send is being admitted"));
    const readHistory = spyOn(historyService, "getHistoryFromLatestBoundary");
    await (
      taskService as unknown as {
        settleStaleWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void>;
      }
    ).settleStaleWorkspaceTurn(record);
    expect(readHistory).not.toHaveBeenCalled();
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
    });
  });

  test("stale recovery waits for an in-flight stream start before reading history", async () => {
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    const streams = new StreamManager(historyService);
    Reflect.set(taskService, "streamManager", streams);
    const event = intermediateStopEvent(parentId);
    await taskService.markWorkspaceTurnStreamEndDeferred(event);
    const record = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    assert(record);
    const starting = await streams.acquireStreamStartLock(event.workspaceId);
    const entered = Promise.withResolvers<void>();
    const acquire = streams.acquireStreamStartLock.bind(streams);
    spyOn(streams, "acquireStreamStartLock").mockImplementationOnce((id) => {
      entered.resolve();
      return acquire(id);
    });
    const recovering = (
      taskService as unknown as {
        settleStaleWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void>;
      }
    ).settleStaleWorkspaceTurn(record);
    await entered.promise;
    const completed: StreamEndEvent = {
      ...event,
      messageId: "continuation-committed",
      metadata: { ...event.metadata, finishReason: "stop", stopCause: undefined },
    };
    await persistStopEvent(historyService, completed);
    await starting[Symbol.asyncDispose]();
    await recovering;
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "completed",
      messageId: completed.messageId,
    });
  });

  test("stale recovery blocks new starts through terminal persistence without blocking other workspaces", async () => {
    const { config, parentId, taskService, historyService, workspaceMocks } =
      await startWorkspaceTurnForTest(rootDir);
    let admissionHeld = false;
    workspaceMocks.acquireIdleTurnExclusion.mockImplementation(() => {
      admissionHeld = true;
      return Ok({
        [Symbol.dispose]: () => {
          admissionHeld = false;
        },
      });
    });
    const streams = new StreamManager(historyService);
    Reflect.set(taskService, "streamManager", streams);
    const event = intermediateStopEvent(parentId);
    event.metadata.finishReason = "stop";
    delete event.metadata.stopCause;
    await taskService.markWorkspaceTurnStreamEndDeferred(event);
    await persistStopEvent(historyService, event);
    const store = (taskService as unknown as { taskHandleStore: TaskHandleStore }).taskHandleStore;
    const record = await store.getWorkspaceTurn(parentId, "wst_handle");
    assert(record);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanup = spyOn(
      taskService as unknown as {
        cleanupDisposableWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void>;
      },
      "cleanupDisposableWorkspaceTurn"
    ).mockImplementation(async () => {
      expect(admissionHeld).toBe(false);
      await using _cleanupStart = await streams.acquireStreamStartLock(event.workspaceId);
    });
    const persist = store.upsertWorkspaceTurn.bind(store);
    spyOn(store, "upsertWorkspaceTurn").mockImplementationOnce(async (next) => {
      entered.resolve();
      await release.promise;
      return persist(next);
    });
    const recovering = (
      taskService as unknown as {
        settleStaleWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void>;
      }
    ).settleStaleWorkspaceTurn(record);
    await entered.promise;
    let started = false;
    const starting = streams.acquireStreamStartLock(event.workspaceId).then(async (lock) => {
      started = true;
      await lock[Symbol.asyncDispose]();
    });
    await using _otherWorkspace = await streams.acquireStreamStartLock("other-workspace");
    expect(started).toBe(false);
    expect(admissionHeld).toBe(true);
    release.resolve();
    await recovering;
    await starting;
    expect(cleanup).toHaveBeenCalled();
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "completed",
      messageId: event.messageId,
    });
  });

  test("unreadable history does not keep a deferred continuation active forever", async () => {
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    const event = intermediateStopEvent(parentId);
    await taskService.markWorkspaceTurnStreamEndDeferred(event);
    const record = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    assert(record);
    spyOn(historyService, "getHistoryFromLatestBoundary").mockResolvedValueOnce(
      Err("History unavailable")
    );
    await (
      taskService as unknown as {
        settleStaleWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void>;
      }
    ).settleStaleWorkspaceTurn(record);
    expect(
      (await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle"))?.status
    ).toBe("interrupted");
  });

  test("finalizing continuation remains active until its history commit", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    const event = intermediateStopEvent(parentId);
    const getStreamInfo = mock((_workspaceId: string, includeFinalizing?: boolean) =>
      includeFinalizing
        ? { messageId: "continuation-finalizing", muxMetadata: event.metadata.muxMetadata }
        : undefined
    );
    expect(Reflect.set(taskService, "streamManager", { getStreamInfo })).toBe(true);
    await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
    expect(getStreamInfo).toHaveBeenCalledWith(event.workspaceId, true);
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      deferredMessageIds: [event.messageId],
    });
  });

  test.each([
    { cause: { kind: "required-tool" } as const, status: "completed" },
    { cause: { kind: "context-budget", decision: "rollover" } as const, status: "error" },
    { cause: { kind: "step-limit" } as const, status: "error" },
  ])(
    "explicit $cause.kind stop does not borrow unrelated queue attribution",
    async ({ cause, status }) => {
      const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
        getQueueCutCutter: mock(() => ({ stage: "queued", dispatchMode: "tool-end" })),
      });
      const event = intermediateStopEvent(parentId);
      event.metadata.stopCause = cause;
      await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
      expect(
        (await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle"))?.status
      ).toBe(status);
    }
  );

  test("legacy tool stop without continuation records an unknown cause", async () => {
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    const event = intermediateStopEvent(parentId);
    delete event.metadata.stopCause;
    await persistStopEvent(historyService, event);
    await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
    const record = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    expect(record?.status).toBe("error");
    expect(record?.error).toContain("unknown stop cause");
  });

  test("lost continuation settles instead of remaining active after recovery", async () => {
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    const event = intermediateStopEvent(parentId);
    await persistStopEvent(historyService, event);
    await finalizeWorkspaceTurnStreamEndForTest(taskService, event);
    const record = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    expect(record?.status).toBe("error");
    expect(record?.error).toContain("continuation unavailable");
    expect(record?.error).toContain("continuation-entry");
  });

  test("workspace-turn deferred stream-end does not finalize the handle", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    const event: StreamEndEvent = {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_deferred",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(parentId),
      },
      parts: [{ type: "text", text: "Pre-handoff text" }],
    };
    const internal = taskService as unknown as {
      markWorkspaceTurnStreamEndDeferred: (event: StreamEndEvent) => Promise<void>;
      finalizeWorkspaceTurnFromStreamEnd: (event: StreamEndEvent) => Promise<boolean>;
    };

    await internal.markWorkspaceTurnStreamEndDeferred(event);
    expect(await internal.finalizeWorkspaceTurnFromStreamEnd(event)).toBe(true);

    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_deferred"],
    });
  });

  test("a final-flush stream-end is deferred even without a queued continuation", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    const event: StreamEndEvent = {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_flush",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: {
          ...workspaceTurnMuxMetadata(parentId),
          contextBudgetContinuation: true,
          contextBudgetFlush: true,
        },
      },
      parts: [],
    };
    // Nothing is queued (e.g. the user cleared the queue mid-flush): the housekeeping finish still
    // must not settle the delegated task.
    expect(await finalizeWorkspaceTurnStreamEndForTest(taskService, event)).toBe(true);
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_flush"],
    });
  });

  test("workspace-turn deferred marker does not rewrite terminal handles", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    const interruptResult = await taskService.interruptWorkspaceTurn(parentId, "wst_handle");
    expect(interruptResult.success).toBe(true);
    await (
      taskService as unknown as {
        markWorkspaceTurnStreamEndDeferred: (event: StreamEndEvent) => Promise<void>;
      }
    ).markWorkspaceTurnStreamEndDeferred({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_deferred_after_interrupt",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(parentId),
      },
      parts: [{ type: "text", text: "Pre-handoff text" }],
    });

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "interrupted" });
    expect(snapshot?.deferredMessageIds).toBeUndefined();
  });

  test("repeat interrupt of an already-interrupted workspace turn is a no-op", async () => {
    // A queue-cut supersede settles the handle interrupted while the target
    // workspace keeps streaming under the new input. A stale task_stop for the
    // settled handle must not stop that unrelated stream.
    const { parentId, taskService, aiMocks } = await startWorkspaceTurnForTest(rootDir);
    const first = await taskService.interruptWorkspaceTurn(parentId, "wst_handle");
    expect(first.success).toBe(true);
    aiMocks.stopStream.mockClear();

    const repeat = await taskService.interruptWorkspaceTurn(parentId, "wst_handle");
    expect(repeat).toEqual(Ok({ workspaceId: "childworkspace" }));
    expect(aiMocks.stopStream).not.toHaveBeenCalled();
  });

  test("listWorkspaceTurnTasks repairs restart-interrupted deferred handles before filtering", async () => {
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_recovered_list", "assistant", "Recovered list text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        createdWorkspace: true,
        deferredMessageIds: ["msg_recovered_list"],
        error: "Workspace turn interrupted after restart",
      })
    );

    const listed = await taskService.listWorkspaceTurnTasks(parentId, {
      statuses: ["interrupted", "completed"],
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      handleId: "wst_handle",
      status: "completed",
      messageId: "msg_recovered_list",
      reportMarkdown: "Recovered list text",
    });
    expect(listed[0]?.error).toBeUndefined();

    const interruptedOnly = await taskService.listWorkspaceTurnTasks(parentId, {
      statuses: ["interrupted"],
    });
    expect(interruptedOnly.map((record) => record.handleId)).not.toContain("wst_handle");
  });

  test("workspace-turn stale recovery repairs restart-interrupted deferred error handles", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        archivedAt: "2026-06-19T00:01:00.000Z",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_truncated", "assistant", "Partial text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);

    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        createdWorkspace: true,
        deferredMessageIds: ["msg_truncated"],
        error: "Workspace turn interrupted after restart",
      })
    );

    const repaired = await workspaceTurnSnapshot(taskService, parentId);
    expect(repaired).toMatchObject({
      status: "error",
      messageId: "msg_truncated",
      error: "Workspace turn ended before completion (finishReason: length)",
    });
  });

  test("explicitly interrupted workspace turns are not revived by same-turn retry evidence", async () => {
    const isStreaming = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest(
      rootDir,
      {
        isStreaming,
      }
    );
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        createdWorkspace: true,
      })
    );
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await workspaceTurnSnapshot(taskService, parentId)).toMatchObject({
      status: "interrupted",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
  });

  test("snapshot history repair does not downgrade a supersede settlement before the successor lands", async () => {
    // Queue-cut supersede race: the handle settles interrupted from the
    // tool-calls stream-end, but the superseding queued input has not appended
    // its user message to child history yet. A task_await snapshot read in that
    // window repairs from the SAME correlated final and must preserve the
    // supersede classification instead of downgrading it to a truncation error.
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    const supersedeReason =
      "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report";
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_queue_cut", "assistant", "Cut mid-work", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "tool-calls",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        error: supersedeReason,
        createdWorkspace: true,
        messageId: "msg_queue_cut",
      })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: supersedeReason,
      messageId: "msg_queue_cut",
    });
  });

  test("snapshot history repair does not upgrade an error settlement to a supersede", async () => {
    // A tool-calls turn correctly settled as error (no live queue-cut evidence,
    // e.g. a required-tool stop) must stay an error even after unrelated user
    // messages land in child history: order is not causal queue-cut evidence.
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_required_tool_stop", "assistant", "Stopped on required tool", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "tool-calls",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_unrelated_later_input", "user", "Unrelated later question")
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "error", {
        error: "Workspace turn ended before completion (finishReason: tool-calls)",
        createdWorkspace: true,
        messageId: "msg_required_tool_stop",
      })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "error",
      error: "Workspace turn ended before completion (finishReason: tool-calls)",
      messageId: "msg_required_tool_stop",
    });
  });
});
