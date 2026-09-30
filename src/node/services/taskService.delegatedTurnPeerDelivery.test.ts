import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import assert from "node:assert";
import { Ok, type Result } from "@/common/types/result";
import { createMuxMessage } from "@/common/types/message";
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

// #4997: a delegated workspace turn stays owner-only. A peer message from any other sender waits
// until that turn settles and then runs as its own turn under the recipient's saved agent, so it
// never runs inside the delegated turn, under its per-turn agent, or in the owner's result.

type SendArgs = Parameters<WorkspaceHost["sendMessage"]>;

const TARGET_ID = "childworkspace";

interface TaskServiceInternals {
  sendTreeMessage(spec: unknown): Promise<unknown>;
  flushParkedPeerSends(targetId: string): Promise<void>;
}
const HANDLE_ID = "wst_handle";

function isPeerSend(args: SendArgs): boolean {
  const meta = args[2]?.muxMetadata as { type?: unknown; agentPeerMessageTrigger?: unknown };
  return meta?.type === "agent-peer-message" || meta?.agentPeerMessageTrigger != null;
}

function payloadText(args: SendArgs): string {
  const row = args[3]?.preTurnMessages?.[0];
  assert(row != null, "peer sends carry their envelope as a pre-turn row");
  return row.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("TaskService delegated-turn peer delivery (#4997)", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  async function setUp() {
    const peerSends: SendArgs[] = [];
    const peerSendWaiters = new Set<() => void>();
    // While set, peer deliveries block after being recorded (to hold the target's event lock).
    let peerGate: Promise<void> | undefined;
    const sendMessage = mock(async (...args: SendArgs): Promise<Result<void>> => {
      if (isPeerSend(args)) {
        peerSends.push(args);
        for (const waiter of peerSendWaiters) waiter();
        await peerGate;
      } else {
        // The delegated turn's own prompt: accept it so the registration is live and accepted.
        await args[3]?.onAccepted?.();
      }
      return Ok(undefined);
    });
    const turn = await startWorkspaceTurnForTest(rootDir, { sendMessage });
    const { config, parentId, projectPath, taskService, historyService } = turn;
    assert(
      workspaceTurnManagerFor(taskService).getLiveWorkspaceTurnRegistration(TARGET_ID)?.accepted ===
        true,
      "the delegated turn must be accepted and live"
    );
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project != null);
      const target = project.workspaces.find((workspace) => workspace.id === TARGET_ID);
      assert(target != null);
      // The recipient's saved agent; the delegated turn's history below names another one.
      target.agentId = "exec";
      target.unrelatedWorkspaceConsent = "consent-1";
      project.workspaces.push(
        {
          path: projectPath,
          id: "sender",
          name: "sender",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        },
        {
          path: projectPath,
          id: "sub",
          name: "sub",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
          parentWorkspaceId: TARGET_ID,
          taskStatus: "running",
          agentType: "explore",
          // A background sub-agent, so it does not hold the delegated turn open.
          taskAttentionPolicy: "notify_on_terminal",
        }
      );
      return cfg;
    });
    // The delegated turn ran under a per-turn agent; a history-derived resume would pick it up.
    await historyService.appendToHistory(
      TARGET_ID,
      createMuxMessage("delegated-output", "assistant", "Delegated work", { agentId: "plan" })
    );
    // Resolves once `count` peer sendMessage calls happened (deliveries after settlement run off
    // the settling call, so tests wait on this instead of sleeping).
    const peerSendCount = (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (peerSends.length < count) return;
          peerSendWaiters.delete(check);
          resolve();
        };
        peerSendWaiters.add(check);
        check();
      });
    const nextPeerSend = () => {
      const index = peerSends.length;
      return peerSendCount(index + 1).then(() => peerSends[index]);
    };
    const edit = (workspaceId: string, update: (workspace: Record<string, unknown>) => void) =>
      config.editConfig((cfg) => {
        const workspace = cfg.projects
          .get(projectPath)
          ?.workspaces.find((candidate) => candidate.id === workspaceId);
        assert(workspace != null);
        update(workspace as unknown as Record<string, unknown>);
        return cfg;
      });
    const holdPeerSends = () => {
      let release!: () => void;
      peerGate = new Promise((resolve) => (release = resolve));
      return () => {
        peerGate = undefined;
        release();
      };
    };
    return { parentId, taskService, peerSends, peerSendCount, nextPeerSend, edit, holdPeerSends };
  }

  type Setup = Awaited<ReturnType<typeof setUp>>;

  const settle = {
    completed: (s: Setup) =>
      streamEnd(s.taskService, workspaceTurnStreamEndEvent(s.parentId, "msg_done", "Done")),
    error: (s: Setup) =>
      streamEnd(
        s.taskService,
        workspaceTurnStreamEndEvent(s.parentId, "msg_cut", "Partial", { finishReason: "length" })
      ),
    interrupted: async (s: Setup) => {
      const result = await workspaceTurnManagerFor(s.taskService).interruptWorkspaceTurn(
        s.parentId,
        HANDLE_ID
      );
      expect(result.success).toBe(true);
    },
  } as const;

  test.each([
    ["an opted-in unrelated root", "sender", "target_unrelated"],
    ["a same-tree sub-agent", "sub", "target_ancestor"],
  ] as const)(
    "a message from %s waits for the delegated turn and runs as its own turn",
    async (_label, senderId, relation) => {
      const s = await setUp();
      const result = await s.taskService.sendAgentTreeMessage(senderId, TARGET_ID, "Status?");
      expect(result).toMatchObject(Ok({ delivery: "queued", relation, awaitsDelegatedTurn: true }));
      // Not delivered into the running delegated turn.
      expect(s.peerSends).toHaveLength(0);

      const delivered = s.nextPeerSend();
      await settle.completed(s);
      const [targetId, , options, internal] = await delivered;
      expect(targetId).toBe(TARGET_ID);
      expect(payloadText([targetId, "", options, internal])).toContain("Status?");
      // Its own uncorrelated turn under the recipient's saved agent, not the delegated turn's.
      expect(options?.agentId).toBe("exec");
      expect(options?.muxMetadata).toMatchObject({ type: "agent-peer-message" });
      expect(internal?.workspaceTurnContinuation).toBe(false);
      expect(await workspaceTurnSnapshot(s.taskService, s.parentId)).toMatchObject({
        status: "completed",
        reportMarkdown: "Done",
      });
    }
  );

  test("a fresh message queues behind messages still draining after the turn", async () => {
    const s = await setUp();
    for (const message of ["first", "second"]) {
      expect((await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, message)).success).toBe(
        true
      );
    }
    const release = s.holdPeerSends();
    await settle.completed(s);
    // "first" is being delivered and holds the target's event lock; "third" arrives meanwhile.
    await s.peerSendCount(1);
    const third = s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "third");
    release();
    expect(await third).toMatchObject(Ok({ delivery: "queued", awaitsDelegatedTurn: true }));
    await s.peerSendCount(3);
    expect(s.peerSends.map((args) => /first|second|third/.exec(payloadText(args))?.[0])).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test.each(["completed", "error", "interrupted"] as const)(
    "a %s delegated turn releases the waiting message",
    async (kind) => {
      const s = await setUp();
      expect((await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "Hi")).success).toBe(
        true
      );
      expect(s.peerSends).toHaveLength(0);
      const delivered = s.nextPeerSend();
      await settle[kind](s);
      await delivered;
      expect(s.peerSends).toHaveLength(1);
      expect((await workspaceTurnSnapshot(s.taskService, s.parentId))?.status).toBe(kind);
    }
  );

  test.each([
    [
      // An off/on cycle is a new grant, not permission to revive input admitted before it.
      "consent is revoked and granted again",
      async (s: Setup) => {
        await s.edit(TARGET_ID, (target) => delete target.unrelatedWorkspaceConsent);
        await s.edit(TARGET_ID, (target) => (target.unrelatedWorkspaceConsent = "consent-2"));
      },
      (_s: Setup) => Promise.resolve(),
    ],
    [
      "the sender is archived",
      (s: Setup) => s.edit("sender", (sender) => (sender.archivedAt = "2026-06-20T00:00:00.000Z")),
      (s: Setup) =>
        s.edit("sender", (sender) => (sender.unarchivedAt = "2026-06-21T00:00:00.000Z")),
    ],
  ] as const)(
    "a waiting message is dropped when %s, and the owner's handle settles once",
    async (_label, withdraw, restore) => {
      const s = await setUp();
      const store = workspaceTurnManagerInternals(s.taskService).taskHandleStore;
      const upsert = spyOn(store, "upsertWorkspaceTurn");
      expect((await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "first")).success).toBe(
        true
      );
      const flushes = spyOn(
        s.taskService as unknown as { flushParkedPeerSends(targetId: string): Promise<void> },
        "flushParkedPeerSends"
      );
      await withdraw(s);
      await settle.completed(s);
      // The settlement's delivery attempt has finished before the restore below.
      expect(flushes).toHaveBeenCalled();
      await Promise.all(flushes.mock.results.map((result) => result.value as Promise<void>));
      expect(s.peerSends).toHaveLength(0);
      await restore(s);
      // Only a new message is delivered; the dropped one is never revived.
      const delivered = s.nextPeerSend();
      expect(
        (await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "second")).success
      ).toBe(true);
      await delivered;
      expect(s.peerSends).toHaveLength(1);
      expect(payloadText(s.peerSends[0])).toContain("second");
      expect(payloadText(s.peerSends[0])).not.toContain("first");

      // Exactly one active -> terminal transition of the owner's handle.
      const statuses = upsert.mock.calls
        .map(([record]) => record)
        .filter((record) => record.handleId === HANDLE_ID)
        .map((record) => record.status);
      const isTerminal = (status: string | undefined) =>
        status === "completed" || status === "error" || status === "interrupted";
      expect(
        statuses.filter((status, i) => isTerminal(status) && !isTerminal(statuses[i - 1]))
      ).toEqual(["completed"]);
      expect(await workspaceTurnSnapshot(s.taskService, s.parentId)).toMatchObject({
        status: "completed",
        messageId: "msg_done",
      });
      upsert.mockRestore();
      flushes.mockRestore();
    }
  );

  // A message that already waited is delivered once or dropped: it never joins a delegated turn
  // and never waits a second time. Each case interferes right as the waiting message is retried,
  // then proves with a later message that the first one is gone for good.
  async function retryWithInterference(
    s: Setup,
    interfere: (retry: (spec: unknown) => Promise<unknown>) => (spec: unknown) => Promise<unknown>
  ) {
    const internals = s.taskService as unknown as TaskServiceInternals;
    const original = internals.sendTreeMessage.bind(s.taskService);
    const retry = spyOn(internals, "sendTreeMessage").mockImplementationOnce(interfere(original));
    const flushes = spyOn(internals, "flushParkedPeerSends");
    await settle.completed(s);
    expect(retry).toHaveBeenCalled();
    await Promise.all(flushes.mock.results.map((result) => result.value as Promise<void>));
    retry.mockRestore();
    flushes.mockRestore();
  }

  async function expectOnlyLaterMessageDelivered(s: Setup, alreadyDelivered: number) {
    const delivered = s.peerSendCount(alreadyDelivered + 1);
    expect((await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "later")).success).toBe(
      true
    );
    await delivered;
    const texts = s.peerSends.map((args) => /first|later/.exec(payloadText(args))?.[0]);
    expect(texts.filter((text) => text === "first")).toHaveLength(alreadyDelivered);
    expect(texts.at(-1)).toBe("later");
  }

  test.each(["reserved", "accepted"] as const)(
    "a retry that meets a new %s delegated turn of its own sender is dropped, not correlated",
    async (source) => {
      const s = await setUp();
      expect((await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "first")).success).toBe(
        true
      );
      await retryWithInterference(s, (original) => async (spec) => {
        // The sender itself starts a delegated turn on the target just before the retry runs.
        await registerLiveWorkspaceTurnHandle(
          s.taskService,
          TARGET_ID,
          "wst_next",
          "sender",
          source
        );
        return original(spec);
      });
      expect(s.peerSends).toHaveLength(0);
      workspaceTurnManagerInternals(s.taskService).activeWorkspaceTurnHandleByWorkspaceId.delete(
        TARGET_ID
      );
      await expectOnlyLaterMessageDelivered(s, 0);
    }
  );

  test("a retry withdrawn by the recipient's queue is dropped, not parked again", async () => {
    const s = await setUp();
    expect((await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "first")).success).toBe(
      true
    );
    const delivered = s.nextPeerSend();
    await settle.completed(s);
    const [, , , internal] = await delivered;
    // Queued behind other work; another workspace's delegated turn starts before it dispatches,
    // and the queue's dispatch gate withdraws it (rows never written).
    await registerLiveWorkspaceTurnHandle(s.taskService, TARGET_ID, "wst_other", "owner-2");
    expect(internal?.admissionStale?.()).toBe(true);
    await internal?.onCanceled?.("stale");
    workspaceTurnManagerInternals(s.taskService).activeWorkspaceTurnHandleByWorkspaceId.delete(
      TARGET_ID
    );
    await expectOnlyLaterMessageDelivered(s, 1);
  });

  test("a user Stop and resume while a retry is in flight drops it", async () => {
    const s = await setUp();
    expect((await s.taskService.sendAgentTreeMessage("sender", TARGET_ID, "first")).success).toBe(
      true
    );
    await retryWithInterference(s, (original) => (spec) => {
      // The drain already took the message; the user stops and resumes the recipient before
      // the retry runs its checks.
      s.taskService.markParentWorkspaceInterrupted(TARGET_ID);
      s.taskService.resetAutoResumeCount(TARGET_ID);
      return original(spec);
    });
    expect(s.peerSends).toHaveLength(0);
    await expectOnlyLaterMessageDelivered(s, 0);
  });
});
