import * as path from "path";
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import assert from "node:assert";
import { Ok, type Result } from "@/common/types/result";
import { createMuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import type { StreamEndEvent } from "@/common/types/stream";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";
import type { HistoryService } from "@/node/services/historyService";
import type { TaskService } from "@/node/services/taskService";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspacesWithCheckouts as saveWorkspaces,
  streamEnd,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnManagerInternals,
  workspaceTurnMuxMetadata,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  flushTerminalAttentionDrains,
  registerLiveWorkspaceTurnHandle,
  removeTaskServiceTestRoot,
  startWorkspaceTurnForTest,
} from "@/node/services/taskService.shared.testHarness";

// #5261: a stream end that deferred to a queued owner or peer continuation must settle once that
// continuation is withdrawn, without a later task_list or task_await snapshot observing it.

type SendArgs = Parameters<WorkspaceHost["sendMessage"]>;
type SendInternal = NonNullable<SendArgs[3]>;
type Correlation = Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>;
interface TargetState {
  turnWork: boolean;
  continuationPending: boolean;
}

const WITHDRAWALS = {
  "the queue cancels it": (internal: SendInternal) => internal.onCanceled?.("withdrawn"),
  "admission refuses it after dequeue": (internal: SendInternal) =>
    internal.onAcceptedPreStreamFailure?.({ type: "unknown", raw: "Sender stopped" }),
};

/** The target session's turn work and queued same-turn continuations, as TaskService sees them. */
function createTargetSession(targetId: string) {
  let state: TargetState = { turnWork: false, continuationPending: false };
  let idleWaiters: Array<() => void> = [];
  let idleWaitListeners: Array<() => void> = [];
  const peerSends: SendInternal[] = [];
  const sendMessage = mock(async (...args: SendArgs): Promise<Result<void>> => {
    const meta = args[2]?.muxMetadata as { agentPeerMessageTrigger?: unknown } | undefined;
    if (meta?.agentPeerMessageTrigger != null) {
      assert(args[3] != null);
      peerSends.push(args[3]);
      state = { turnWork: true, continuationPending: args[3].workspaceTurnContinuation === true };
    } else {
      // The delegated turn's own prompt: accepted, so its owner may continue it.
      await args[3]?.onAccepted?.();
    }
    return Ok(undefined);
  });
  const waitForIdleAndNoQueuedMessages = mock((workspaceId: string) => {
    if (workspaceId !== targetId) return Promise.resolve();
    const listeners = idleWaitListeners;
    idleWaitListeners = [];
    for (const notify of listeners) notify();
    return state.turnWork
      ? new Promise<void>((resolve) => idleWaiters.push(resolve))
      : Promise.resolve();
  });
  return {
    sendMessage,
    peerSends,
    hostMocks: {
      hasPendingQueuedOrPreparingTurn: mock((id: string) => id === targetId && state.turnWork),
      hasPendingWorkspaceTurnContinuation: mock(
        (id: string) => id === targetId && state.continuationPending
      ),
      waitForIdleAndNoQueuedMessages,
    },
    set(next: TargetState) {
      state = next;
      if (state.turnWork) return;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    },
    nextIdleWait: () => new Promise<void>((resolve) => idleWaitListeners.push(resolve)),
  };
}

async function appendCorrelatedReply(
  historyService: HistoryService,
  workspaceId: string,
  messageId: string,
  text: string,
  correlation: Correlation
) {
  await historyService.appendToHistory(
    workspaceId,
    createMuxMessage(messageId, "assistant", text, {
      model: "anthropic:claude-opus-4-6",
      finishReason: "stop",
      muxMetadata: correlation,
    })
  );
}

function correlatedStreamEnd(
  workspaceId: string,
  messageId: string,
  text: string,
  correlation: Correlation
): StreamEndEvent {
  return {
    type: "stream-end",
    workspaceId,
    messageId,
    metadata: {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      finishReason: "stop",
      muxMetadata: correlation,
    },
    parts: [{ type: "text", text }],
  };
}

/** The stream ends, committing its reply, while the continuation is still queued. */
async function endStreamDeferred(
  taskService: TaskService,
  historyService: HistoryService,
  workspaceId: string,
  correlation: Correlation
) {
  await appendCorrelatedReply(historyService, workspaceId, "msg_done", "Done", correlation);
  await streamEnd(taskService, correlatedStreamEnd(workspaceId, "msg_done", "Done", correlation));
  expect(await persistedTurn(taskService, correlation)).toMatchObject({
    status: "running",
    deferredMessageIds: ["msg_done"],
  });
}

function persistedTurn(taskService: TaskService, correlation: Correlation) {
  // Raw store read: normalizing reads (task_list, task_await snapshots) would self-heal the turn.
  return workspaceTurnManagerInternals(taskService).taskHandleStore.getWorkspaceTurn(
    correlation.ownerWorkspaceId,
    correlation.taskHandleId
  );
}

