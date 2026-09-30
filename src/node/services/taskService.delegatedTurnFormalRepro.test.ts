import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import assert from "node:assert";
import { Err, Ok } from "@/common/types/result";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import {
  streamEnd,
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
// (see the header of formal/delegated-turns/check.sh). Each test asserts the CORRECT behavior and is marked test.failing while
// the bug is open: when a fix lands, the test starts passing, bun reports it, and the fix PR
// flips it to a plain test.
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
      isStreaming?: ReturnType<typeof mock>;
    } = {}
  ) {
    // Peer sends reaching the recipient; `accepted` ones were admitted into a turn.
    const peerSends: Array<{ args: SendArgs; accepted: boolean }> = [];
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
      ...(options.isStreaming != null ? { isStreaming: options.isStreaming } : {}),
    });
    const { config, parentId, projectPath, taskService } = turn;
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
    return {
      rawStatus,
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
  test.failing(
    "#5277: a replacement turn registered during the rollback does not become the awaited turn",
    async () => {
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
    }
  );

  // Model: MC_F1_StopPark.cfg, invariant UserStopRespected (finding F1).
  test.failing(
    "F1: a user Stop during the rollback drops the message that parks after it",
    async () => {
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
      expect(await sending).toMatchObject(Ok({ delivery: "queued", awaitsDelegatedTurn: true }));
      // The user types a new message while the stop cascade still runs (clears the suppression),
      // then the cascade finishes and releases its latch.
      s.taskService.resetAutoResumeCount(TARGET_ID);
      assert(releaseStopLatch != null);
      releaseStopLatch();
      await s.drained();
      // Input admitted before a user Stop must not run after it.
      expect(s.peerSends).toHaveLength(0);
    }
  );

  // Model: MC_5261.cfg, invariant NoOrphanedTurn.
  test.failing(
    "#5261: a withdrawn correlated continuation does not leave the delegated turn running",
    async () => {
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
      await s.drained();
      // A non-owner's message sent now waits behind the unsettled turn.
      expect(await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "hi")).toMatchObject(
        Ok({ awaitsDelegatedTurn: true })
      );
      await s.drained();
      // Nothing is left that could settle the turn, so it must be settled already, and the
      // waiting message delivered. Today the handle stays running and registered, and the message
      // waits, until something reads the handle through normalizeWorkspaceTurnRecord (task_await,
      // task_list), which settles it as a stale turn.
      expect(await s.rawStatus()).not.toBe("running");
      expect(s.registrations.get(TARGET_ID)).toBeUndefined();
      expect(s.peerSends).toHaveLength(1);
    }
  );

  // Model: MC_F2_RegReplace.cfg, invariant NonOwnerNeverCorrelated (finding F2). The trigger
  // (a second createWorkspaceTurn reserving the target while turn A is live, then failing its
  // requireIdle send) is replayed with the registration map calls it makes.
  test.failing(
    "F2: a failed reservation does not unregister the running delegated turn",
    async () => {
      // Turn A's stream is still running.
      const s = await setUp({ isStreaming: mock(() => true) });
      expect(s.registrations.get(TARGET_ID)?.handleId).toBe(HANDLE_ID);
      // createWorkspaceTurn for B: Map.set replaces A without a release (workspaceTurnManager.ts
      // 644-649, 1887); B's requireIdle send fails and settleWorkspaceTurn deletes B (2797/2916).
      await registerLiveWorkspaceTurnHandle(
        s.taskService,
        TARGET_ID,
        "wst_b",
        s.parentId,
        "reserved"
      );
      s.registrations.delete(TARGET_ID);
      expect(await s.rawStatus()).toBe("running");
      // A non-owner's message must wait for A (#4997), not run while A is live.
      const sent = await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "hello");
      expect(sent).toMatchObject(Ok({ awaitsDelegatedTurn: true }));
      expect(s.peerSends).toHaveLength(0);
    }
  );
});
