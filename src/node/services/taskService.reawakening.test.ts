import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { TaskHandleStore } from "@/node/services/taskHandleStore";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { Ok, Err, type Result } from "@/common/types/result";
import { formatSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import type { SendMessageError } from "@/common/types/errors";
import { createMuxMessage, type MuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveLocalParentWorkspace,
  saveWorkspaces,
  streamEnd,
  stubStableIds,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnMuxMetadata,
  workspaceTurnRecord,
  workspaceTurnSnapshot,
} from "@/node/services/taskService.testHarness";
import {
  collectFullHistory,
  createAgentTask,
  createTaskServiceHarness,
  flushTerminalAttentionDrains,
  registerLiveWorkspaceTurnHandle,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
  startWorkspaceTurnForTest,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  test("sendAgentTreeMessage rechecks hard interruption at admission after awaited lookups", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child-a", "child-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // Simulate the user's Stop landing DURING the awaited pre-send lookup (interruptStream
    // marks suppression without taking the target's event lock): the admission-time recheck
    // must cancel the send instead of restarting the stopped ancestor.
    const internals = workspaceTurnManagerFor(taskService) as unknown as {
      getActiveWorkspaceTurnMuxMetadataForWorkspace: (workspaceId: string) => Promise<null>;
    };
    internals.getActiveWorkspaceTurnMuxMetadataForWorkspace = (workspaceId) => {
      taskService.markParentWorkspaceInterrupted(workspaceId);
      return Promise.resolve(null);
    };

    expect(await taskService.sendAgentTreeMessage("child-a", "tree-root", "status?")).toEqual(
      Err({
        code: "refused",
        reason:
          "Target was interrupted by the user and will not accept agent messages until the user resumes it.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage carries the target's active workspace-turn correlation on the trigger", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child-a", "child-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // The root is executing a delegated workspace turn owned elsewhere: the trigger must keep
    // that correlation or the queued peer wake would settle the owner's turn as superseded.
    const turnMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wt-1",
      ownerWorkspaceId: "owner-1",
      turnId: "turn-1",
    };
    const internals = workspaceTurnManagerFor(taskService) as unknown as {
      getActiveWorkspaceTurnMuxMetadataForWorkspace: (
        workspaceId: string
      ) => Promise<typeof turnMetadata | null>;
    };
    internals.getActiveWorkspaceTurnMuxMetadataForWorkspace = (workspaceId) =>
      Promise.resolve(workspaceId === "tree-root" ? turnMetadata : null);

    const result = await taskService.sendAgentTreeMessage("child-a", "tree-root", "Blocked.");
    expect(result.success).toBe(true);
    const [, , options, internalArg] = sendMessage.mock.calls[0] as [
      string,
      string,
      { muxMetadata?: { type?: string; agentPeerMessageTrigger?: object } },
      { workspaceTurnContinuation?: boolean; preTurnMessages?: MuxMessage[] },
    ];
    // The correlation replaces peer attribution, so the nested attribution must survive it —
    // it keeps the UI rendering this row as a machine notification even if the correlation is
    // later stripped for a superseded continuation.
    expect(options.muxMetadata).toEqual({
      ...turnMetadata,
      agentPeerMessageTrigger: {
        fromWorkspaceId: "child-a",
        fromTitle: "child-a",
        relationship: "descendant",
      },
    });
    expect(internalArg.workspaceTurnContinuation).toBe(true);
    // Peer attribution stays on the assistant payload row.
    expect(internalArg.preTurnMessages?.[0]?.metadata?.muxMetadata?.type).toBe(
      "agent-peer-message"
    );
  });

  test("sendAgentTreeMessage honors active reawakened executions on both endpoints", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        // Reawakened persistent children: the stable taskStatus stays terminal (`reported`)
        // while the current execution runs under a workspace-turn handle mirror.
        projectWorkspace(projectPath, "sib-a", "sib-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_a",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_b",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // The execution mirror only counts when backed by a LIVE handle registration (a stale
    // mirror can outlive its handle after a crash or failed reconciliation).
    await registerLiveWorkspaceTurnHandle(taskService, "sib-a", "wst_a");
    await registerLiveWorkspaceTurnHandle(taskService, "sib-b", "wst_b");

    // Both endpoints are effectively executing: the reawakened sender may message peers, and
    // the reawakened target (advertised as running by task_list's execution overlay) accepts.
    const result = await taskService.sendAgentTreeMessage("sib-a", "sib-b", "sync up");
    expect(result).toEqual(
      Ok({ delivery: "queued", relation: "peer", queueDispatchMode: "tool-end" })
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("sendAgentTreeMessage refuses a stale running mirror without a live handle", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "sib-a", "sib-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Stale mirror: a crash between terminal handle persistence and the config mirror
        // write (or a failed startup reconciliation) can leave taskExecutionStatus="running"
        // on a stably reported task with no live handle. Admitting a send here would be
        // uncorrelated and would peer-reactivate the terminal task.
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_stale",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "hello")).toEqual(
      Err({
        code: "not_active",
        taskStatus: "reported",
        message: "Target is inactive; peer messages cannot reactivate it — ask its parent.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage refuses a reawakening reservation until the turn is accepted", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "sib-a", "sib-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Reawakening in flight: createWorkspaceTurn registers the handle and writes the
        // "running" mirror BEFORE its sendMessage passes turn admission. A peer send winning
        // this window could start the terminal child's only turn when the owner's requireIdle
        // send subsequently fails — a prohibited peer reactivation.
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_preaccept",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await registerLiveWorkspaceTurnHandle(
      taskService,
      "sib-b",
      "wst_preaccept",
      "tree-root",
      "reserved"
    );

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "hello")).toEqual(
      Err({
        code: "not_active",
        taskStatus: "reported",
        message: "Target is inactive; peer messages cannot reactivate it — ask its parent.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();

    // Once the owner's turn is admitted (onAccepted marks the registration accepted), the same
    // target accepts peer messages.
    await registerLiveWorkspaceTurnHandle(
      taskService,
      "sib-b",
      "wst_preaccept",
      "tree-root",
      "accepted"
    );
    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "hello again")).toEqual(
      Ok({ delivery: "queued", relation: "peer", queueDispatchMode: "tool-end" })
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("sendAgentTreeMessage refuses peer sends to queued reawakened executions", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "sib-a", "sib-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Reawakening turn queued behind existing activity: the new execution has not been
        // admitted, so its handle carries no correlation — a peer entry would cut or trail
        // the delegated replay as an unrelated generic turn (peer reactivation).
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_b",
          taskExecutionStatus: "queued",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "hello")).toEqual(
      Err({
        code: "not_active",
        taskStatus: "reported",
        message: "Target is inactive; peer messages cannot reactivate it — ask its parent.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage refuses at the admission probe when the sender is stopped mid-send", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const workspaces = (senderExecution: "running" | "interrupted") => [
      projectWorkspace(projectPath, "root", "tree-root"),
      // Reawakened persistent child: stable status stays `reported` while the current
      // execution runs under a workspace-turn handle mirror.
      projectWorkspace(projectPath, "sib-a", "sib-a", {
        parentWorkspaceId: "tree-root",
        taskStatus: "reported" as const,
        taskExecutionId: "wst_a",
        taskExecutionStatus: senderExecution,
      }),
      projectWorkspace(projectPath, "sib-b", "sib-b", {
        parentWorkspaceId: "tree-root",
        taskStatus: "running" as const,
      }),
    ];
    await saveWorkspaces(config, projectPath, workspaces("running"), testTaskSettings());

    // Simulate the sender's owner interrupting its workspace turn while the send is in
    // flight: interruptWorkspaceTurn marks the execution mirror terminal WITH the handle
    // transition (before stopStream), so the admission probe observes the stop and the
    // winding-down tool call cannot wake an idle peer.
    const sendMessage = mock(
      async (
        _targetId: string,
        _message: string,
        _options: unknown,
        internal: { admissionStale?: () => boolean }
      ) => {
        await saveWorkspaces(config, projectPath, workspaces("interrupted"), testTaskSettings());
        expect(internal.admissionStale?.()).toBe(true);
        return Err({ type: "unknown", raw: "send admission stale" });
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // Live handle registration lets the reawakened sender pass the ENTRY check; the mid-send
    // interruption is then only observable through the admission probe's mirror re-read.
    await registerLiveWorkspaceTurnHandle(taskService, "sib-a", "wst_a");

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "still there?")).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );
  });

  test("unconfirmed stream stop retains the latch for a completed descendant whose live execution the cascade could not settle", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "branch-a", "branch-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Reawakened completed child: the cascade preserves its terminal report, so it persists
        // neither an interrupted status nor a terminal execution mirror.
        projectWorkspace(projectPath, "leaf-a", "leaf-a", {
          parentWorkspaceId: "branch-a",
          taskStatus: "reported",
          taskExecutionId: "wst_leaf",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    // The child's stream cancellation fails (contained by the cascade): with the report
    // preserved, nothing admission-visible would mark the stop once the latch drops, so the
    // still-running child could message a cousin right after Stop.
    const { aiService } = createAIServiceMocks(config, {
      stopStream: mock((): Promise<Result<void>> => Promise.resolve(Err("cancel failed"))),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService, aiService });
    await registerLiveWorkspaceTurnHandle(taskService, "leaf-a", "wst_leaf");
    // The cascade settles the captured live execution itself (interruptCapturedExecution); this
    // models the fail-closed case where that explicit interrupt fails, so the record keeps
    // waiting for an authoritative settlement — the release mechanics under test.
    const interruptSpy = spyOn(
      workspaceTurnManagerFor(taskService),
      "interruptWorkspaceTurn"
    ).mockResolvedValueOnce(Err("interrupt unavailable"));

    taskService.markParentWorkspaceInterrupted("branch-a");
    await taskService.terminateAllDescendantAgentTasks("branch-a");
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    expect(interruptSpy.mock.calls[0].slice(0, 2)).toEqual(["tree-root", "wst_leaf"]);
    interruptSpy.mockRestore();
    expect(findWorkspaceInConfig(config, "leaf-a")?.taskStatus).toBe("reported");

    // User resume clears the level-triggered suppression; only the retained latch refuses.
    taskService.resetAutoResumeCount("branch-a");
    expect(
      await taskService.sendAgentTreeMessage("leaf-a", "sib-b", "escape the unconfirmed stop")
    ).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();

    // The retained latch is releasable, not permanent: authoritative terminal settlement of the
    // child's execution (here an explicit turn interrupt persisting the terminal mirror) must
    // free it — otherwise the child stays barred from peer messaging until restart even after
    // every admission-visible marker refuses on its own.
    const internals = taskService as unknown as {
      workspaceStopsInProgress: Map<string, number>;
    };
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(true);

    // A STALE handle settling for the same workspace is NOT settlement for the live execution:
    // the mirror still points at wst_leaf, so releasing here would let the still-running child
    // resume peer messaging with nothing admission-visible refusing it.
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord("tree-root", "leaf-a", "wst_stale", "running", {
        turnId: "wst_stale-turn",
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
      })
    );
    const staleInterrupt = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      "tree-root",
      "wst_stale"
    );
    expect(staleInterrupt.success).toBe(true);
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(true);

    const interrupted = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      "tree-root",
      "wst_leaf"
    );
    expect(interrupted.success).toBe(true);
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(false);
  });

  test("successful no-op stream stop still retains the latch for an unsettled PREPARING execution the cascade could not settle", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "branch-a", "branch-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Accepted-but-PREPARING reawakened child: the turn was admitted (accepted live handle,
        // running mirror) but no stream registered yet, so the cascade's stopStream no-ops with
        // SUCCESS while the prepared turn can still start afterward. Only terminal settlement
        // confirms the stop — the latch must be retained despite the successful stop call.
        projectWorkspace(projectPath, "leaf-a", "leaf-a", {
          parentWorkspaceId: "branch-a",
          taskStatus: "reported",
          taskExecutionId: "wst_leaf",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await registerLiveWorkspaceTurnHandle(taskService, "leaf-a", "wst_leaf");
    // See the unconfirmed-stop test above: the cascade's own explicit interrupt of the captured
    // execution fails here, leaving the record waiting for an authoritative settlement.
    const interruptSpy = spyOn(
      workspaceTurnManagerFor(taskService),
      "interruptWorkspaceTurn"
    ).mockResolvedValueOnce(Err("interrupt unavailable"));

    taskService.markParentWorkspaceInterrupted("branch-a");
    await taskService.terminateAllDescendantAgentTasks("branch-a");
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    interruptSpy.mockRestore();
    expect(findWorkspaceInConfig(config, "leaf-a")?.taskStatus).toBe("reported");

    const internals = taskService as unknown as { workspaceStopsInProgress: Map<string, number> };
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(true);

    // User resume clears the level-triggered suppression; only the retained latch refuses the
    // prepared turn's child until its execution settles.
    taskService.resetAutoResumeCount("branch-a");
    expect(
      await taskService.sendAgentTreeMessage("leaf-a", "sib-b", "escape the preparing stop")
    ).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();

    // Terminal settlement of the prepared execution releases the retained latch.
    const interrupted = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      "tree-root",
      "wst_leaf"
    );
    expect(interrupted.success).toBe(true);
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(false);
  });

  test("settlement with a swallowed mirror write still refuses peer sends via registration removal", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "branch-a", "branch-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "leaf-a", "leaf-a", {
          parentWorkspaceId: "branch-a",
          taskStatus: "reported",
          taskExecutionId: "wst_leaf",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await registerLiveWorkspaceTurnHandle(taskService, "leaf-a", "wst_leaf");

    // Establish a retained latch (accepted-but-unsettled live execution under a hard stop whose
    // own explicit interrupt of that execution failed; see the unconfirmed-stop test).
    const interruptSpy = spyOn(
      workspaceTurnManagerFor(taskService),
      "interruptWorkspaceTurn"
    ).mockResolvedValueOnce(Err("interrupt unavailable"));
    taskService.markParentWorkspaceInterrupted("branch-a");
    await taskService.terminateAllDescendantAgentTasks("branch-a");
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    interruptSpy.mockRestore();
    const internals = taskService as unknown as {
      workspaceStopsInProgress: Map<string, number>;
    };
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(true);

    // Settlement's terminal mirror write is SWALLOWED (Config.saveConfig logs and drops write
    // errors), so the on-disk mirror keeps claiming "running". Releasing the latch on the
    // unverified write must therefore be accompanied by removing the live registration in the
    // same tick — otherwise a peer admission probe in the pre-caller-delete window sees the
    // stale running mirror plus the accepted handle and escapes the stop.
    const saveSpy = spyOn(
      config as unknown as { saveConfig: (config: unknown) => Promise<void> },
      "saveConfig"
    ).mockImplementation(() => Promise.resolve());
    await workspaceTurnManagerFor(taskService).updateAgentTaskExecutionState(
      "leaf-a",
      "wst_leaf",
      "interrupted"
    );
    saveSpy.mockRestore();

    // The stale mirror really is still on disk...
    expect(findWorkspaceInConfig(config, "leaf-a")?.taskExecutionStatus).toBe("running");
    // ...but the registration is gone and the latch released: admission refuses on its own.
    expect(
      workspaceTurnManagerFor(taskService).getLiveWorkspaceTurnRegistration("leaf-a")
    ).toBeUndefined();
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(false);

    taskService.resetAutoResumeCount("branch-a");
    expect(
      await taskService.sendAgentTreeMessage("leaf-a", "sib-b", "escape via stale mirror")
    ).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("a parent Stop cascade settles a completed descendant's live continuation itself and releases the latch", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "branch-a", "branch-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Reawakened completed child under an ancestor-owned continuation: its stable status is
        // preserved, so only the execution mirror can carry the stop.
        projectWorkspace(projectPath, "leaf-a", "leaf-a", {
          parentWorkspaceId: "branch-a",
          taskStatus: "reported",
          taskExecutionId: "wst_leaf",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { aiService, stopStream } = createAIServiceMocks(config);
    const { taskService } = createTaskServiceHarness(config, { workspaceService, aiService });
    await registerLiveWorkspaceTurnHandle(taskService, "leaf-a", "wst_leaf");

    taskService.markParentWorkspaceInterrupted("branch-a");
    await taskService.terminateAllDescendantAgentTasks("branch-a");

    // The cascade's stream stop is a "system" abort, which never settles a continuation handle,
    // so the cascade interrupts the captured execution explicitly: handle and mirror read
    // interrupted, the live registration is gone, and the stream stop still ran for the child.
    expect(findWorkspaceInConfig(config, "leaf-a")).toMatchObject({
      taskStatus: "reported",
      taskExecutionId: "wst_leaf",
      taskExecutionStatus: "interrupted",
    });
    expect(await workspaceTurnSnapshot(taskService, "tree-root", "wst_leaf")).toMatchObject({
      status: "interrupted",
    });
    const internals = taskService as unknown as {
      workspaceStopsInProgress: Map<string, number>;
    };
    expect(
      workspaceTurnManagerFor(taskService).getLiveWorkspaceTurnRegistration("leaf-a")
    ).toBeUndefined();
    expect(stopStream).toHaveBeenCalledWith(
      "leaf-a",
      expect.objectContaining({ abandonPartial: false })
    );
    // No owner left to settle: the latch releases with the cascade instead of at restart.
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(false);
    // The owner's terminal wake for the handle its own Stop interrupted is suppressed (same as
    // task_stop), so a restart cannot resurrect it as a wake-up.
    const attention = await new TerminalAttentionStore(config).get(
      "tree-root",
      TerminalAttentionStore.notificationId("workspace_turn", "wst_leaf")
    );
    expect(attention).toMatchObject({ terminalOutcome: "interrupted", status: "superseded" });
  });

  test("park-after-settlement race releases the latch on already-settled evidence", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "branch-a", "branch-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Mid-settlement snapshot: a racing settlement already persisted the terminal mirror
        // (and ran its retained-latch release) but has not yet deleted the live handle entry.
        // The cascade's park lands AFTER the only settlement callback — without the post-park
        // recheck the latch would hold until restart even though the persisted mirror already
        // refuses peer sends on its own.
        projectWorkspace(projectPath, "leaf-a", "leaf-a", {
          parentWorkspaceId: "branch-a",
          taskStatus: "reported",
          taskExecutionId: "wst_leaf",
          taskExecutionStatus: "interrupted",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { aiService } = createAIServiceMocks(config, {
      stopStream: mock((): Promise<Result<void>> => Promise.resolve(Err("cancel failed"))),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService, aiService });
    await registerLiveWorkspaceTurnHandle(taskService, "leaf-a", "wst_leaf");

    taskService.markParentWorkspaceInterrupted("branch-a");
    await taskService.terminateAllDescendantAgentTasks("branch-a");

    const internals = taskService as unknown as { workspaceStopsInProgress: Map<string, number> };
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(false);
  });

  test("sendAgentTreeMessage refuses root sends while an interrupted workspace turn winds down", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child-a", "child-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    // task_stop on a delegated workspace turn whose target is the tree ROOT: the root has no
    // task lifecycle status to refuse on, so during the stopStream wind-down only the held
    // latch keeps an upward send from queueing behind the dying stream and auto-dispatching
    // when it ends — which would defeat the stop.
    let markStopStarted: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve;
    });
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopStream = mock(async (workspaceId: string) => {
      if (workspaceId === "tree-root") {
        markStopStarted?.();
        await stopGate;
      }
      return Ok(undefined);
    });
    const { aiService } = createAIServiceMocks(config, { stopStream });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    await registerLiveWorkspaceTurnHandle(taskService, "tree-root", "wst_root_turn", "owner-ws");

    const interrupting = workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      "owner-ws",
      "wst_root_turn"
    );
    await stopStarted;

    expect(await taskService.sendAgentTreeMessage("child-a", "tree-root", "wake the root")).toEqual(
      Err({
        code: "refused",
        reason:
          "Target was interrupted by the user and will not accept agent messages until the user resumes it.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();

    releaseStop?.();
    expect(await interrupting).toEqual(Ok({ workspaceId: "tree-root" }));
    // Once the stop settles, the idle root accepts peer messages again (fresh turn on delivery).
    expect(
      await taskService.sendAgentTreeMessage("child-a", "tree-root", "after the stop")
    ).toEqual(
      Ok({ delivery: "queued", relation: "target_ancestor", queueDispatchMode: "turn-end" })
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("sendAgentTreeMessage withholds correlation from unaccepted workspace-turn registrations", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child-a", "child-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // Creation-time reservation on the ROOT: the record is persisted as running BEFORE the
    // owner's requireIdle send passes admission. Correlating a peer trigger with it would let
    // that trigger's stream-end settle the owner's unaccepted handle as the delegated result.
    await registerLiveWorkspaceTurnHandle(
      taskService,
      "tree-root",
      "wst_unaccepted_corr",
      "owner-ws",
      "reserved"
    );

    expect(await taskService.sendAgentTreeMessage("child-a", "tree-root", "status?")).toEqual(
      Ok({ delivery: "queued", relation: "target_ancestor", queueDispatchMode: "turn-end" })
    );
    const [, , options, internalArg] = sendMessage.mock.calls[0] as [
      string,
      string,
      { muxMetadata?: { type?: string } },
      { workspaceTurnContinuation?: boolean },
    ];
    expect(options.muxMetadata?.type).toBe("agent-peer-message");
    expect(internalArg.workspaceTurnContinuation).toBe(false);

    // Once the owner's turn is admitted, the same registration correlates again.
    await registerLiveWorkspaceTurnHandle(
      taskService,
      "tree-root",
      "wst_unaccepted_corr",
      "owner-ws",
      "accepted"
    );
    expect(
      (await taskService.sendAgentTreeMessage("child-a", "tree-root", "second update")).success
    ).toBe(true);
    const [, , secondOptions, secondInternal] = sendMessage.mock.calls[1] as [
      string,
      string,
      { muxMetadata?: { type?: string } },
      { workspaceTurnContinuation?: boolean },
    ];
    expect(secondOptions.muxMetadata?.type).toBe("workspace-turn-task");
    expect(secondInternal.workspaceTurnContinuation).toBe(true);
  });

  test("listTaskTreeAgents strips stale execution overlays from peer rows", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "a", "task-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Stale persisted mirror: taskExecutionStatus survived a crash/failed reconciliation
        // with no live handle. Peer admission refuses this target, so sibling discovery must
        // keep its stable terminal status instead of advertising a running overlay.
        projectWorkspace(projectPath, "b", "task-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_stale_overlay",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { taskService } = createTaskServiceHarness(config);

    const stale = taskService
      .listTaskTreeAgents("task-a")
      .tasks.find((task) => task.taskId === "task-b");
    expect(stale?.relationship).toBe("sibling");
    expect(stale?.status).toBe("reported");
    expect(stale?.executionStatus).toBeUndefined();
    expect(stale?.executionTaskId).toBeUndefined();

    // Backed by an ACCEPTED live handle (the same predicate peer admission uses), the overlay
    // is advertised again.
    await registerLiveWorkspaceTurnHandle(taskService, "task-b", "wst_stale_overlay");
    const live = taskService
      .listTaskTreeAgents("task-a")
      .tasks.find((task) => task.taskId === "task-b");
    expect(live?.executionStatus).toBe("running");
    expect(live?.executionTaskId).toBe("wst_stale_overlay");

    // A pre-acceptance reservation is not live for peers either.
    await registerLiveWorkspaceTurnHandle(
      taskService,
      "task-b",
      "wst_stale_overlay",
      "tree-root",
      "recovered"
    );
    const reserved = taskService
      .listTaskTreeAgents("task-a")
      .tasks.find((task) => task.taskId === "task-b");
    expect(reserved?.executionStatus).toBeUndefined();
  });

  test("sendMessageToDescendantAgentTask reawakens legacy archived descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-archived-guidance";
    const intermediateTaskId = "intermediate-archived-guidance";
    const childTaskId = "child-archived-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "intermediate", intermediateTaskId, {
          parentWorkspaceId,
          taskStatus: "reported",
          archivedAt: "2026-08-03T00:00:00.000Z",
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId: intermediateTaskId,
          taskStatus: "reported",
          archivedAt: "2026-08-03T00:00:00.000Z",
        }),
      ],
      testTaskSettings()
    );

    const unarchive = mock(async (workspaceId: string): Promise<Result<void>> => {
      await config.editConfig((cfg) => {
        const workspace = Array.from(cfg.projects.values())
          .flatMap((project) => project.workspaces)
          .find((candidate) => candidate.id === workspaceId);
        if (workspace) workspace.unarchivedAt = "2026-08-10T00:00:00.000Z";
        return cfg;
      });
      return Ok(undefined);
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      unarchiveWhileTaskTreeLocked: unarchive,
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Correction",
      "tool-end"
    );
    expect(reactivated.success).toBe(true);
    if (!reactivated.success) return;
    expect(reactivated.data.delivery).toBe("reactivated");
    expect(reactivated.data.executionTaskId).toMatch(/^wst_/);
    expect(unarchive.mock.calls.map((call) => call[0])).toEqual([intermediateTaskId, childTaskId]);
    expect(sendMessage).toHaveBeenCalled();
  });

  test("sendMessageToDescendantAgentTask rejects non-descendants and settled children", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-guidance-scope";
    const otherParentId = "other-guidance-scope";
    const otherChildId = "other-child-guidance-scope";
    const settledChildId = "settled-child-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "other-parent", otherParentId),
        projectWorkspace(projectPath, "other-child", otherChildId, {
          parentWorkspaceId: otherParentId,
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "settled-child", settledChildId, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId,
          taskStatus: "reported",
          title: "React lifecycle expert",
        }),
      ],
      testTaskSettings()
    );

    const { taskService } = createTaskServiceHarness(config);

    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        otherChildId,
        "Correction",
        "tool-end"
      )
    ).toEqual(Err({ code: "invalid_scope" }));
    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      settledChildId,
      "Correction",
      "tool-end"
    );
    expect(reactivated.success).toBe(true);
    if (!reactivated.success) return;
    expect(reactivated.data.delivery).toBe("reactivated");
    const executionTaskId = reactivated.data.executionTaskId;
    assert(executionTaskId != null, "reactivated execution ID is required");
    const execution = await workspaceTurnSnapshot(taskService, parentWorkspaceId, executionTaskId);
    expect(execution?.title).toBe("React lifecycle expert");
    expect(reactivated.data.executionTaskId).toMatch(/^wst_/);
  });

  test("a bash-monitor wake reawakens an inactive child under a parent-owned continuation and re-admits agent_report", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-wake-reactivation";
    const childTaskId = "child-wake-reactivation";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId,
          taskStatus: "reported",
          reportedAt: "2026-09-09T17:44:35.884Z",
          title: "UAT Critic",
        }),
      ],
      testTaskSettings()
    );
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const wakeSend = mock(
      async (
        ...args: Parameters<WorkspaceHost["sendMessage"]>
      ): ReturnType<WorkspaceHost["sendMessage"]> => {
        await args[3]?.onAccepted?.();
        return Ok(undefined);
      }
    );

    // Before reactivation the child is done from the parent's perspective: a late report is refused.
    let staleReportError: unknown;
    try {
      await taskService.reportAgentProgress(childTaskId, "call-stale", { reportMarkdown: "late" });
    } catch (error: unknown) {
      staleReportError = error;
    }
    assert(staleReportError instanceof Error, "a report from an inactive child should be refused");
    expect(staleReportError.message).toBe(
      "agent_report cannot send updates after the sub-agent has completed"
    );

    const outcome = await taskService.reactivateInactiveAgentTaskFromBashMonitorWake(
      childTaskId,
      "A background bash monitor matched output.",
      wakeSend
    );

    expect(outcome).toEqual(Ok(undefined));
    // The wake's own sender dispatched the continuation prompt; the host send never ran for it.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wakeSend).toHaveBeenCalledTimes(1);
    const [targetId, prompt, options] = wakeSend.mock.calls[0];
    expect(targetId).toBe(childTaskId);
    expect(prompt).toBe("A background bash monitor matched output.");
    const child = findWorkspaceInConfig(config, childTaskId);
    const executionTaskId = child?.taskExecutionId;
    assert(executionTaskId != null, "reactivated execution ID is required");
    expect(executionTaskId).toMatch(/^wst_/);
    expect(child?.taskExecutionStatus).toBe("running");
    const execution = await workspaceTurnSnapshot(taskService, parentWorkspaceId, executionTaskId);
    expect(execution).toMatchObject({
      status: "running",
      title: "UAT Critic",
      attentionPolicy: "notify_on_terminal",
      prompt: "A background bash monitor matched output.",
    });
    expect(options.muxMetadata).toEqual({
      type: "workspace-turn-task",
      taskHandleId: executionTaskId,
      ownerWorkspaceId: parentWorkspaceId,
      turnId: execution?.turnId,
    });

    // The resumed turn's reports reach the parent again.
    await taskService.reportAgentProgress(childTaskId, "call-verdict", {
      reportMarkdown: "Verdict: FAIL",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe(parentWorkspaceId);
    expect(sendMessage.mock.calls[0][1]).toContain("Verdict: FAIL");
  });

  test("a bash-monitor wake leaves non-children, running children, and live continuations to the plain wake", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-wake-passthrough";
    const runningChildId = "running-child-wake-passthrough";
    const reawakenedChildId = "reawakened-child-wake-passthrough";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "running-child", runningChildId, {
          parentWorkspaceId,
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "reawakened-child", reawakenedChildId, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId,
          taskStatus: "reported",
        }),
      ],
      testTaskSettings()
    );
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const wakeSend = mock(
      (): ReturnType<WorkspaceHost["sendMessage"]> => Promise.resolve(Ok(undefined))
    );

    // A parent-initiated reawakening leaves this child with a live continuation.
    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      reawakenedChildId,
      "Correction",
      "tool-end"
    );
    expect(reactivated).toMatchObject({ success: true, data: { delivery: "reactivated" } });

    for (const workspaceId of [parentWorkspaceId, runningChildId, reawakenedChildId]) {
      expect(
        await taskService.reactivateInactiveAgentTaskFromBashMonitorWake(
          workspaceId,
          "wake",
          wakeSend
        )
      ).toBeNull();
    }
    expect(wakeSend).not.toHaveBeenCalled();
  });

  test("reawakening a stopped queued child replays its preserved initial brief", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["queuedreplayhandle", "queuedreplayturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-queued-replay";
    const childTaskId = "child-queued-replay";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskPrompt: "Inspect the original queued assignment.",
          title: "Queued task expert",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Also verify the regression tests.",
      "tool-end"
    );

    expect(result).toMatchObject({
      success: true,
      data: { delivery: "reactivated", executionTaskId: "wst_queuedreplayhandle" },
    });
    expect(sendMessage.mock.calls[0]?.[1]).toBe(
      "Inspect the original queued assignment.\n\nUpdated guidance from parent:\n\nAlso verify the regression tests."
    );
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPrompt).toBeUndefined();
  });

  test("higher ancestors steer a nested active continuation without reawakening it again", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-nested-active-guidance";
    const parentTaskId = "parent-nested-active-guidance";
    const childTaskId = "child-nested-active-guidance";
    const executionTaskId = "wst_nested_active_guidance";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent", parentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          taskStatus: "reported",
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentTaskId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          taskExecutionId: executionTaskId,
          taskExecutionStatus: "queued",
          taskModelString: "anthropic:claude-sonnet-4-6",
          taskThinkingLevel: "low",
          aiSettingsByAgent: {
            explore: {
              model: "openai:gpt-5.6-sol",
              thinkingLevel: "high",
              reasoningMode: "pro",
            },
          },
          title: "React lifecycle expert",
        }),
      ],
      testTaskSettings()
    );
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === childTaskId
    );
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      hasPendingQueuedOrPreparingTurn,
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentTaskId, childTaskId, executionTaskId, "queued", {
        turnId: "turn-nested-active-guidance",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
      })
    );

    expect(
      await taskService.sendMessageToDescendantAgentTask(
        rootWorkspaceId,
        childTaskId,
        "Keep investigating the existing continuation.",
        "tool-end"
      )
    ).toEqual(Ok({ delivery: "queued", queueDispatchMode: "tool-end" }));

    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionId).toBe(executionTaskId);
    expect(await taskHandleStore.listAllWorkspaceTurns()).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      model: "openai:gpt-5.6-sol",
      agentId: "explore",
      thinkingLevel: "high",
      reasoningMode: "pro",
    });
  });

  test.each([
    ["tool-end", "report"],
    ["turn-end", "report"],
    ["tool-end", "canceled"],
    ["tool-end", "failed"],
  ] as const)(
    "parent guidance preserves a reawakened child's execution through %s dispatch (%s)",
    async (queueDispatchMode, outcome) => {
      const config = await createTestConfig(rootDir);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      const childTaskId = "child-parent-guidance";
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project);
        project.workspaces.push(
          projectWorkspace(projectPath, "child", childTaskId, {
            runtimeConfig: { type: "local" },
            parentWorkspaceId: parentId,
            agentId: "explore",
            agentType: "explore",
            taskStatus: "reported",
            title: "Reviewer",
          })
        );
        return cfg;
      });
      type SendArgs = Parameters<WorkspaceHost["sendMessage"]>;
      let pendingGuidance: SendArgs | undefined;
      let initialSend: SendArgs | undefined;
      const sendMessage = mock(async (...args: SendArgs): Promise<Result<void>> => {
        if (args[0] === childTaskId) {
          if (initialSend != null) {
            pendingGuidance = args;
            return Ok(undefined);
          }
          initialSend = args;
        }
        await args[3]?.onAccepted?.();
        return Ok(undefined);
      });
      const { workspaceService } = createWorkspaceServiceMocks({
        sendMessage,
        hasPendingQueuedOrPreparingTurn: mock(() => pendingGuidance != null),
        hasPendingWorkspaceTurnContinuation: mock(
          (_workspaceId: string, metadata: unknown) =>
            pendingGuidance != null &&
            JSON.stringify(pendingGuidance[2]?.muxMetadata) === JSON.stringify(metadata)
        ),
      });
      const { taskService, historyService } = createTaskServiceHarness(config, {
        workspaceService,
      });
      const reactivated = await taskService.sendMessageToDescendantAgentTask(
        parentId,
        childTaskId,
        "Review the changes.",
        "tool-end"
      );
      assert(reactivated.success && reactivated.data.delivery === "reactivated");
      const handleId = reactivated.data.executionTaskId;
      assert(handleId);
      assert(initialSend);
      const initialMetadata = initialSend[2]?.muxMetadata as MuxMessageMetadata | undefined;
      expect(
        await taskService.sendMessageToDescendantAgentTask(
          parentId,
          childTaskId,
          "Also check lifecycle behavior.",
          queueDispatchMode
        )
      ).toEqual(Ok({ delivery: "queued", queueDispatchMode }));

      // Drive the real settlement path using correlation captured at the send boundary,
      // not a hand-authored continuation that would hide a missing metadata regression.
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: childTaskId,
        messageId: "before-parent-guidance",
        metadata: {
          model: "anthropic:claude-sonnet-4-6",
          finishReason: queueDispatchMode === "tool-end" ? "tool-calls" : "stop",
          muxMetadata: initialMetadata,
        },
        parts: [{ type: "text", text: "Initial review" }],
      });
      await flushTerminalAttentionDrains(taskService);
      expect(await workspaceTurnSnapshot(taskService, parentId, handleId)).toMatchObject({
        status: "running",
      });
      const parentBeforeReport = await collectFullHistory(historyService, parentId);
      expect(JSON.stringify(parentBeforeReport)).not.toContain("<mux_subagent_failure>");
      expect(JSON.stringify(parentBeforeReport)).not.toContain("<mux_subagent_report>");

      assert(pendingGuidance);
      const guidance = pendingGuidance;
      pendingGuidance = undefined;
      if (outcome !== "report") {
        const reason = "Guidance could not run";
        if (outcome === "canceled") {
          assert(guidance[3]?.onCanceled);
          await guidance[3].onCanceled(reason);
        } else {
          assert(guidance[3]?.onAcceptedPreStreamFailure);
          await guidance[3].onAcceptedPreStreamFailure({ type: "unknown", raw: reason });
        }
        expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toBeUndefined();
        expect(await workspaceTurnSnapshot(taskService, parentId, handleId)).toMatchObject({
          status: outcome === "canceled" ? "interrupted" : "error",
          error: reason,
        });
        const failure: unknown = await workspaceTurnManagerFor(taskService)
          .waitForWorkspaceTurn(handleId, {
            requestingWorkspaceId: parentId,
            timeoutMs: 100,
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(failure).toEqual(new Error(reason));
        await flushTerminalAttentionDrains(taskService);
        return;
      }
      await guidance[3]?.onAccepted?.();
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: childTaskId,
        messageId: "after-parent-guidance",
        metadata: {
          model: "anthropic:claude-sonnet-4-6",
          finishReason: "stop",
          muxMetadata: guidance[2]?.muxMetadata as MuxMessageMetadata | undefined,
        },
        parts: [{ type: "text", text: "Reviewed changes and lifecycle behavior." }],
      });
      await flushTerminalAttentionDrains(taskService);
      const execution = await taskService.getDescendantAgentTaskExecutionSnapshot(
        parentId,
        childTaskId
      );
      assert(execution);
      expect(
        await workspaceTurnManagerFor(taskService).waitForWorkspaceTurn(execution.record.handleId, {
          requestingWorkspaceId: parentId,
          ownerWorkspaceId: execution.ownerWorkspaceId,
          timeoutMs: 100,
        })
      ).toMatchObject({ reportMarkdown: "Reviewed changes and lifecycle behavior." });
      const parentHistory = JSON.stringify(await collectFullHistory(historyService, parentId));
      expect(parentHistory).not.toContain("<mux_subagent_failure>");
      expect(parentHistory.match(/<mux_subagent_report>/g)).toHaveLength(1);
    }
  );

  test("reactivated children can report progress while retaining their completed task status", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["reactivatehandle", "reactivateturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-reactivated-progress";
    const childTaskId = "child-reactivated-progress";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "React lifecycle expert",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Investigate the new regression.",
      "tool-end"
    );
    expect(reactivated.success).toBe(true);
    expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("reported");
    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionStatus).toBe("running");

    await taskService.reportAgentProgress(childTaskId, "progress-call", {
      reportMarkdown: "The regression is in the effect cleanup path.",
    });
    const progressSend = sendMessage.mock.calls.find(
      (call) =>
        call[0] === parentWorkspaceId &&
        typeof call[1] === "string" &&
        call[1].includes("effect cleanup path")
    );
    assert(progressSend, "progress report must wake the continuation owner");
    // Execution-scoped key: this continuation's settlement drops exactly its own queued
    // updates, and the report may overtake hidden turn-end predecessors in the owner's queue.
    expect(progressSend[3]).toMatchObject({
      queueDedupeKey: `agent-report:${childTaskId}:wst_reactivatehandle:progress-call`,
      removableQueueDedupeKey: true,
      promoteAheadOfHiddenTurnEnd: true,
    });
  });

  test("continuation settlement drops that execution's queued progress before waiters resolve", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["settlehandle", "settleturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-settled-progress";
    const childTaskId = "child-settled-progress";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "Mobile UI Engineer",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const removeQueuedMessagesByDedupeKeyPrefix = mock((): Result<number> => Ok(1));
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage,
      removeQueuedMessagesByDedupeKeyPrefix,
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Implement the transcript refinements.",
      "tool-end"
    );
    expect(reactivated.success).toBe(true);
    const handleId = "wst_settlehandle";
    const taskHandleStore = new TaskHandleStore(config);
    const activeRecord = await taskHandleStore.getWorkspaceTurn(parentWorkspaceId, handleId);
    assert(activeRecord, "reactivated workspace-turn record is required");

    await taskService.reportAgentProgress(childTaskId, "progress-call", {
      reportMarkdown: "Transcript rendering implemented; validating.",
    });
    const progressSend = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("Transcript rendering implemented")
    );
    const superseded = (progressSend?.[3] as { admissionStale?: () => boolean } | undefined)
      ?.admissionStale;
    assert(superseded, "progress sends must carry a supersession probe");
    // Live execution: an entry still in PREPARING is admitted.
    expect(superseded()).toBe(false);
    // A successor generation that has claimed the execution mirror supersedes it as well.
    await config.editConfig((cfg) => {
      const workspace = cfg.projects
        .get(projectPath)
        ?.workspaces.find((candidate) => candidate.id === childTaskId);
      assert(workspace, "child workspace must exist");
      workspace.taskExecutionId = "wst_successor";
      workspace.taskExecutionStatus = "running";
      return cfg;
    });
    expect(superseded()).toBe(true);
    await config.editConfig((cfg) => {
      const workspace = cfg.projects
        .get(projectPath)
        ?.workspaces.find((candidate) => candidate.id === childTaskId);
      assert(workspace, "child workspace must exist");
      workspace.taskExecutionId = handleId;
      workspace.taskExecutionStatus = "running";
      return cfg;
    });
    expect(superseded()).toBe(false);

    let removalsWhenWaiterResolved = -1;
    const waiter = workspaceTurnManagerFor(taskService)
      .waitForWorkspaceTurn(handleId, {
        requestingWorkspaceId: parentWorkspaceId,
        ownerWorkspaceId: parentWorkspaceId,
        timeoutMs: 5_000,
      })
      .then((result) => {
        removalsWhenWaiterResolved = removeQueuedMessagesByDedupeKeyPrefix.mock.calls.length;
        return result;
      });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "reactivated-final",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(parentWorkspaceId, handleId, activeRecord.turnId),
      },
      parts: [{ type: "text", text: "Committed the transcript refinements." }],
    });

    expect(await waiter).toMatchObject({ reportMarkdown: "Committed the transcript refinements." });
    expect(removeQueuedMessagesByDedupeKeyPrefix).toHaveBeenCalledWith(
      parentWorkspaceId,
      `agent-report:${childTaskId}:${handleId}:`,
      {
        cancelReason: "Incremental sub-agent update superseded by the terminal report.",
        skipCancelCallbacks: true,
      }
    );
    // A parent whose task_await just returned must not be cut by a now-stale update.
    expect(removalsWhenWaiterResolved).toBe(
      removeQueuedMessagesByDedupeKeyPrefix.mock.calls.length
    );
    // An update that had already left the queue for PREPARING is refused at admission instead.
    expect(superseded()).toBe(true);
  });

  test("reawakened child stays active through compaction and settles from its correlated follow-up", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["compactionhandle", "compactionturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-reactivated-compaction";
    const childTaskId = "child-reactivated-compaction";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "Compaction specialist",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Continue after compacting the prior context.",
      "tool-end"
    );
    expect(reactivated).toMatchObject({
      success: true,
      data: { delivery: "reactivated", executionTaskId: "wst_compactionhandle" },
    });
    const handleId = "wst_compactionhandle";
    const taskHandleStore = new TaskHandleStore(config);
    const activeRecord = await taskHandleStore.getWorkspaceTurn(parentWorkspaceId, handleId);
    assert(activeRecord, "reactivated workspace-turn record is required");

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "reactivated-compaction-summary",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "compact",
        mode: "compact",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Compacted specialist context" }],
    });

    expect(await workspaceTurnSnapshot(taskService, parentWorkspaceId, handleId)).toMatchObject({
      status: "running",
      workspaceId: childTaskId,
    });
    expect(findWorkspaceInConfig(config, childTaskId)).toMatchObject({
      taskStatus: "reported",
      taskExecutionId: handleId,
      taskExecutionStatus: "running",
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "reactivated-post-compaction-result",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(parentWorkspaceId, handleId, activeRecord.turnId),
      },
      parts: [{ type: "text", text: "Post-compaction result" }],
    });

    expect(await workspaceTurnSnapshot(taskService, parentWorkspaceId, handleId)).toMatchObject({
      status: "completed",
      workspaceId: childTaskId,
      messageId: "reactivated-post-compaction-result",
      reportMarkdown: "Post-compaction result",
    });
    expect(findWorkspaceInConfig(config, childTaskId)).toMatchObject({
      taskStatus: "reported",
      taskExecutionId: handleId,
      taskExecutionStatus: "completed",
    });
  });

  test("concurrent inactive-child messages create only one continuation execution", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["singlehandle", "singleturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-concurrent-reactivation";
    const childTaskId = "child-concurrent-reactivation";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "API reliability expert",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const results = await Promise.all([
      taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Check the retry path.",
        "tool-end"
      ),
      taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Also inspect timeout handling.",
        "tool-end"
      ),
    ]);

    expect(
      results.filter((result) => result.success && result.data.delivery === "reactivated")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.success && result.data.delivery !== "reactivated")
    ).toHaveLength(1);
    expect(
      await workspaceTurnManagerFor(taskService).listWorkspaceTurnTasks(parentWorkspaceId)
    ).toHaveLength(1);
  });

  test("reawakened terminal agents with active continuations can create children", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["afterinterrupted", "afterreporteda", "afterreportedb"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-reawakened-create";
    const interruptedTaskId = "child-interrupted-reawakened-create";
    const reportedTaskId = "child-reported-reawakened-create";
    const activeSiblingId = "sibling-reawakened-create";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "interrupted", interruptedTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskExecutionId: "wst_interrupted_reawakened_create",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "reported", reportedTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-11T00:00:00.000Z",
          taskExecutionId: "wst_reported_reawakened_create",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "sibling", activeSiblingId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      { ...testTaskSettings(), maxParallelAgentTasks: 1 }
    );
    const { taskService } = createTaskServiceHarness(config);

    const afterInterrupted = await createAgentTask(
      taskService,
      interruptedTaskId,
      "Delegate from the stopped continuation"
    );
    const afterReported = await createAgentTask(
      taskService,
      reportedTaskId,
      "Delegate from the reported continuation"
    );
    const bulkAfterReported = await taskService.createMany([
      {
        parentWorkspaceId: reportedTaskId,
        kind: "agent",
        agentId: "explore",
        prompt: "Delegate a workflow worker from the reported continuation",
        title: "Nested workflow worker",
      },
    ]);

    expect(afterInterrupted).toMatchObject({ success: true, data: { status: "queued" } });
    expect(afterReported).toMatchObject({ success: true, data: { status: "queued" } });
    expect(bulkAfterReported).toMatchObject({
      success: true,
      data: [{ status: "queued" }],
    });
    const nestedTasks = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .filter(
        (workspace) =>
          workspace.parentWorkspaceId === interruptedTaskId ||
          workspace.parentWorkspaceId === reportedTaskId
      );
    expect(nestedTasks).toHaveLength(3);
    expect(nestedTasks.every((workspace) => workspace.taskStatus === "queued")).toBe(true);
  });

  test("does not accept agent_report while task-owned workspace turns are still active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const workspaceTurnId = "workspace-turn-child";
    const workspaceTurnHandleId = "wst_childturn";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await registerLiveWorkspaceTurnHandle(
      taskService,
      workspaceTurnId,
      workspaceTurnHandleId,
      parentTaskId,
      "reserved",
      {
        turnId: "turn-1",
        updatedAt: "2026-06-19T00:00:00.000Z",
        createdWorkspace: true,
        createdAt: "2026-06-19T00:00:00.000Z",
      }
    );

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Premature report", title: "Too early" },
          state: "output-available",
          output: { success: true },
        },
      ],
    });

    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      parentTaskId,
      expect.stringContaining(workspaceTurnHandleId),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("does not force await or report while task-owned notify_on_terminal workspace turns are active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const workspaceTurnId = "workspace-turn-child";
    const workspaceTurnHandleId = "wst_childturn_notify";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await registerLiveWorkspaceTurnHandle(
      taskService,
      workspaceTurnId,
      workspaceTurnHandleId,
      parentTaskId,
      "reserved",
      {
        turnId: "turn-1",
        updatedAt: "2026-06-19T00:00:00.000Z",
        createdWorkspace: true,
        attentionPolicy: "notify_on_terminal",
        createdAt: "2026-06-19T00:00:00.000Z",
      }
    );

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const ws = findWorkspaceInConfig(config, parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("initialize does not request agent_report while task-owned notify_on_terminal work is active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const workspaceTurnId = "workspace-turn-child";
    const workspaceTurnHandleId = "wst_childturn_notify";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await registerLiveWorkspaceTurnHandle(
      taskService,
      workspaceTurnId,
      workspaceTurnHandleId,
      parentTaskId,
      "reserved",
      {
        turnId: "turn-1",
        updatedAt: "2026-06-19T00:00:00.000Z",
        createdWorkspace: true,
        attentionPolicy: "notify_on_terminal",
        createdAt: "2026-06-19T00:00:00.000Z",
      }
    );

    await taskService.initialize();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("orphaned agent attention does not block unrelated terminal work", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "orphaned-agent-task",
    });
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_valid",
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    taskService.scheduleTerminalAttentionDrain(parentId);
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledWith(
      parentId,
      expect.stringContaining("wst_valid"),
      expect.any(Object),
      expect.any(Object)
    );
    expect(
      await terminalAttentionStore.get(parentId, "agent_task:orphaned-agent-task")
    ).toMatchObject({ status: "superseded" });
  });

  test("persistent child reports supersede their private continuation wake prompt", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-continuation-report";
    const childTaskId = "child-continuation-report";
    const handleId = "wst_continuation_report";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:02.000Z",
          taskExecutionId: handleId,
          taskExecutionStatus: "completed",
        }),
      ],
      testTaskSettings()
    );

    const resumeStream = mock(
      (): Promise<Result<{ started: boolean }, SendMessageError>> =>
        Promise.resolve(Ok({ started: true }))
    );
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ resumeStream, sendMessage });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentWorkspaceId, childTaskId, handleId, "completed", {
        turnId: "turn-continuation-report",
        createdAt: "2026-08-10T00:00:01.000Z",
        updatedAt: "2026-08-10T00:00:02.000Z",
        reportMarkdown: "Private continuation output",
      })
    );
    await historyService.appendToHistory(
      parentWorkspaceId,
      createMuxMessage(
        "continuation-report",
        "user",
        formatSubagentReportEnvelope({
          taskId: childTaskId,
          agentType: "explore",
          status: "completed",
          title: "Tooling Mapper",
          reportMarkdown: "Stable child report",
        }),
        {
          timestamp: Date.parse("2026-08-10T00:00:02.000Z"),
          synthetic: true,
          uiVisible: true,
        }
      )
    );

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentWorkspaceId,
      sourceKind: "agent_task",
      sourceId: childTaskId,
    });
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentWorkspaceId,
      sourceKind: "workspace_turn",
      sourceId: handleId,
    });

    taskService.scheduleTerminalAttentionDrain(parentWorkspaceId);
    await flushTerminalAttentionDrains(taskService);

    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      await terminalAttentionStore.get(parentWorkspaceId, `workspace_turn:${handleId}`)
    ).toMatchObject({ status: "superseded" });
    expect(
      await terminalAttentionStore.get(parentWorkspaceId, `agent_task:${childTaskId}`)
    ).toMatchObject({ status: "delivered" });
  });

  test("persistent child continuation keeps the wake prompt when no current report was delivered", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-continuation-fallback";
    const childTaskId = "child-continuation-fallback";
    const handleId = "wst_continuation_fallback";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          taskExecutionId: handleId,
          taskExecutionStatus: "completed",
        }),
      ],
      testTaskSettings()
    );

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentWorkspaceId, childTaskId, handleId, "completed", {
        turnId: "turn-continuation-fallback",
        createdAt: "2026-08-10T00:00:01.000Z",
        updatedAt: "2026-08-10T00:00:02.000Z",
        reportMarkdown: "Continuation output without a new agent report",
      })
    );
    await historyService.appendToHistory(
      parentWorkspaceId,
      createMuxMessage(
        "old-report",
        "user",
        formatSubagentReportEnvelope({
          taskId: childTaskId,
          agentType: "explore",
          status: "completed",
          title: "Earlier report",
          reportMarkdown: "This report predates the continuation.",
        }),
        {
          timestamp: Date.parse("2026-08-10T00:00:00.000Z"),
          synthetic: true,
          uiVisible: true,
        }
      )
    );

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentWorkspaceId,
      sourceKind: "workspace_turn",
      sourceId: handleId,
    });

    taskService.scheduleTerminalAttentionDrain(parentWorkspaceId);
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(childTaskId);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("task_await");
    expect(
      await terminalAttentionStore.get(parentWorkspaceId, `workspace_turn:${handleId}`)
    ).toMatchObject({ status: "delivered" });
  });

  test("mixed drains keep workspace-turn attention off the workflow's agent", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_mixed";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("agent-turn", "assistant", "on it", { timestamp: 1_001, agentId: "plan" })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId,
      agentId: "exec",
    });

    // A workspace-turn result resumes under the conversation's own identity; sharing its wake
    // with an agent-bound workflow group would process it under the workflow's agent instead.
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_mixed_handle",
    });
    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const firstPrompt = String(sendMessage.mock.calls[0]?.[1]);
    expect(firstPrompt).toContain("wst_mixed_handle");
    expect(firstPrompt).not.toContain(runId);
    expect(sendMessage.mock.calls[0]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "plan",
    });

    taskService.scheduleTerminalAttentionDrain(parentId);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondPrompt = String(sendMessage.mock.calls[1]?.[1]);
    expect(secondPrompt).toContain(runId);
    expect(sendMessage.mock.calls[1]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "exec",
    });
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("terminal nested agent report resumes a workspace turn with correlation", async () => {
    const { config, parentId, taskService, workspaceMocks, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(rootDir, "repo", "nested-terminal-agent"),
        id: "nested-terminal-agent",
        name: "nested-terminal-agent",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        agentType: "explore",
        taskModelString: "anthropic:claude-opus-4-6",
      });
      return cfg;
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "nested-terminal-agent",
      messageId: "assistant-nested-terminal-agent",
      metadata: { model: "anthropic:claude-opus-4-6", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "nested-report-call",
          toolName: "agent_report",
          input: { reportMarkdown: "The nested terminal report is complete." },
          state: "output-available",
          output: {
            success: true,
            report: { reportMarkdown: "The nested terminal report is complete." },
          },
        },
        { type: "text", text: "The nested terminal report is complete." },
      ],
    });

    const childHistory = await historyService.getHistoryFromLatestBoundary("childworkspace");
    expect(childHistory.success).toBe(true);
    if (!childHistory.success) throw new Error("child history read failed");
    const reportMessage = childHistory.data.find(
      (message) =>
        message.role === "user" &&
        message.parts.some(
          (part) =>
            part.type === "text" && part.text.includes("The nested terminal report is complete.")
        )
    );
    expect(reportMessage?.metadata?.muxMetadata).toEqual(workspaceTurnMuxMetadata(parentId));

    await flushTerminalAttentionDrains(taskService);

    expect(workspaceMocks.resumeStream).toHaveBeenCalledWith(
      "childworkspace",
      expect.objectContaining({
        muxMetadata: workspaceTurnMuxMetadata(parentId),
      }),
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  });

  test("backfills workspace-turn correlation on an existing terminal report", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-restart-backfill";
    const workspaceTurnId = "workspace-turn-restart-backfill";
    const nestedTaskId = "nested-restart-backfill";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "workspace-turn", workspaceTurnId),
        projectWorkspace(projectPath, "nested-agent", nestedTaskId, {
          parentWorkspaceId: workspaceTurnId,
          taskStatus: "reported",
          reportedAt: "2026-08-14T00:00:01.000Z",
          agentType: "explore",
        }),
      ],
      testTaskSettings()
    );

    const { historyService, taskService } = createTaskServiceHarness(config);
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, workspaceTurnId, "wst_restart_backfill", "running", {
        turnId: "turn-restart-backfill",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        createdWorkspace: true,
      })
    );

    const reportMessage = createMuxMessage(
      "existing-terminal-report",
      "user",
      formatSubagentReportEnvelope({
        taskId: nestedTaskId,
        agentType: "explore",
        status: "completed",
        title: "Existing result",
        reportMarkdown: "The existing report survived the restart.",
      }),
      { timestamp: Date.now(), synthetic: true, uiVisible: true }
    );
    await historyService.appendToHistory(workspaceTurnId, reportMessage);

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const notification = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: workspaceTurnId,
      sourceKind: "agent_task",
      sourceId: nestedTaskId,
    });
    assert(notification, "terminal attention notification must be created");

    const internal = taskService as unknown as {
      ensureAgentTerminalMessages: (
        ownerWorkspaceId: string,
        notifications: ReadonlyArray<typeof notification>
      ) => Promise<unknown>;
    };
    await internal.ensureAgentTerminalMessages(workspaceTurnId, [notification]);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceTurnId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) throw new Error("workspace-turn history read failed");
    const updatedReport = historyResult.data.find((message) => message.id === reportMessage.id);
    expect(updatedReport?.metadata?.muxMetadata).toEqual(
      workspaceTurnMuxMetadata(parentId, "wst_restart_backfill", "turn-restart-backfill")
    );
  });

  test("preserves an existing terminal report correlation from an earlier workspace turn", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-restart-preserve";
    const workspaceTurnId = "workspace-turn-restart-preserve";
    const nestedTaskId = "nested-restart-preserve";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "workspace-turn", workspaceTurnId),
        projectWorkspace(projectPath, "nested-agent", nestedTaskId, {
          parentWorkspaceId: workspaceTurnId,
          taskStatus: "reported",
          reportedAt: "2026-08-14T00:00:01.000Z",
          agentType: "explore",
        }),
      ],
      testTaskSettings()
    );

    const { historyService, taskService } = createTaskServiceHarness(config);
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, workspaceTurnId, "wst_restart_preserve", "running", {
        turnId: "turn-restart-preserve",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        createdWorkspace: true,
      })
    );

    const previousCorrelation = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_previous_turn",
      ownerWorkspaceId: parentId,
      turnId: "turn-previous",
    };
    const reportMessage = createMuxMessage(
      "existing-terminal-report-previous-turn",
      "user",
      formatSubagentReportEnvelope({
        taskId: nestedTaskId,
        agentType: "explore",
        status: "completed",
        title: "Previous result",
        reportMarkdown: "This report belongs to the previous turn.",
      }),
      { timestamp: Date.now(), synthetic: true, uiVisible: true, muxMetadata: previousCorrelation }
    );
    await historyService.appendToHistory(workspaceTurnId, reportMessage);

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const notification = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: workspaceTurnId,
      sourceKind: "agent_task",
      sourceId: nestedTaskId,
    });
    assert(notification, "terminal attention notification must be created");

    const internal = taskService as unknown as {
      ensureAgentTerminalMessages: (
        ownerWorkspaceId: string,
        notifications: ReadonlyArray<typeof notification>
      ) => Promise<{ deliverableNotificationIds: Set<string> }>;
    };
    const ensureResult = await internal.ensureAgentTerminalMessages(workspaceTurnId, [
      notification,
    ]);
    expect(ensureResult.deliverableNotificationIds.has(notification.id)).toBe(false);
    expect(await terminalAttentionStore.get(workspaceTurnId, notification.id)).toMatchObject({
      status: "superseded",
    });

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceTurnId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) throw new Error("workspace-turn history read failed");
    const preservedReport = historyResult.data.find((message) => message.id === reportMessage.id);
    expect(preservedReport?.metadata?.muxMetadata).toEqual(previousCorrelation);
  });
});