describe("TaskService withdrawn workspace-turn continuations (#5261)", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  const TARGET_ID = "childworkspace";

  async function setUpOwnerContinuation() {
    const session = createTargetSession(TARGET_ID);
    const turn = await startWorkspaceTurnForTest(rootDir, {
      sendMessage: session.sendMessage,
      ...session.hostMocks,
    });
    await turn.config.editConfig((cfg) => {
      const target = findWorkspaceEntry(cfg, TARGET_ID);
      assert(target != null);
      target.workspace.unrelatedWorkspaceConsent = "consent";
      return cfg;
    });
    const correlation = workspaceTurnMuxMetadata(turn.parentId);
    const result = await turn.taskService.sendAgentTreeMessage(
      turn.parentId,
      TARGET_ID,
      "One more thing"
    );
    expect(result).toMatchObject(Ok({ delivery: "queued" }));
    const continuation = session.peerSends.at(-1);
    assert(continuation?.workspaceTurnContinuation === true, "the owner continues its turn");
    await endStreamDeferred(turn.taskService, turn.historyService, TARGET_ID, correlation);
    const waiter = workspaceTurnManagerFor(turn.taskService).waitForWorkspaceTurn(
      correlation.taskHandleId,
      { requestingWorkspaceId: turn.parentId, backgroundOnMessageQueued: false }
    );
    return { ...turn, session, correlation, continuation, waiter };
  }

  type OwnerSetup = Awaited<ReturnType<typeof setUpOwnerContinuation>>;

  /**
   * Withdraw after the target went idle, but let `stateBeforeReconcile` claim the target before
   * the reconcile runs, then return once the reconcile has kept the turn and waits for idle again.
   */
  async function withdrawRacingNewWork(s: OwnerSetup, stateBeforeReconcile: TargetState) {
    const eventLocks = (s.taskService as unknown as { workspaceEventLocks: MutexMap<string> })
      .workspaceEventLocks;
    let releaseLock!: () => void;
    await new Promise<void>((held) => {
      void eventLocks.withLock(TARGET_ID, () => {
        held();
        return new Promise<void>((release) => (releaseLock = release));
      });
    });
    s.session.set({ turnWork: false, continuationPending: false });
    const firstIdleWait = s.session.nextIdleWait();
    await s.continuation.onCanceled?.("withdrawn");
    await firstIdleWait;
    s.session.set(stateBeforeReconcile);
    const retryIdleWait = s.session.nextIdleWait();
    releaseLock();
    await retryIdleWait;
    expect(await persistedTurn(s.taskService, s.correlation)).toMatchObject({ status: "running" });
  }

  test.each(Object.entries(WITHDRAWALS))(
    "an owner continuation into a delegated root settles the deferred turn when %s",
    async (_withdrawal, withdraw) => {
      const s = await setUpOwnerContinuation();

      s.session.set({ turnWork: false, continuationPending: false });
      await withdraw(s.continuation);
      await flushTerminalAttentionDrains(s.taskService);

      expect(await persistedTurn(s.taskService, s.correlation)).toMatchObject({
        status: "completed",
        messageId: "msg_done",
        reportMarkdown: "Done",
      });
      expect(await s.waiter).toMatchObject({ messageId: "msg_done", reportMarkdown: "Done" });
    }
  );

  test("a surviving same-turn continuation, not the withdrawn one, settles the turn", async () => {
    const s = await setUpOwnerContinuation();
    await withdrawRacingNewWork(s, { turnWork: true, continuationPending: true });

    // The survivor runs as part of the turn, and its stream end settles it first.
    s.session.set({ turnWork: true, continuationPending: false });
    await appendCorrelatedReply(
      s.historyService,
      TARGET_ID,
      "msg_survivor",
      "Survivor report",
      s.correlation
    );
    await streamEnd(
      s.taskService,
      correlatedStreamEnd(TARGET_ID, "msg_survivor", "Survivor report", s.correlation)
    );
    const settled = await persistedTurn(s.taskService, s.correlation);
    expect(settled).toMatchObject({ status: "completed", messageId: "msg_survivor" });

    s.session.set({ turnWork: false, continuationPending: false });
    await flushTerminalAttentionDrains(s.taskService);
    expect(await persistedTurn(s.taskService, s.correlation)).toEqual(settled);
    expect(await s.waiter).toMatchObject({ reportMarkdown: "Survivor report" });
  });

  test("other turn work that fails before streaming settles the turn at the next idle", async () => {
    const s = await setUpOwnerContinuation();
    await withdrawRacingNewWork(s, { turnWork: true, continuationPending: false });

    s.session.set({ turnWork: false, continuationPending: false });
    await flushTerminalAttentionDrains(s.taskService);

    expect(await persistedTurn(s.taskService, s.correlation)).toMatchObject({
      status: "completed",
      reportMarkdown: "Done",
    });
    expect(await s.waiter).toMatchObject({ reportMarkdown: "Done" });
  });

  test("a peer continuation into a reawakened agent task settles its execution", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "sender", "sender"),
        projectWorkspace(projectPath, "parent-root", "parent-root"),
        projectWorkspace(projectPath, "target", "target", {
          parentWorkspaceId: "parent-root",
          taskStatus: "reported",
          taskExecutionStatus: "running",
          taskExecutionId: "wst_live",
          unrelatedWorkspaceConsent: "consent",
          agentId: "explore",
        }),
      ],
      testTaskSettings()
    );
    const session = createTargetSession("target");
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage: session.sendMessage,
      ...session.hostMocks,
    });
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });
    await registerLiveWorkspaceTurnHandle(taskService, "target", "wst_live", "parent-root");
    const correlation = workspaceTurnMuxMetadata("parent-root", "wst_live", "wst_live-turn");

    expect(await taskService.sendAgentTreeMessage("sender", "target", "Status?")).toMatchObject(
      Ok({ delivery: "queued", relation: "target_unrelated" })
    );
    const continuation = session.peerSends.at(-1);
    assert(continuation?.workspaceTurnContinuation === true);
    await endStreamDeferred(taskService, historyService, "target", correlation);

    session.set({ turnWork: false, continuationPending: false });
    await continuation.onCanceled?.("withdrawn");
    await flushTerminalAttentionDrains(taskService);

    expect(await persistedTurn(taskService, correlation)).toMatchObject({ status: "completed" });
    const target = findWorkspaceInConfig(config, "target");
    expect(target?.taskExecutionStatus).toBe("completed");
    expect(target?.taskStatus).toBe("reported");
  });
});
