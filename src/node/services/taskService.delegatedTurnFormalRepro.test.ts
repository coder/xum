import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import assert from "node:assert";
import { Err, Ok } from "@/common/types/result";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import {
  streamEnd,
  workspaceTurnManagerFor,
  workspaceTurnManagerInternals,
  workspaceTurnSnapshot,
  workspaceTurnStreamEndEvent,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceTestRoot,
  registerLiveWorkspaceTurnHandle,
  removeTaskServiceTestRoot,
  startWorkspaceTurnForTest,
} from "@/node/services/taskService.shared.testHarness";

// Deterministic repros of counterexamples found by the TLA+ model in formal/delegated-turns/
// (see the header of formal/delegated-turns/check.sh). Each test asserts the correct behavior;
// each failed before its fix (#5277 by #5303, #5261 by #5308, the others in the same change as
// this comment).
//
// The real TaskService and WorkspaceTurnManager run; only WorkspaceHost.sendMessage is scripted.
// For a peer send it replays AgentSession's final admission gate (agentSession.ts 5141-5150):
// the gate evaluates the caller's admissionStale() probe, awaits the rollback of the pre-turn
// rows, then calls onCanceled. The test acts inside that await, as a concurrent actor could.

type SendArgs = Parameters<WorkspaceHost["sendMessage"]>;
type Internal = NonNullable<SendArgs[3]>;
type SendResult = Awaited<ReturnType<WorkspaceHost["sendMessage"]>>;

const TARGET_ID = "childworkspace";
type TaskServiceLike = Parameters<typeof registerLiveWorkspaceTurnHandle>[0];
const HANDLE_ID = "wst_handle";

function isPeerSend(args: SendArgs): boolean {
  const meta = args[2]?.muxMetadata as { type?: unknown; agentPeerMessageTrigger?: unknown };
  return meta?.type === "agent-peer-message" || meta?.agentPeerMessageTrigger != null;
}

describe("delegated-turn peer delivery: formal-model counterexamples", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  async function setUp(
    options: {
      hasPendingWorkspaceTurnContinuation?: ReturnType<typeof mock>;
      hasPendingQueuedOrPreparingTurn?: ReturnType<typeof mock>;
      isStreaming?: ReturnType<typeof mock>;
    } = {}
  ) {
    // Peer sends reaching the recipient; `accepted` ones were admitted into a turn.
    const peerSends: Array<{ args: SendArgs; accepted: boolean }> = [];
    // The target session's idle wait (waitForIdleAndNoQueuedMessages), which a withdrawn
    // continuation's reconcile awaits (#5261): it resolves once the session has no turn work.
    let sessionBusy = false;
    let idleWaiters: Array<() => void> = [];
    const setSessionBusy = (busy: boolean) => {
      sessionBusy = busy;
      if (busy) return;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    };
    // Scripted behavior for the next peer send (default: admitted).
    const scripts: Array<(args: SendArgs) => Promise<SendResult>> = [];
    const sendMessage = mock(async (...args: SendArgs): Promise<SendResult> => {
      if (!isPeerSend(args)) {
        await args[3]?.onAccepted?.();
        return Ok(undefined);
      }
      const script = scripts.shift();
      if (script != null) return script(args);
      peerSends.push({ args, accepted: true });
      return Ok(undefined);
    });
    const turn = await startWorkspaceTurnForTest(rootDir, {
      sendMessage,
      ...(options.hasPendingWorkspaceTurnContinuation != null
        ? { hasPendingWorkspaceTurnContinuation: options.hasPendingWorkspaceTurnContinuation }
        : {}),
      ...(options.hasPendingQueuedOrPreparingTurn != null
        ? { hasPendingQueuedOrPreparingTurn: options.hasPendingQueuedOrPreparingTurn }
        : {}),
      ...(options.isStreaming != null ? { isStreaming: options.isStreaming } : {}),
      waitForIdleAndNoQueuedMessages: mock((workspaceId: string) =>
        workspaceId === TARGET_ID && sessionBusy
          ? new Promise<void>((resolve) => idleWaiters.push(resolve))
          : Promise.resolve()
      ),
    });
    const { config, parentId, projectPath, taskService, workspaceMocks } = turn;
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project != null);
      const target = project.workspaces.find((workspace) => workspace.id === TARGET_ID);
      assert(target != null);
      target.agentId = "exec";
      target.unrelatedWorkspaceConsent = "consent-1";
      project.workspaces.push({
        path: projectPath,
        id: "sender",
        name: "sender",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    const registrations =
      workspaceTurnManagerInternals(taskService).activeWorkspaceTurnHandleByWorkspaceId;
    const flushes = spyOn(
      taskService as unknown as { flushParkedPeerSends(targetId: string): Promise<void> },
      "flushParkedPeerSends"
    );
    // Settles every flush, including those scheduled by the flushes awaited so far: a release
    // schedules its flush through a MutexMap, so the call can land after the release returns.
    const drained = async () => {
      let seen = -1;
      while (seen !== flushes.mock.calls.length) {
        seen = flushes.mock.calls.length;
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.all(flushes.mock.results.map((result) => result.value as Promise<void>));
      }
    };
    // The raw handle record. getWorkspaceTurnSnapshot is avoided on purpose: reading through it
    // normalizes the record (normalizeWorkspaceTurnRecord settles a handle it finds stale).
    const rawStatus = async () =>
      (
        await workspaceTurnManagerInternals(taskService).taskHandleStore.getWorkspaceTurn(
          parentId,
          HANDLE_ID
        )
      )?.status;
    // Settles every reconcile a withdrawn continuation scheduled once the target was idle (#5261).
    const reconciles = spyOn(
      workspaceTurnManagerFor(taskService),
      "reconcileWithdrawnWorkspaceTurnContinuation"
    );
    const settled = async () => {
      let seen = -1;
      while (seen !== reconciles.mock.calls.length) {
        seen = reconciles.mock.calls.length;
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.all(reconciles.mock.results.map((result) => result.value as Promise<void>));
      }
    };
    const rawRecord = () =>
      workspaceTurnManagerInternals(taskService).taskHandleStore.getWorkspaceTurn(
        parentId,
        HANDLE_ID
      );
    const eventLocks = (taskService as unknown as { workspaceEventLocks: MutexMap<string> })
      .workspaceEventLocks;
    return {
      rawStatus,
      rawRecord,
      eventLocks,
      settled,
      setSessionBusy,
      isBusyForMessage: workspaceMocks.isBusyForMessage,
      sendMessage,
      parentId,
      taskService,
      config,
      projectPath,
      peerSends,
      scripts,
      registrations,
      drained,
    };
  }

  // The final admission gate refuses because of a delegated turn, and `duringRollback` runs
  // while the rows are rolled back, before onCanceled parks the message.
  function refuseAtFinalGate(taskService: TaskServiceLike, duringRollback: () => Promise<void>) {
    return async (args: SendArgs): Promise<SendResult> => {
      const internal: Internal | undefined = args[3];
      // Turn A reserves the target while this message is preparing (after its earlier gates).
      await registerLiveWorkspaceTurnHandle(taskService, TARGET_ID, "wst_a", "owner-2", "reserved");
      expect(internal?.admissionStale?.()).toBe(true);
      await duringRollback();
      await internal?.onCanceled?.("Send refused: the caller's admission became stale.");
      return Err({ type: "unknown", raw: "Send refused: the caller's admission became stale." });
    };
  }

  // Model: MC_5277.cfg, invariant NoDeliveryIntoReplacement.
  test("#5277: a replacement turn registered during the rollback does not become the awaited turn", async () => {
    const s = await setUp();
    await streamEnd(s.taskService, workspaceTurnStreamEndEvent(s.parentId, "msg_done", "Done"));
    expect(s.registrations.get(TARGET_ID)).toBeUndefined();
    s.scripts.push(
      refuseAtFinalGate(s.taskService, async () => {
        // Turn B registers while the message's rows are being rolled back.
        s.registrations.delete(TARGET_ID);
        await registerLiveWorkspaceTurnHandle(s.taskService, TARGET_ID, "wst_b", "owner-2");
      })
    );
    const sending = s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "stale guidance");
    expect(await sending).toMatchObject(Ok({ delivery: "queued", awaitsDelegatedTurn: true }));
    // B releases: the message waited for A, and B is a replacement, so it must be dropped.
    s.registrations.delete(TARGET_ID);
    await s.drained();
    expect(s.peerSends).toHaveLength(0);
  });

  // Model: MC_F1_StopPark.cfg, invariant UserStopRespected (finding F1).
  test("F1: a user Stop during the rollback drops the message that parks after it", async () => {
    const s = await setUp();
    await streamEnd(s.taskService, workspaceTurnStreamEndEvent(s.parentId, "msg_done", "Done"));
    let releaseStopLatch: (() => void) | undefined;
    s.scripts.push(
      refuseAtFinalGate(s.taskService, () => {
        // Turn A's requireIdle send fails (the target is preparing this message) and releases A.
        s.registrations.delete(TARGET_ID);
        // The user presses Stop on the target: WorkspaceService.interruptStream's sync prefix.
        s.taskService.resetAutoResumeCount(TARGET_ID);
        s.taskService.markParentWorkspaceInterrupted(TARGET_ID);
        releaseStopLatch = s.taskService.latchHardInterruptCascade(TARGET_ID);
        return Promise.resolve();
      })
    );
    const sending = s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "pre-stop guidance");
    // The Stop refuses the message instead of letting it wait (the sender is told).
    expect(await sending).toMatchObject({ success: false, error: { code: "refused" } });
    // The user types a new message while the stop cascade still runs (clears the suppression),
    // then the cascade finishes and releases its latch.
    s.taskService.resetAutoResumeCount(TARGET_ID);
    assert(releaseStopLatch != null);
    releaseStopLatch();
    await s.drained();
    // Input admitted before a user Stop must not run after it.
    expect(s.peerSends).toHaveLength(0);
  });

  // Model: MC_5261.cfg, invariant NoOrphanedTurn.
  test("#5261: a withdrawn correlated continuation does not leave the delegated turn running", async () => {
    let continuationQueued = false;
    const s = await setUp({
      hasPendingWorkspaceTurnContinuation: mock(() => continuationQueued),
    });
    let queuedInternal: Internal | undefined;
    s.scripts.push((args) => {
      // Target busy: the owner's guidance is queued with the turn's correlation.
      queuedInternal = args[3];
      continuationQueued = true;
      return Promise.resolve(Ok(undefined));
    });
    const sent = await s.taskService.sendAgentTreeMessage(s.parentId, TARGET_ID, "more guidance");
    expect(sent).toMatchObject(Ok({ delivery: "queued" }));
    expect(queuedInternal?.workspaceTurnContinuation).toBe(true);
    // The delegated stream ends; settlement defers to the queued continuation.
    await streamEnd(s.taskService, workspaceTurnStreamEndEvent(s.parentId, "msg_done", "Done"));
    expect((await workspaceTurnSnapshot(s.taskService, s.parentId))?.status).toBe("running");
    // The owner is archived before the entry dispatches; the dequeue gate withdraws it
    // (agentSession.ts 10576-10593).
    await s.config.editConfig((cfg) => {
      const owner = cfg.projects
        .get(s.projectPath)
        ?.workspaces.find((workspace) => workspace.id === s.parentId);
      assert(owner != null);
      owner.archivedAt = "2026-06-20T00:00:00.000Z";
      return cfg;
    });
    expect(queuedInternal?.admissionStale?.()).toBe(true);
    continuationQueued = false;
    await queuedInternal?.onCanceled?.("stale");
    await s.settled();
    // Nothing is left that could settle the turn, so the withdrawal settles it. Before the fix
    // the handle stayed running and registered until something read it through
    // normalizeWorkspaceTurnRecord (task_await, task_list), and non-owners waited behind it.
    expect(await s.rawStatus()).not.toBe("running");
    expect(s.registrations.get(TARGET_ID)).toBeUndefined();
    // A non-owner's message sent now runs as an ordinary turn.
    const hi = await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "hi");
    expect(hi.success).toBe(true);
    expect(hi).not.toMatchObject(Ok({ awaitsDelegatedTurn: true }));
    await s.drained();
    expect(s.peerSends).toHaveLength(1);
  });

  // Model: MC_Search.cfg (Fix5261 settles once the target is idle).
  test("#5261: a continuation refused at the final gate settles the turn once the session is idle", async () => {
    let continuationQueued = false;
    let preparing = false;
    const s = await setUp({
      hasPendingWorkspaceTurnContinuation: mock(() => continuationQueued),
      hasPendingQueuedOrPreparingTurn: mock(() => preparing),
    });
    let queuedInternal: Internal | undefined;
    s.scripts.push((args) => {
      queuedInternal = args[3];
      continuationQueued = true;
      return Promise.resolve(Ok(undefined));
    });
    expect(
      await s.taskService.sendAgentTreeMessage(s.parentId, TARGET_ID, "more guidance")
    ).toMatchObject(Ok({ delivery: "queued" }));
    await streamEnd(s.taskService, workspaceTurnStreamEndEvent(s.parentId, "msg_done", "Done"));
    await s.config.editConfig((cfg) => {
      const owner = cfg.projects
        .get(s.projectPath)
        ?.workspaces.find((workspace) => workspace.id === s.parentId);
      assert(owner != null);
      owner.archivedAt = "2026-06-20T00:00:00.000Z";
      return cfg;
    });
    // The entry was dequeued and is preparing when the final gate refuses it: while it prepares
    // it still counts as a live continuation, so the turn is kept.
    preparing = true;
    s.setSessionBusy(true);
    expect(queuedInternal?.admissionStale?.()).toBe(true);
    await queuedInternal?.onCanceled?.("stale");
    await s.settled();
    expect(await s.rawStatus()).toBe("running");
    // The preparation ends and the session goes idle: the reconcile settles the turn.
    preparing = false;
    continuationQueued = false;
    s.setSessionBusy(false);
    await s.settled();
    expect(await s.rawStatus()).not.toBe("running");
    expect(s.registrations.get(TARGET_ID)).toBeUndefined();
  });

  // Model: MC_Search.cfg (a stream end is queued on the event lock before the target is idle).
  test("#5261: the settlement does not overtake a newer correlated stream end", async () => {
    let continuationQueued = false;
    const s = await setUp({
      hasPendingWorkspaceTurnContinuation: mock(() => continuationQueued),
    });
    let queuedInternal: Internal | undefined;
    s.scripts.push((args) => {
      queuedInternal = args[3];
      continuationQueued = true;
      return Promise.resolve(Ok(undefined));
    });
    await s.taskService.sendAgentTreeMessage(s.parentId, TARGET_ID, "more guidance");
    await streamEnd(s.taskService, workspaceTurnStreamEndEvent(s.parentId, "msg_done", "Done"));
    expect((await s.rawRecord())?.status).toBe("running");
    // Something else holds the target's event lock (a peer send, for example).
    let release: (() => void) | undefined;
    const held = s.eventLocks.withLock(TARGET_ID, () => new Promise<void>((r) => (release = r)));
    // The continuation is withdrawn while a newer correlated stream (another continuation of the
    // turn) runs: the reconcile waits for the target to be idle.
    s.setSessionBusy(true);
    continuationQueued = false;
    await queuedInternal?.onCanceled?.("stale");
    // The newer stream ends: its handler is queued on the lock before the session reads idle.
    const ended = streamEnd(
      s.taskService,
      workspaceTurnStreamEndEvent(s.parentId, "msg_newer", "Newer")
    );
    s.setSessionBusy(false);
    assert(release != null);
    release();
    await held;
    await ended;
    await s.settled();
    // The newer stream end settles the turn, not the older deferred result.
    const record = await s.rawRecord();
    expect(record?.status).toBe("completed");
    expect(record?.messageId).toBe("msg_newer");
  });

  // Model: MC_F3_StaleCorr.cfg, invariant NonOwnerNeverCorrelated (finding F3).
  test("F3: a send whose correlation's registration is gone is refused, not dispatched", async () => {
    const s = await setUp();
    s.scripts.push(async (args) => {
      const internal: Internal | undefined = args[3];
      expect(internal?.workspaceTurnContinuation).toBe(true);
      // The turn settles (for example through a read of its handle) before the final gate.
      s.registrations.delete(TARGET_ID);
      expect(internal?.admissionStale?.()).toBe(true);
      await internal?.onCanceled?.("stale");
      return Err({ type: "unknown", raw: "Send refused: the caller's admission became stale." });
    });
    const sent = await s.taskService.sendAgentTreeMessage(s.parentId, TARGET_ID, "more");
    expect(sent.success).toBe(false);
    expect(s.peerSends).toHaveLength(0);
  });

  // Model: MC_F2_RegReplace.cfg, invariant NonOwnerNeverCorrelated (finding F2).
  test("F2: a failed reservation does not unregister the running delegated turn", async () => {
    // Turn A's stream is still running.
    const s = await setUp({ isStreaming: mock(() => true) });
    expect(s.registrations.get(TARGET_ID)?.handleId).toBe(HANDLE_ID);
    // A second createWorkspaceTurn B read the target as idle, so it takes the reserve path. A
    // starts while B persists its handle (the last await before B reserves), so B's requireIdle
    // send would fail.
    let busy = false;
    s.isBusyForMessage.mockImplementation(() => busy);
    const store = workspaceTurnManagerInternals(s.taskService).taskHandleStore;
    const upsert = store.upsertWorkspaceTurn.bind(store);
    spyOn(store, "upsertWorkspaceTurn").mockImplementation(async (record) => {
      await upsert(record);
      if (record.handleId !== HANDLE_ID) busy = true;
    });
    s.sendMessage.mockImplementationOnce(() =>
      Promise.resolve(Err({ type: "unknown", raw: "Workspace is busy." }))
    );
    const second = await workspaceTurnManagerFor(s.taskService).createWorkspaceTurn({
      ownerWorkspaceId: s.parentId,
      prompt: "More",
      title: "Second turn",
      workspace: { mode: "existing", workspaceId: TARGET_ID },
    });
    expect(second.success).toBe(false);
    expect(s.registrations.get(TARGET_ID)?.handleId).toBe(HANDLE_ID);
    expect(await s.rawStatus()).toBe("running");
    // A non-owner's message must wait for A (#4997), not run while A is live.
    const sent = await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "hello");
    expect(sent).toMatchObject(Ok({ awaitsDelegatedTurn: true }));
    expect(s.peerSends).toHaveLength(0);
  });

  test("F2: a synchronous busy refusal enqueues no terminal wake", async () => {
    const s = await setUp({ isStreaming: mock(() => true) });
    // As above: the running turn becomes busy while B persists its handle.
    let busy = false;
    s.isBusyForMessage.mockImplementation(() => busy);
    const store = workspaceTurnManagerInternals(s.taskService).taskHandleStore;
    const upsert = store.upsertWorkspaceTurn.bind(store);
    spyOn(store, "upsertWorkspaceTurn").mockImplementation(async (record) => {
      await upsert(record);
      if (record.handleId !== HANDLE_ID) busy = true;
    });
    const enqueued = spyOn(s.taskService, "enqueueTerminalAttention");
    const second = await workspaceTurnManagerFor(s.taskService).createWorkspaceTurn({
      ownerWorkspaceId: s.parentId,
      prompt: "More",
      title: "Second turn",
      workspace: { mode: "existing", workspaceId: TARGET_ID },
      attentionPolicy: "notify_on_terminal",
    });
    // B's caller gets the refusal synchronously, so settling B must not wake it again.
    expect(second.success).toBe(false);
    expect(enqueued).not.toHaveBeenCalled();
  });
});
