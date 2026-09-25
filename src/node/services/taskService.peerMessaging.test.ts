import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { PEER_MESSAGE_RATE_LIMIT_MAX } from "@/constants/agentMessaging";
import { TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_MESSAGES } from "@/constants/taskMessages";
import type { TaskService } from "@/node/services/taskService";
import type { AgentPeerMessageBroker } from "@/node/services/agentPeerMessageBroker";
import { Ok, Err, type Result } from "@/common/types/result";
import { parseAgentMessageEnvelope } from "@/common/utils/agentMessageEnvelope";
import { defaultModel } from "@/common/utils/ai/models";
import type { SendMessageError } from "@/common/types/errors";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnManagerInternals,
  workspaceTurnSnapshot,
} from "@/node/services/taskService.testHarness";
import {
  collectFullHistory,
  createTaskServiceHarness,
  registerLiveWorkspaceTurnHandle,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
  reserveFamilyMessageTargetSlots,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  test("retitleDescendantAgentTask renames active or inactive persistent descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-retitle";
    const childTaskId = "child-retitle";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          taskStatus: "reported",
          title: "Old task-like title",
        }),
      ],
      testTaskSettings()
    );
    const updateTitle = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService } = createWorkspaceServiceMocks({ updateTitle });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(
      await taskService.retitleDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "  Simplicity Auditor  "
      )
    ).toEqual(Ok({ title: "Simplicity Auditor" }));
    expect(updateTitle).toHaveBeenCalledWith(childTaskId, "Simplicity Auditor");
  });

  test("retitleDescendantAgentTask rejects missing, foreign, self, and workflow-owned targets", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-retitle-scope";
    const otherParentId = "other-retitle-scope";
    const foreignChildId = "foreign-retitle-child";
    const workflowChildId = "workflow-retitle-child";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "other-parent", otherParentId),
        projectWorkspace(projectPath, "foreign-child", foreignChildId, {
          parentWorkspaceId: otherParentId,
          taskStatus: "reported",
        }),
        projectWorkspace(projectPath, "workflow-child", workflowChildId, {
          parentWorkspaceId,
          taskStatus: "reported",
          workflowTask: { runId: "wfr_retitle", stepId: "step" },
        }),
      ],
      testTaskSettings()
    );
    const { workspaceService, updateTitle } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(
      await taskService.retitleDescendantAgentTask(parentWorkspaceId, "missing", "Reviewer")
    ).toEqual(Err({ code: "not_found" }));
    expect(
      await taskService.retitleDescendantAgentTask(parentWorkspaceId, parentWorkspaceId, "Reviewer")
    ).toEqual(Err({ code: "invalid_scope" }));
    expect(
      await taskService.retitleDescendantAgentTask(parentWorkspaceId, foreignChildId, "Reviewer")
    ).toEqual(Err({ code: "invalid_scope" }));
    expect(
      await taskService.retitleDescendantAgentTask(parentWorkspaceId, workflowChildId, "Reviewer")
    ).toEqual(Err({ code: "invalid_scope" }));
    expect(updateTitle).not.toHaveBeenCalled();
  });

  test("retitleDescendantAgentTask surfaces title update failures", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-retitle-failure";
    const childTaskId = "child-retitle-failure";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    const updateTitle = mock((): Promise<Result<void>> => Promise.resolve(Err("disk full")));
    const { workspaceService } = createWorkspaceServiceMocks({ updateTitle });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(
      await taskService.retitleDescendantAgentTask(parentWorkspaceId, childTaskId, "Reviewer")
    ).toEqual(Err({ code: "update_failed", message: "disk full" }));
  });

  test("sendMessageToDescendantAgentTask sends updated guidance with the child's settings", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-guidance";
    const childTaskId = "child-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
          taskExperiments: { advisorTool: true },
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      sendMessage: mock(
        async (
          _workspaceId: string,
          _message: string,
          _options: unknown,
          internal?: { onAccepted?: () => Promise<void> | void }
        ): Promise<Result<void>> => {
          await internal?.onAccepted?.();
          return Ok(undefined);
        }
      ),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Inspect the generated schema instead.",
      "turn-end"
    );

    expect(result).toEqual(Ok({ delivery: "accepted" }));
    expect(sendMessage).toHaveBeenCalledWith(
      childTaskId,
      "Updated guidance from parent:\n\nInspect the generated schema instead.",
      {
        model: "openai:gpt-5.2",
        agentId: "explore",
        thinkingLevel: "medium",
        reasoningMode: undefined,
        experiments: { advisorTool: true },
        queueDispatchMode: "turn-end",
      },
      expect.objectContaining({
        synthetic: true,
        agentInitiated: true,
        startStreamInBackground: true,
      })
    );
  });

  test("sendMessageToDescendantAgentTask revives awaiting-report tasks and rolls back failed sends", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-awaiting-guidance";
    const childTaskId = "child-awaiting-guidance";
    let sendSucceeds = false;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage: mock(
        (): Promise<Result<void, SendMessageError>> =>
          Promise.resolve(
            sendSucceeds ? Ok(undefined) : Err({ type: "unknown", raw: "send failed" })
          )
      ),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Continue with the correction.",
        "tool-end"
      )
    ).toEqual(Err({ code: "send_failed", message: "send failed" }));
    expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("awaiting_report");

    sendSucceeds = true;
    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Continue with the correction.",
        "tool-end"
      )
    ).toEqual(Ok({ delivery: "queued", queueDispatchMode: "tool-end" }));
    expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("running");
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toEqual([
      expect.objectContaining({
        message: "Continue with the correction.",
        queueDispatchMode: "tool-end",
      }),
    ]);
  });

  test("sendMessageToDescendantAgentTask preserves later queued guidance reservations", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-multiple-guidance";
    const childTaskId = "child-multiple-guidance";
    const acceptedCallbacks: Array<() => Promise<void> | void> = [];

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage: mock(
        (
          _workspaceId: string,
          _message: string,
          _options: unknown,
          internal?: { onAccepted?: () => Promise<void> | void }
        ): Promise<Result<void>> => {
          if (internal?.onAccepted) {
            acceptedCallbacks.push(internal.onAccepted);
          }
          return Promise.resolve(Ok(undefined));
        }
      ),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "First correction",
        "turn-end"
      )
    ).toEqual(Ok({ delivery: "queued", queueDispatchMode: "turn-end" }));
    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Second correction",
        "turn-end"
      )
    ).toEqual(Ok({ delivery: "queued", queueDispatchMode: "turn-end" }));
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toHaveLength(2);

    await acceptedCallbacks[0]?.();
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toEqual([
      expect.objectContaining({ message: "Second correction" }),
    ]);
    await acceptedCallbacks[1]?.();
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPendingGuidance).toBeUndefined();
  });

  test("sendMessageToDescendantAgentTask serializes queued guidance with launch reservation", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-queued-race";
    const childTaskId = "child-queued-race";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "queued",
          taskPrompt: "Original brief",
        }),
      ],
      testTaskSettings()
    );

    const { taskService } = createTaskServiceHarness(config);
    const internalTaskService = taskService as unknown as {
      mutex: { acquire(): Promise<AsyncDisposable> };
    };
    const schedulerLock = await internalTaskService.mutex.acquire();
    const guidanceResult = taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Use the correction.",
      "tool-end"
    );
    await Promise.resolve();
    await config.editConfig((current) => {
      const child = current.projects
        .get(projectPath)
        ?.workspaces.find((workspace) => workspace.id === childTaskId);
      assert(child);
      child.taskStatus = "starting";
      return current;
    });
    await schedulerLock[Symbol.asyncDispose]();

    expect(await guidanceResult).toEqual(Err({ code: "not_active", taskStatus: "starting" }));
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPrompt).toBe("Original brief");
  });

  test("sendMessageToDescendantAgentTask updates queued prompts without bypassing scheduling", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-queued-guidance";
    const childTaskId = "child-queued-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "queued",
          taskPrompt: "Original brief",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Do not edit generated files.",
      "tool-end"
    );

    expect(result).toEqual(Ok({ delivery: "queued" }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPrompt).toBe(
      "Original brief\n\nUpdated guidance from parent:\n\nDo not edit generated files."
    );
  });

  test("sendAgentTreeMessage delivers sibling messages with the target's settings and an untrusted envelope", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "sib-a", "sib-a", {
          parentWorkspaceId: "tree-root",
          title: "Watcher A",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskExperiments: { advisorTool: true },
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      sendMessage: mock(
        async (
          _workspaceId: string,
          _message: string,
          _options: unknown,
          internal?: { onAccepted?: () => Promise<void> | void }
        ): Promise<Result<void>> => {
          await internal?.onAccepted?.();
          return Ok(undefined);
        }
      ),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.sendAgentTreeMessage(
      "sib-a",
      "sib-b",
      "Schema renamed; update your queries."
    );

    expect(result).toEqual(Ok({ delivery: "accepted", relation: "peer" }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [targetId, message, options, internal] = sendMessage.mock.calls[0] as [
      string,
      string,
      {
        model: string;
        agentId: string;
        queueDispatchMode?: string;
        muxMetadata?: {
          type?: string;
          fromWorkspaceId?: string;
          fromTitle?: string;
          relationship?: string;
        };
      },
      {
        skipAutoResumeReset?: boolean;
        removableQueueDedupeKey?: boolean;
        queueDedupeKey?: string;
        preTurnMessages?: MuxMessage[];
      },
    ];
    expect(targetId).toBe("sib-b");
    // SECURITY: the message TEXT is a fixed trigger with zero sender-controlled bytes — the
    // envelope rides as an assistant-role pre-turn row so peer bytes never gain user authority.
    expect(message).not.toContain("Schema renamed");
    expect(message).toContain("untrusted agent output");
    const payloadRow = internal.preTurnMessages?.[0];
    expect(internal.preTurnMessages).toHaveLength(1);
    expect(payloadRow?.role).toBe("assistant");
    expect(message).toContain(payloadRow!.id);
    const payloadText = payloadRow?.parts[0]?.type === "text" ? payloadRow.parts[0].text : "";
    // Raw sender text never appears unencoded: the payload is the escaped envelope.
    expect(parseAgentMessageEnvelope(payloadText)).toEqual({
      from: "sib-a",
      fromTitle: "Watcher A",
      relationship: "sibling",
      message: "Schema renamed; update your queries.",
    });
    // Sibling targets keep their own persisted settings and the tool-end default.
    expect(options.model).toBe("openai:gpt-5.2");
    expect(options.agentId).toBe("explore");
    expect(options.queueDispatchMode).toBe("tool-end");
    expect(options.muxMetadata).toEqual({
      type: "agent-peer-message",
      fromWorkspaceId: "sib-a",
      fromTitle: "Watcher A",
      relationship: "sibling",
    });
    // Peer sends must not reset the wake budget, and must never coalesce in the queue.
    expect(internal.skipAutoResumeReset).toBe(true);
    expect(internal.removableQueueDedupeKey).toBe(true);
    expect(internal.queueDedupeKey).toStartWith("agent-msg:sib-a:");
  });

  test("sendAgentTreeMessage delivers ancestor messages with a turn-end default and descendant relationship", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child", "child-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.sendAgentTreeMessage("child-a", "tree-root", "Blocked on CI.");

    // No onAccepted call from the default mock ⇒ the send queued behind the (busy) ancestor.
    expect(result).toEqual(
      Ok({ delivery: "queued", relation: "target_ancestor", queueDispatchMode: "turn-end" })
    );
    const [targetId, , options, internal] = sendMessage.mock.calls[0] as [
      string,
      string,
      { queueDispatchMode?: string; muxMetadata?: { relationship?: string } },
      { skipAutoResumeReset?: boolean; preTurnMessages?: MuxMessage[] },
    ];
    expect(targetId).toBe("tree-root");
    // The envelope (assistant pre-turn row) carries the SENDER's relationship: a descendant.
    const payloadText =
      internal.preTurnMessages?.[0]?.parts[0]?.type === "text"
        ? internal.preTurnMessages[0].parts[0].text
        : "";
    expect(parseAgentMessageEnvelope(payloadText)?.relationship).toBe("descendant");
    expect(options.queueDispatchMode).toBe("turn-end");
    expect(options.muxMetadata?.relationship).toBe("descendant");
    expect(internal.skipAutoResumeReset).toBe(true);
  });

  test("sendAgentTreeMessage routes descendant targets to the unchanged trusted guidance path", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child", "child-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      sendMessage: mock(
        async (
          _workspaceId: string,
          _message: string,
          _options: unknown,
          internal?: { onAccepted?: () => Promise<void> | void }
        ): Promise<Result<void>> => {
          await internal?.onAccepted?.();
          return Ok(undefined);
        }
      ),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.sendAgentTreeMessage(
      "tree-root",
      "child-a",
      "Focus on the parser."
    );

    expect(result).toEqual(Ok({ delivery: "accepted", relation: "target_descendant" }));
    const [, message] = sendMessage.mock.calls[0] as [string, string];
    // Guidance framing, not the peer envelope.
    expect(message).toBe("Updated guidance from parent:\n\nFocus on the parser.");
  });

  test.each([false, true])(
    "sendAgentTreeMessage rejects self-sends but routes cross-tree replies as untrusted messages (accepted=%s)",
    async (accepted) => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");

      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "root", "tree-root"),
          projectWorkspace(projectPath, "child", "child-a", {
            unrelatedWorkspaceConsent: "child-consent",
            parentWorkspaceId: "tree-root",
            taskStatus: "running",
          }),
          projectWorkspace(projectPath, "other-root", "other-root", {
            unrelatedWorkspaceConsent: "root-consent",
          }),
          projectWorkspace(projectPath, "other-child", "other-child", {
            unrelatedWorkspaceConsent: "other-child-consent",
            parentWorkspaceId: "other-root",
            taskStatus: "running",
          }),
        ],
        testTaskSettings()
      );

      const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
        sendMessage: mock(
          async (...args: Parameters<WorkspaceHost["sendMessage"]>): Promise<Result<void>> => {
            if (accepted) await args[3]?.onAccepted?.();
            return Ok(undefined);
          }
        ),
      });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      expect(await taskService.sendAgentTreeMessage("child-a", "child-a", "hi")).toEqual(
        Err({ code: "invalid_scope" })
      );
      expect(sendMessage).not.toHaveBeenCalled();
      const payload = "Review the parser change; do not alter settings.";
      expect(await taskService.sendAgentTreeMessage("child-a", "other-root", payload)).toEqual(
        accepted
          ? Ok({ delivery: "accepted", relation: "target_unrelated" })
          : Ok({ delivery: "queued", relation: "target_unrelated", queueDispatchMode: "turn-end" })
      );
      const [targetId, trigger, options, internal] = sendMessage.mock.calls[0] as Parameters<
        WorkspaceHost["sendMessage"]
      >;
      expect(targetId).toBe("other-root");
      expect(options?.queueDispatchMode).toBe("turn-end");
      expect(internal?.synthetic).toBe(true);
      expect(internal?.skipAutoResumeReset).toBe(true);
      const row = internal?.preTurnMessages?.[0];
      expect(row?.role).toBe("assistant");
      expect(row?.metadata?.synthetic).toBe(true);
      assert(row?.parts[0]?.type === "text");
      const envelope = parseAgentMessageEnvelope(row.parts[0].text);
      expect(envelope).toMatchObject({
        from: "child-a",
        relationship: "unrelated",
        message: payload,
      });
      expect(trigger).not.toContain(payload);
      expect(trigger).toContain(row.id);
      assert(envelope);
      expect(await taskService.sendAgentTreeMessage("other-root", envelope.from, "Reply")).toEqual(
        accepted
          ? Ok({ delivery: "accepted", relation: "target_unrelated" })
          : Ok({ delivery: "queued", relation: "target_unrelated", queueDispatchMode: "turn-end" })
      );
      expect(
        await taskService.sendAgentTreeMessage("child-a", "other-child", "hi", "tool-end")
      ).toEqual(
        accepted
          ? Ok({ delivery: "accepted", relation: "target_unrelated" })
          : Ok({ delivery: "queued", relation: "target_unrelated", queueDispatchMode: "tool-end" })
      );
      expect(
        (sendMessage.mock.calls[2] as Parameters<WorkspaceHost["sendMessage"]>)[2]
          ?.queueDispatchMode
      ).toBe("tool-end");
    }
  );

  describe("sendAgentTreeMessage unrelated targets", () => {
    test.each([undefined, null, "", "  ", " padded ", true, 42, {}])(
      "refuses unrelated targets without valid recipient consent (%j)",
      async (consent) => {
        const config = await createTestConfig(rootDir);
        const projectPath = path.join(rootDir, "repo");
        const target = projectWorkspace(projectPath, "target", "target");
        // Config is persisted JSON; malformed settings must not grant access.
        Object.assign(target, { unrelatedWorkspaceConsent: consent });
        await saveWorkspaces(
          config,
          projectPath,
          [projectWorkspace(projectPath, "sender", "sender"), target],
          testTaskSettings()
        );
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService, historyService } = createTaskServiceHarness(config, {
          workspaceService,
        });

        // Knowing an ID must not reveal whether an unrelated recipient exists or wake it.
        const missing = await taskService.sendAgentTreeMessage("sender", "missing", "No consent");
        expect(missing).toEqual(Err({ code: "not_found" }));
        expect(await taskService.sendAgentTreeMessage("sender", "target", "No consent")).toEqual(
          missing
        );
        expect(sendMessage).not.toHaveBeenCalled();
        expect(await collectFullHistory(historyService, "target")).toEqual([]);
      }
    );

    test.each(
      (["pre-admission", "queued"] as const).flatMap((phase) =>
        [false, true].map((reenable) => ({ phase, reenable }))
      )
    )(
      "revokes and refunds unrelated consent at $phase (reenable=$reenable)",
      async ({ phase, reenable }) => {
        const config = await createTestConfig(rootDir);
        const projectPath = path.join(rootDir, "repo");
        await saveWorkspaces(
          config,
          projectPath,
          [
            projectWorkspace(projectPath, "sender", "sender"),
            projectWorkspace(projectPath, "target", "target", {
              unrelatedWorkspaceConsent: "original-generation",
            }),
          ],
          testTaskSettings()
        );
        expect(
          findWorkspaceEntry(config.loadConfigOrDefault(), "target")?.workspace
            .unrelatedWorkspaceConsent
        ).toBe("original-generation");
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService, historyService } = createTaskServiceHarness(config, {
          workspaceService,
        });
        reserveFamilyMessageTargetSlots(
          taskService,
          "target",
          TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_MESSAGES - 1
        );
        const setGeneration = async (generation?: string) => {
          await config.editConfig((cfg) => {
            const entry = findWorkspaceEntry(cfg, "target");
            assert(entry);
            if (generation == null) delete entry.workspace.unrelatedWorkspaceConsent;
            else entry.workspace.unrelatedWorkspaceConsent = generation;
            return cfg;
          });
        };
        const revoke = async () => {
          await setGeneration();
          if (reenable) await setGeneration("new-generation");
        };
        const internals = taskService as unknown as {
          resolveParentAutoResumeOptions: () => Promise<{ model: string; agentId: string }>;
        };
        const resolve = spyOn(internals, "resolveParentAutoResumeOptions");
        try {
          if (phase === "pre-admission") {
            resolve.mockImplementationOnce(async () => {
              await revoke();
              return { model: defaultModel, agentId: "exec" };
            });
          }
          const result = await taskService.sendAgentTreeMessage("sender", "target", "Old consent");
          if (phase === "queued") {
            expect(result).toMatchObject(Ok({ delivery: "queued" }));
            const [, , , internal] = sendMessage.mock.calls[0] as Parameters<
              WorkspaceHost["sendMessage"]
            >;
            expect(internal?.admissionStale?.()).toBe(false);
            await revoke();
            expect(internal?.admissionStale?.()).toBe(true);
            await internal?.onCanceled?.("Recipient consent was revoked");
          } else {
            expect(result).toEqual(Err({ code: "not_found" }));
            expect(sendMessage).not.toHaveBeenCalled();
          }
          expect(await collectFullHistory(historyService, "target")).toEqual([]);
          await setGeneration("new-generation");
          // A fresh send can use the refunded slot, even though the sender never opted in.
          expect(
            findWorkspaceEntry(config.loadConfigOrDefault(), "sender")?.workspace
              .unrelatedWorkspaceConsent
          ).toBeUndefined();
          expect(
            (await taskService.sendAgentTreeMessage("sender", "target", "Fresh consent")).success
          ).toBe(true);
        } finally {
          resolve.mockRestore();
        }
      }
    );

    test("refuses unrelated messaging while legacy runtime identity is unresolved", async () => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "sender", "sender"),
          {
            ...projectWorkspace(projectPath, "target", "target", {
              unrelatedWorkspaceConsent: "consent",
            }),
            name: undefined,
          },
        ],
        testTaskSettings()
      );
      // A partly migrated entry may still get its runtime from legacy session metadata.
      const legacyDir = path.join(config.sessionsDir, "target");
      await fsPromises.mkdir(legacyDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(legacyDir, "metadata.json"),
        JSON.stringify({
          id: "target",
          name: "target",
          projectPath,
          runtimeConfig: { type: "ssh", host: "remote.example", srcBaseDir: "~/src" },
        })
      );
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      expect(
        await taskService.sendAgentTreeMessage("sender", "target", "Unresolved runtime")
      ).toMatchObject(Err({ code: "refused" }));
      expect(sendMessage).not.toHaveBeenCalled();
    });

    test.each(
      (
        [
          { type: "ssh", host: "remote.example", srcBaseDir: "~/src" },
          { type: "docker", image: "node:22" },
          { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
        ] as const
      ).flatMap((runtimeConfig) =>
        (["sender", "target"] as const).flatMap((endpoint) =>
          [false, true].map((isChild) => ({
            endpoint,
            runtime: runtimeConfig.type,
            runtimeConfig,
            isChild,
          }))
        )
      )
    )(
      "refuses unrelated messaging when $endpoint uses $runtime (child=$isChild)",
      async ({ endpoint, runtimeConfig, isChild }) => {
        const config = await createTestConfig(rootDir);
        const projectPath = path.join(rootDir, "repo");
        await saveWorkspaces(
          config,
          projectPath,
          [
            projectWorkspace(projectPath, "local-parent", "local-parent"),
            projectWorkspace(projectPath, "sender", "sender", {
              runtimeConfig: endpoint === "sender" ? runtimeConfig : { type: "local" },
              ...(endpoint === "sender" && isChild
                ? { parentWorkspaceId: "local-parent", taskStatus: "running" }
                : {}),
            }),
            projectWorkspace(projectPath, "target", "target", {
              unrelatedWorkspaceConsent: "consent",
              runtimeConfig: endpoint === "target" ? runtimeConfig : { type: "local" },
              ...(endpoint === "target" && isChild
                ? { parentWorkspaceId: "local-parent", taskStatus: "running" }
                : {}),
            }),
          ],
          testTaskSettings()
        );
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService, historyService } = createTaskServiceHarness(config, {
          workspaceService,
        });

        expect(
          await taskService.sendAgentTreeMessage("sender", "target", "Cross-runtime input")
        ).toMatchObject(Err({ code: "refused" }));
        expect(sendMessage).not.toHaveBeenCalled();
        expect(await collectFullHistory(historyService, "target")).toEqual([]);
      }
    );

    test.each([
      { label: "default worktree", runtimeConfig: undefined },
      { label: "project local", runtimeConfig: { type: "local" } },
      { label: "legacy local worktree", runtimeConfig: { type: "local", srcBaseDir: "~/src" } },
      { label: "explicit worktree", runtimeConfig: { type: "worktree", srcBaseDir: "~/src" } },
    ] as const)(
      "keeps named $label endpoints addressable in both directions",
      async ({ runtimeConfig }) => {
        const config = await createTestConfig(rootDir);
        const projectPath = path.join(rootDir, "repo");
        await saveWorkspaces(
          config,
          projectPath,
          [
            projectWorkspace(projectPath, "sender", "sender", {
              runtimeConfig,
              unrelatedWorkspaceConsent: "sender-consent",
            }),
            projectWorkspace(projectPath, "target", "target", {
              unrelatedWorkspaceConsent: "consent",
              runtimeConfig: { type: "worktree", srcBaseDir: "~/src" },
            }),
          ],
          testTaskSettings()
        );
        const { workspaceService } = createWorkspaceServiceMocks();
        const { taskService } = createTaskServiceHarness(config, { workspaceService });

        expect(await taskService.sendAgentTreeMessage("sender", "target", "Forward")).toMatchObject(
          Ok({ relation: "target_unrelated" })
        );
        expect(await taskService.sendAgentTreeMessage("target", "sender", "Reply")).toMatchObject(
          Ok({ relation: "target_unrelated" })
        );
      }
    );

    test.each([
      { type: "ssh", host: "remote.example", srcBaseDir: "~/src" },
      { type: "docker", image: "node:22" },
      { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
    ] as const)("preserves same-tree messaging for $type runtimes", async (runtimeConfig) => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "root", "root", { runtimeConfig }),
          projectWorkspace(projectPath, "sender", "sender", {
            runtimeConfig,
            parentWorkspaceId: "root",
            taskStatus: "running",
          }),
          projectWorkspace(projectPath, "target", "target", {
            runtimeConfig,
            parentWorkspaceId: "root",
            taskStatus: "running",
          }),
        ],
        testTaskSettings()
      );
      const { workspaceService } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      expect(
        await taskService.sendAgentTreeMessage("sender", "target", "Existing sibling path")
      ).toMatchObject(Ok({ relation: "peer" }));
      expect(
        await taskService.sendAgentTreeMessage("sender", "root", "Existing ancestor path")
      ).toMatchObject(Ok({ relation: "target_ancestor" }));
    });

    test.each([
      { selected: "plan", history: ["exec"], expected: "plan" },
      { selected: "plan", history: [], expected: "plan" },
      { selected: undefined, history: ["exec"], expected: "exec" },
      { selected: undefined, history: [], expected: "exec" },
      { selected: undefined, history: ["plan", "compact"], expected: "plan" },
    ])(
      "uses recipient identity $expected (selected=$selected, history=$history)",
      async (entry) => {
        const fixture = await createTestHistoryService();
        await using _cleanup = { [Symbol.asyncDispose]: fixture.cleanup };
        const { config, historyService } = fixture;
        const projectPath = path.join(fixture.tempDir, "repo");
        const hasSettings = entry.selected != null || entry.history.length > 0;
        await saveWorkspaces(
          config,
          projectPath,
          [
            projectWorkspace(projectPath, "sender", "sender", { agentId: "explore" }),
            projectWorkspace(projectPath, "target", "target", {
              unrelatedWorkspaceConsent: "consent",
              agentId: entry.selected,
              aiSettings: hasSettings
                ? { model: "openai:gpt-5.2", thinkingLevel: "low" }
                : undefined,
              aiSettingsByAgent: hasSettings
                ? {
                    plan: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "high" },
                    exec: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
                  }
                : undefined,
            }),
          ],
          testTaskSettings()
        );
        for (const [i, agentId] of entry.history.entries()) {
          expect(
            (
              await historyService.appendToHistory(
                "target",
                createMuxMessage(`history-${i}`, "assistant", "Prior turn", { agentId })
              )
            ).success
          ).toBe(true);
        }
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService } = createTaskServiceHarness(config, {
          workspaceService,
          historyService,
        });
        const correlation = spyOn(
          workspaceTurnManagerFor(taskService),
          "getActiveWorkspaceTurnMuxMetadataForWorkspace"
        );
        try {
          expect(
            (await taskService.sendAgentTreeMessage("sender", "target", "Review this")).success
          ).toBe(true);
          const [, , options, internal] = sendMessage.mock.calls[0] as Parameters<
            WorkspaceHost["sendMessage"]
          >;
          expect(options).toMatchObject({
            agentId: entry.expected,
            model: !hasSettings
              ? defaultModel
              : entry.expected === "plan"
                ? "anthropic:claude-sonnet-4-5"
                : "openai:gpt-5.2",
            thinkingLevel: !hasSettings ? "off" : entry.expected === "plan" ? "high" : "medium",
            queueDispatchMode: "turn-end",
            muxMetadata: { type: "agent-peer-message", relationship: "unrelated" },
          });
          expect(internal?.synthetic).toBe(true);
          expect(internal?.workspaceTurnContinuation).toBe(false);
          expect(correlation).not.toHaveBeenCalled();
        } finally {
          correlation.mockRestore();
        }
      }
    );

    test.each(["reported", "interrupted", "queued", "starting"] as const)(
      "does not wake a foreign child that is %s",
      async (taskStatus) => {
        const config = await createTestConfig(rootDir);
        const projectPath = path.join(rootDir, "repo");
        await saveWorkspaces(
          config,
          projectPath,
          [
            projectWorkspace(projectPath, "sender", "sender"),
            projectWorkspace(projectPath, "target", "target", {
              unrelatedWorkspaceConsent: "consent",
              parentWorkspaceId: "foreign-root",
              taskStatus,
            }),
            projectWorkspace(projectPath, "foreign-root", "foreign-root"),
          ],
          testTaskSettings()
        );
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService } = createTaskServiceHarness(config, { workspaceService });
        expect(await taskService.sendAgentTreeMessage("sender", "target", "Wake up")).toMatchObject(
          Err({ code: "not_active", taskStatus })
        );
        expect(sendMessage).not.toHaveBeenCalled();
      }
    );

    test.each([false, true])(
      "refuses a delegated root before budget reservation (accepted=%s)",
      async (accepted) => {
        const config = await createTestConfig(rootDir);
        const projectPath = path.join(rootDir, "repo");
        await saveWorkspaces(
          config,
          projectPath,
          [
            projectWorkspace(projectPath, "sender", "sender"),
            projectWorkspace(projectPath, "target", "target", {
              agentId: "exec",
              unrelatedWorkspaceConsent: "consent",
            }),
          ],
          testTaskSettings()
        );
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService } = createTaskServiceHarness(config, { workspaceService });
        const internals = taskService as unknown as {
          agentPeerMessageBroker: AgentPeerMessageBroker;
        };
        const reserve = spyOn(internals.agentPeerMessageBroker, "reserveBudget");
        await registerLiveWorkspaceTurnHandle(
          taskService,
          "target",
          "wst_foreign",
          "sender",
          accepted
        );
        try {
          const result = await taskService.sendAgentTreeMessage(
            "sender",
            "target",
            "Do not resume delegated work"
          );
          expect(result).toMatchObject(Err({ code: "refused" }));
          assert(!result.success && "reason" in result.error);
          expect(result.error.reason).toMatch(/retry.*delegated/i);
          expect(reserve).not.toHaveBeenCalled();
          expect(sendMessage).not.toHaveBeenCalled();
          // Existing ownership is separate from ancestry; finishing the delegation opens messaging.
          workspaceTurnManagerInternals(taskService).activeWorkspaceTurnHandleByWorkspaceId.delete(
            "target"
          );
          expect(
            await taskService.sendAgentTreeMessage("sender", "target", "New synthetic input")
          ).toEqual(
            Ok({ delivery: "queued", relation: "target_unrelated", queueDispatchMode: "turn-end" })
          );
          const [, , options] = sendMessage.mock.calls[0] as Parameters<
            WorkspaceHost["sendMessage"]
          >;
          expect(options?.agentId).toBe("exec");
          expect(options?.muxMetadata).toMatchObject({ type: "agent-peer-message" });
        } finally {
          reserve.mockRestore();
        }
      }
    );

    test.each(["pre-admission", "queued"] as const)(
      "withdraws and refunds when delegation starts %s",
      async (phase) => {
        const config = await createTestConfig(rootDir);
        const projectPath = path.join(rootDir, "repo");
        await saveWorkspaces(
          config,
          projectPath,
          [
            projectWorkspace(projectPath, "sender", "sender"),
            projectWorkspace(projectPath, "target", "target", {
              agentId: "plan",
              unrelatedWorkspaceConsent: "consent",
            }),
          ],
          testTaskSettings()
        );
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService, historyService } = createTaskServiceHarness(config, {
          workspaceService,
        });
        const internals = taskService as unknown as {
          resolveParentAutoResumeOptions: () => Promise<{ model: string; agentId: string }>;
        };
        reserveFamilyMessageTargetSlots(
          taskService,
          "target",
          TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_MESSAGES - 1
        );
        const resolve = spyOn(internals, "resolveParentAutoResumeOptions");
        try {
          if (phase === "pre-admission") {
            resolve.mockImplementationOnce(async () => {
              await registerLiveWorkspaceTurnHandle(
                taskService,
                "target",
                "wst_race",
                "owner",
                false
              );
              return { model: defaultModel, agentId: "plan" };
            });
          }
          const result = await taskService.sendAgentTreeMessage(
            "sender",
            "target",
            "Before delegation"
          );
          if (phase === "queued") {
            expect(result).toEqual(
              Ok({
                delivery: "queued",
                relation: "target_unrelated",
                queueDispatchMode: "turn-end",
              })
            );
            await registerLiveWorkspaceTurnHandle(
              taskService,
              "target",
              "wst_race",
              "owner",
              false
            );
            const [, , , internal] = sendMessage.mock.calls[0] as Parameters<
              WorkspaceHost["sendMessage"]
            >;
            expect(internal?.admissionStale?.()).toBe(true);
            await internal?.onCanceled?.("Delegated execution began before dispatch");
          } else {
            expect(result).toMatchObject(Err({ code: "refused" }));
            expect(sendMessage).not.toHaveBeenCalled();
          }
          expect(await collectFullHistory(historyService, "target")).toEqual([]);
          workspaceTurnManagerInternals(taskService).activeWorkspaceTurnHandleByWorkspaceId.delete(
            "target"
          );
          // One available budget slot proves that either cancellation path refunded the first send.
          expect(
            (await taskService.sendAgentTreeMessage("sender", "target", "After delegation")).success
          ).toBe(true);
        } finally {
          resolve.mockRestore();
        }
      }
    );

    test.each([
      { endpoint: "sender", state: "archived", code: "refused" },
      { endpoint: "target", state: "archived", code: "not_active" },
      { endpoint: "sender", state: "stopped", code: "refused" },
      { endpoint: "target", state: "stopped", code: "refused" },
      { endpoint: "sender", state: "remote", code: "refused" },
      { endpoint: "target", state: "remote", code: "refused" },
      { endpoint: "sender", state: "unresolved", code: "refused" },
      { endpoint: "target", state: "unresolved", code: "refused" },
    ])(
      "refunds when $endpoint becomes $state during identity resolution",
      async ({ endpoint, state, code }) => {
        const config = await createTestConfig(rootDir);
        const projectPath = path.join(rootDir, "repo");
        await saveWorkspaces(
          config,
          projectPath,
          [
            projectWorkspace(projectPath, "sender", "sender"),
            projectWorkspace(projectPath, "target", "target", {
              agentId: "plan",
              unrelatedWorkspaceConsent: "consent",
            }),
          ],
          testTaskSettings()
        );
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService, historyService } = createTaskServiceHarness(config, {
          workspaceService,
        });
        const internals = taskService as unknown as {
          resolveParentAutoResumeOptions: () => Promise<{ model: string; agentId: string }>;
        };
        const resolve = spyOn(internals, "resolveParentAutoResumeOptions");
        reserveFamilyMessageTargetSlots(
          taskService,
          "target",
          TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_MESSAGES - 1
        );
        try {
          resolve.mockImplementationOnce(async () => {
            if (state === "stopped") taskService.markParentWorkspaceInterrupted(endpoint);
            else
              await config.editConfig((cfg) => {
                const entry = findWorkspaceEntry(cfg, endpoint);
                assert(entry);
                if (state === "remote") {
                  entry.workspace.runtimeConfig = {
                    type: "ssh",
                    host: "remote.example",
                    srcBaseDir: "~/src",
                  };
                } else if (state === "unresolved") {
                  delete entry.workspace.runtimeConfig;
                  delete entry.workspace.name;
                } else {
                  entry.workspace.archivedAt = "2026-09-16T12:00:00.000Z";
                }
                return cfg;
              });
            return { model: defaultModel, agentId: "plan" };
          });
          expect(
            await taskService.sendAgentTreeMessage("sender", "target", "Racing send")
          ).toMatchObject(Err({ code }));
          expect(sendMessage).not.toHaveBeenCalled();
          expect(await collectFullHistory(historyService, "target")).toEqual([]);
          // The same endpoint remains refused even before any awaited preparation.
          expect(
            await taskService.sendAgentTreeMessage("sender", "target", "Still unavailable")
          ).toMatchObject(Err({ code }));
          if (state === "stopped") taskService.resetAutoResumeCount(endpoint);
          else
            await config.editConfig((cfg) => {
              const entry = findWorkspaceEntry(cfg, endpoint);
              assert(entry);
              if (state === "remote" || state === "unresolved") {
                entry.workspace.runtimeConfig = { type: "local" };
                entry.workspace.name = endpoint;
              } else {
                entry.workspace.unarchivedAt = "2026-09-16T13:00:00.000Z";
              }
              return cfg;
            });
          expect(
            (await taskService.sendAgentTreeMessage("sender", "target", "After user resumes"))
              .success
          ).toBe(true);
        } finally {
          resolve.mockRestore();
        }
      }
    );

    test.each(["sender", "target"] as const)(
      "withdraws queued unrelated input when %s changes to a container runtime",
      async (endpoint) => {
        const config = await createTestConfig(rootDir);
        const projectPath = path.join(rootDir, "repo");
        await saveWorkspaces(
          config,
          projectPath,
          [
            projectWorkspace(projectPath, "sender", "sender"),
            projectWorkspace(projectPath, "target", "target", {
              unrelatedWorkspaceConsent: "consent",
            }),
          ],
          testTaskSettings()
        );
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService, historyService } = createTaskServiceHarness(config, {
          workspaceService,
        });
        reserveFamilyMessageTargetSlots(
          taskService,
          "target",
          TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_MESSAGES - 1
        );
        expect(
          await taskService.sendAgentTreeMessage("sender", "target", "Queued peer input")
        ).toMatchObject(Ok({ delivery: "queued" }));
        const [, , , internal] = sendMessage.mock.calls[0] as Parameters<
          WorkspaceHost["sendMessage"]
        >;
        expect(internal?.admissionStale?.()).toBe(false);

        await config.editConfig((cfg) => {
          const entry = findWorkspaceEntry(cfg, endpoint);
          assert(entry);
          entry.workspace.runtimeConfig = { type: "docker", image: "node:22" };
          return cfg;
        });
        expect(internal?.admissionStale?.()).toBe(true);
        await internal?.onCanceled?.("Endpoint runtime changed before dispatch");
        expect(await collectFullHistory(historyService, "target")).toEqual([]);

        await config.editConfig((cfg) => {
          const entry = findWorkspaceEntry(cfg, endpoint);
          assert(entry);
          entry.workspace.runtimeConfig = { type: "local" };
          return cfg;
        });
        // The sole available target slot must have been returned by queue cancellation.
        expect(
          (await taskService.sendAgentTreeMessage("sender", "target", "After local restore"))
            .success
        ).toBe(true);
      }
    );

    test.each(["workflow", "best-of"] as const)(
      "refuses unrelated sends from a %s endpoint",
      async (restriction) => {
        const config = await createTestConfig(rootDir);
        const projectPath = path.join(rootDir, "repo");
        await saveWorkspaces(
          config,
          projectPath,
          [
            projectWorkspace(projectPath, "source-root", "source-root"),
            projectWorkspace(projectPath, "sender", "sender", {
              unrelatedWorkspaceConsent: "sender-consent",
              parentWorkspaceId: "source-root",
              taskStatus: "running",
              ...(restriction === "workflow"
                ? { workflowTask: { runId: "wfr_peer", stepId: "step" } }
                : { bestOf: { groupId: "group", index: 0, total: 2 } }),
            }),
            projectWorkspace(projectPath, "target", "target", {
              unrelatedWorkspaceConsent: "consent",
            }),
          ],
          testTaskSettings()
        );
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService } = createTaskServiceHarness(config, { workspaceService });
        expect(await taskService.sendAgentTreeMessage("sender", "target", "Hello")).toMatchObject(
          Err({ code: "refused" })
        );
        expect(await taskService.sendAgentTreeMessage("target", "sender", "Reply")).toMatchObject(
          Err({ code: "refused" })
        );
        expect(sendMessage).not.toHaveBeenCalled();
      }
    );

    test("keeps the owner's correlation on an unrelated live child's reawakened execution", async () => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "sender", "sender"),
          projectWorkspace(projectPath, "foreign-root", "foreign-root", {
            unrelatedWorkspaceConsent: "root-consent",
          }),
          projectWorkspace(projectPath, "target", "target", {
            parentWorkspaceId: "foreign-root",
            taskStatus: "reported",
            taskExecutionStatus: "running",
            taskExecutionId: "wst_live",
            agentId: "explore",
            taskModelString: "openai:gpt-5.2",
            taskThinkingLevel: "medium",
          }),
        ],
        testTaskSettings()
      );
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      await registerLiveWorkspaceTurnHandle(taskService, "target", "wst_live", "foreign-root");
      // A parent's opt-in cannot grant access to its child, even during a live execution.
      expect(
        await taskService.sendAgentTreeMessage("sender", "target", "Parent consent only")
      ).toEqual(Err({ code: "not_found" }));
      expect(sendMessage).not.toHaveBeenCalled();
      await config.editConfig((cfg) => {
        const entry = findWorkspaceEntry(cfg, "target");
        assert(entry);
        entry.workspace.unrelatedWorkspaceConsent = "child-consent";
        return cfg;
      });
      expect(
        await taskService.sendAgentTreeMessage("sender", "target", "Reply to live execution")
      ).toEqual(
        Ok({ delivery: "queued", relation: "target_unrelated", queueDispatchMode: "turn-end" })
      );
      const [, , options, internal] = sendMessage.mock.calls[0] as Parameters<
        WorkspaceHost["sendMessage"]
      >;
      expect(options).toMatchObject({
        agentId: "explore",
        model: "openai:gpt-5.2",
        thinkingLevel: "medium",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_live",
          ownerWorkspaceId: "foreign-root",
          agentPeerMessageTrigger: { relationship: "unrelated", fromWorkspaceId: "sender" },
        },
      });
      expect(internal?.workspaceTurnContinuation).toBe(true);
      expect(
        workspaceTurnManagerFor(taskService).getLiveWorkspaceTurnRegistration("target")
      ).toMatchObject({ handleId: "wst_live", accepted: true });
      expect((await workspaceTurnSnapshot(taskService, "foreign-root", "wst_live"))?.status).toBe(
        "running"
      );
    });
  });

  test("sendAgentTreeMessage refuses workflow-owned and best-of endpoints for peer sends", async () => {
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
        projectWorkspace(projectPath, "wf-child", "wf-child", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
          workflowTask: { runId: "wfr_peer", stepId: "step" },
        }),
        projectWorkspace(projectPath, "cand", "cand-1", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
          bestOf: { groupId: "grp", index: 0, total: 2 },
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // Workflow-owned target and workflow-owned sender are both refused.
    expect(await taskService.sendAgentTreeMessage("sib-a", "wf-child", "hi")).toEqual(
      Err({ code: "refused", reason: "Workflow-owned tasks cannot send or receive peer messages." })
    );
    expect(await taskService.sendAgentTreeMessage("wf-child", "sib-a", "hi")).toEqual(
      Err({ code: "refused", reason: "Workflow-owned tasks cannot send or receive peer messages." })
    );

    // Best-of candidates: sibling↔candidate and candidate→ancestor alike.
    expect(await taskService.sendAgentTreeMessage("sib-a", "cand-1", "hi")).toEqual(
      Err({ code: "refused", reason: "Best-of candidates cannot send or receive peer messages." })
    );
    expect(await taskService.sendAgentTreeMessage("cand-1", "tree-root", "hi")).toEqual(
      Err({ code: "refused", reason: "Best-of candidates cannot send or receive peer messages." })
    );
    expect(sendMessage).not.toHaveBeenCalled();

    // Ancestor→candidate guidance stays allowed (trusted descendant path).
    const guidance = await taskService.sendAgentTreeMessage("tree-root", "cand-1", "guidance");
    expect(guidance.success).toBe(true);
  });

  test("sendAgentTreeMessage returns not_active for queued and terminal peer targets without side effects", async () => {
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
        projectWorkspace(projectPath, "sib-q", "sib-q", {
          parentWorkspaceId: "tree-root",
          taskStatus: "queued",
          taskPrompt: "original launch prompt",
        }),
        projectWorkspace(projectPath, "sib-r", "sib-r", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage, create } = createWorkspaceServiceMocks();
    // isStreaming true: finalizeAgentTaskReport marks a task `reported` while its stream is
    // still winding down — terminal statuses must reject WITHOUT a transient-stream rescue, or
    // the trigger would queue behind the completing turn and reactivate the reported task.
    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => true) });
    const { taskService } = createTaskServiceHarness(config, { workspaceService, aiService });

    // Queued target: only an ancestor may mutate the durable launch prompt.
    const queuedResult = await taskService.sendAgentTreeMessage("sib-a", "sib-q", "hi");
    expect(queuedResult.success).toBe(false);
    if (!queuedResult.success) {
      expect(queuedResult.error.code).toBe("not_active");
    }
    expect(findWorkspaceInConfig(config, "sib-q")?.taskPrompt).toBe("original launch prompt");

    // Terminal target: peers cannot reactivate (that would reroute agent_report ownership).
    const terminalResult = await taskService.sendAgentTreeMessage("sib-a", "sib-r", "hi");
    expect(terminalResult.success).toBe(false);
    if (!terminalResult.success) {
      expect(terminalResult.error.code).toBe("not_active");
    }
    expect(create).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage surfaces broker rate-limit refusals", async () => {
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
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService,
    });
    for (let i = 0; i < PEER_MESSAGE_RATE_LIMIT_MAX; i++) {
      taskService.resetAutoResumeCount("sib-b");
      expect(
        (await taskService.sendAgentTreeMessage("sib-a", "sib-b", `message ${i}`)).success
      ).toBe(true);
    }

    taskService.resetAutoResumeCount("sib-b");
    const limited = await taskService.sendAgentTreeMessage("sib-a", "sib-b", "limited");
    expect(limited.success).toBe(false);
    if (!limited.success) {
      expect(limited.error.code).toBe("rate_limited");
    }
  });

  test("sendAgentTreeMessage charges the consecutive-wake budget at admission, before dispatch", async () => {
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
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    // The busy-target mock never dequeues entries (no onAccepted), so this exercises the
    // admission-time charge: undispatched sends must fill the budget with no
    // dequeue-to-acceptance gap for parallel senders to slip through.
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    for (let i = 1; i <= 3; i++) {
      const result = await taskService.sendAgentTreeMessage("sib-a", "sib-b", `queued wake ${i}`);
      expect(result).toEqual(
        Ok({ delivery: "queued", relation: "peer", queueDispatchMode: "tool-end" })
      );
    }
    expect(sendMessage).toHaveBeenCalledTimes(3);

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "queued wake 4")).toEqual(
      Err({
        code: "refused",
        reason:
          "Target reached its consecutive peer-wake limit and needs user or parent attention.",
      })
    );
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  test("sendAgentTreeMessage refuses targets hard-interrupted by the user", async () => {
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
        projectWorkspace(projectPath, "child-b", "child-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const interruptRefusal = Err({
      code: "refused" as const,
      reason:
        "Target was interrupted by the user and will not accept agent messages until the user resumes it.",
    });
    // The user's stop must win a race against a descendant's message: no queued or started turn.
    taskService.markParentWorkspaceInterrupted("tree-root");
    expect(await taskService.sendAgentTreeMessage("child-a", "tree-root", "status?")).toEqual(
      interruptRefusal
    );
    // The suppression set holds the interrupted ANCESTOR: a sibling target under it must also
    // refuse even before the termination cascade reaches that sibling.
    expect(await taskService.sendAgentTreeMessage("child-a", "child-b", "psst")).toEqual(
      interruptRefusal
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage refuses terminal and archived senders", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        // Reported sender: its stream may still be winding down (a late tool call racing
        // task_stop/agent_report), but the terminal boundary must win.
        projectWorkspace(projectPath, "sib-done", "sib-done", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
        }),
        projectWorkspace(projectPath, "sib-arch", "sib-arch", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
          archivedAt: "2026-08-10T00:00:00.000Z",
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

    const senderRefusal = Err({
      code: "refused" as const,
      reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
    });
    expect(await taskService.sendAgentTreeMessage("sib-done", "sib-b", "late send")).toEqual(
      senderRefusal
    );
    expect(await taskService.sendAgentTreeMessage("sib-arch", "sib-b", "late send")).toEqual(
      senderRefusal
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage refuses at the admission probe when the target is stopped mid-send", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const workspaces = (targetStatus: "running" | "interrupted") => [
      projectWorkspace(projectPath, "root", "tree-root"),
      projectWorkspace(projectPath, "sib-a", "sib-a", {
        parentWorkspaceId: "tree-root",
        taskStatus: "running" as const,
      }),
      projectWorkspace(projectPath, "sib-b", "sib-b", {
        parentWorkspaceId: "tree-root",
        taskStatus: targetStatus,
      }),
    ];
    await saveWorkspaces(config, projectPath, workspaces("running"), testTaskSettings());

    // Simulate task_stop landing during WorkspaceService.sendMessage's internal awaits (pricing
    // gate, settings persistence): stopDescendantAgentTask persists taskStatus="interrupted"
    // under the task-tree lifecycle lock — NOT the target's event lock — so only the admission
    // probe re-evaluated inside sendMessage can observe it.
    const sendMessage = mock(
      async (
        _targetId: string,
        _message: string,
        _options: unknown,
        internal: { admissionStale?: () => boolean }
      ) => {
        await saveWorkspaces(config, projectPath, workspaces("interrupted"), testTaskSettings());
        // Mirror the real admission points: a stale probe refuses instead of queueing or
        // resurrecting the stopped task via markInterruptedTaskRunning.
        expect(internal.admissionStale?.()).toBe(true);
        return Err({ type: "unknown", raw: "send admission stale" });
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "status?")).toEqual(
      Err({
        code: "not_active",
        taskStatus: "interrupted",
        message:
          "Target stopped before the message was admitted; peer messages cannot reactivate it.",
      })
    );
  });

  test("sendAgentTreeMessage latches a stop even when the user resumes before dispatch", async () => {
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
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    // Stop followed by a quick user resume entirely between probe evaluations: the
    // level-triggered suppression set and persisted status read clean again afterwards, so
    // only the latched stop generation can keep the in-flight send stale — the resumed
    // workspace belongs to the user, not to a wake admitted before the stop.
    const serviceHolder: { current?: TaskService } = {};
    const sendMessage = mock(
      (
        _targetId: string,
        _message: string,
        _options: unknown,
        internal: { admissionStale?: () => boolean }
      ) => {
        serviceHolder.current?.markParentWorkspaceInterrupted("sib-b");
        serviceHolder.current?.resetAutoResumeCount("sib-b");
        expect(internal.admissionStale?.()).toBe(true);
        return Promise.resolve(Err({ type: "unknown", raw: "send admission stale" }));
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    serviceHolder.current = taskService;

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "ping")).toEqual(
      Err({
        code: "refused",
        reason:
          "Target was interrupted by the user and will not accept agent messages until the user resumes it.",
      })
    );
  });

  test("sendAgentTreeMessage refuses at the admission probe when the target is archived mid-send", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const workspaces = (targetArchivedAt?: string) => [
      projectWorkspace(projectPath, "root", "tree-root"),
      projectWorkspace(projectPath, "sib-a", "sib-a", {
        parentWorkspaceId: "tree-root",
        taskStatus: "running" as const,
      }),
      projectWorkspace(projectPath, "sib-b", "sib-b", {
        parentWorkspaceId: "tree-root",
        taskStatus: "running" as const,
        ...(targetArchivedAt != null ? { archivedAt: targetArchivedAt } : {}),
      }),
    ];
    await saveWorkspaces(config, projectPath, workspaces(), testTaskSettings());

    // Archive does not synchronize with in-flight guarded sends and leaves taskStatus
    // untouched, so only the probe's archived re-read can stop the peer turn from landing
    // behind the archive boundary.
    const sendMessage = mock(
      async (
        _targetId: string,
        _message: string,
        _options: unknown,
        internal: { admissionStale?: () => boolean }
      ) => {
        await saveWorkspaces(
          config,
          projectPath,
          workspaces("2026-08-24T00:00:00.000Z"),
          testTaskSettings()
        );
        expect(internal.admissionStale?.()).toBe(true);
        return Err({ type: "unknown", raw: "send admission stale" });
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "still around?")).toEqual(
      Err({
        code: "not_active",
        taskStatus: "running",
        message: "Target workspace is archived; only its parent can restore and reawaken it.",
      })
    );
  });

  test("sendAgentTreeMessage refuses when a sender ancestor is stopped mid-send", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "mid", "task-mid", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Sender is a grandchild under the stopped branch; the target is outside it.
        projectWorkspace(projectPath, "leaf", "task-leaf", {
          parentWorkspaceId: "task-mid",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "cousin", "task-cousin", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    // The user hard-stops the intermediate workspace while the leaf's send is in flight: the
    // descendant cascade has not reached the leaf (its status still reads running), so only
    // the sender-chain suppression/generation check can keep the stopped subtree from waking
    // workspaces outside it.
    const serviceHolder: { current?: TaskService } = {};
    const sendMessage = mock(
      (
        _targetId: string,
        _message: string,
        _options: unknown,
        internal: { admissionStale?: () => boolean }
      ) => {
        serviceHolder.current?.markParentWorkspaceInterrupted("task-mid");
        expect(internal.admissionStale?.()).toBe(true);
        return Promise.resolve(Err({ type: "unknown", raw: "send admission stale" }));
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    serviceHolder.current = taskService;

    expect(await taskService.sendAgentTreeMessage("task-leaf", "task-cousin", "update?")).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );
  });

  test("sendAgentTreeMessage refuses sends entering while the sender's subtree stop is persisting", async () => {
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
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    // task_stop bumps the subtree's stop epochs synchronously, then awaits stream shutdown
    // before persisting terminal statuses. A send ENTERING in that window captures the bumped
    // epochs as its clean baseline while the sender still reads running — only the in-progress
    // stop latch can refuse it, keeping a prompt-influenced agent in the stopped subtree from
    // waking workspaces outside it.
    let markStopStarted: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve;
    });
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopStream = mock(async (workspaceId: string) => {
      if (workspaceId === "sib-a") {
        markStopStarted?.();
        await stopGate;
      }
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === "sib-a");
    const { aiService } = createAIServiceMocks(config, { isStreaming, stopStream });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const stopping = taskService.stopDescendantAgentTask("tree-root", "sib-a");
    await stopStarted;

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "escape the stop")).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );

    releaseStop?.();
    expect(await stopping).toEqual(Ok({ stoppedTaskIds: ["sib-a"] }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage refuses sends entering while the target's stop is persisting", async () => {
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
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    // Mirror of the sender-side window: the target's stop is mid-cascade (epochs bumped,
    // terminal status not yet persisted), so a send entering now must observe the target's
    // in-progress stop latch instead of queueing a wake the stop was meant to prevent.
    let markStopStarted: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve;
    });
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopStream = mock(async (workspaceId: string) => {
      if (workspaceId === "sib-b") {
        markStopStarted?.();
        await stopGate;
      }
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === "sib-b");
    const { aiService } = createAIServiceMocks(config, { isStreaming, stopStream });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const stopping = taskService.stopDescendantAgentTask("tree-root", "sib-b");
    await stopStarted;

    // The cascade persists the terminal status before its (still pending) stream stop, so the
    // entering send is refused on the persisted status; the latch still covers the window.
    expect(taskService.isWorkspaceStopInProgress("sib-b")).toBe(true);
    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "beat the stop")).toEqual(
      Err({
        code: "not_active",
        message: "Target is inactive; peer messages cannot reactivate it — ask its parent.",
        taskStatus: "interrupted",
      })
    );

    releaseStop?.();
    expect(await stopping).toEqual(Ok({ stoppedTaskIds: ["sib-b"] }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage refuses sends escaping a hard-interrupt cascade after a user resume", async () => {
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
          taskStatus: "running",
        }),
        // Cousin outside the interrupted subtree: the only thing keeping the stopping leaf from
        // waking it mid-cascade is the descendant-set latch.
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    // Hard interrupt: markParentWorkspaceInterrupted's suppression entry is level-triggered and
    // the user's next real send clears it (resetAutoResumeCount) while the descendant cascade
    // may still be blocked in stopStream with taskStatus "running". The epoch bumps land before
    // an entering send captures its baseline, so only the cascade latch can refuse it.
    let markStopStarted: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve;
    });
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopStream = mock(async (workspaceId: string) => {
      if (workspaceId === "leaf-a") {
        markStopStarted?.();
        await stopGate;
      }
      return Ok(undefined);
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === "leaf-a");
    const { aiService } = createAIServiceMocks(config, { isStreaming, stopStream });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    taskService.markParentWorkspaceInterrupted("branch-a");
    const terminating = taskService.terminateAllDescendantAgentTasks("branch-a");
    await stopStarted;
    // User resumes the interrupted workspace mid-cascade: suppression clears, but leaf-a is
    // still being stopped.
    taskService.resetAutoResumeCount("branch-a");

    expect(await taskService.sendAgentTreeMessage("leaf-a", "sib-b", "escape the stop")).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );

    releaseStop?.();
    expect(await terminating).toEqual(["leaf-a"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage refunds budget reservations when dispatch throws pre-persistence", async () => {
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
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    // Awaited preparation/dispatch can THROW (e.g. a transient handle-store read failure), and
    // only returned failures reach the inline refund — a leaked reservation would consume the
    // session-wide budgets without delivering anything, eventually refusing valid messages
    // until restart.
    let failFirst = true;
    const sendMessage = mock((): Promise<Result<void>> => {
      if (failFirst) {
        failFirst = false;
        return Promise.reject(new Error("transient handle store failure"));
      }
      return Promise.resolve(Ok(undefined));
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // Exactly ONE aggregate slot left for sib-b: without the refund, the thrown first attempt
    // permanently consumes it and the follow-up is budget-refused.
    reserveFamilyMessageTargetSlots(
      taskService,
      "sib-b",
      TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_MESSAGES - 1
    );

    try {
      await taskService.sendAgentTreeMessage("sib-a", "sib-b", "first try");
      expect.unreachable("dispatch throw must propagate to the caller");
    } catch (error) {
      expect((error as Error).message).toBe("transient handle store failure");
    }

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "second try")).toEqual(
      Ok({ delivery: "queued", relation: "peer", queueDispatchMode: "tool-end" })
    );
  });

  test("sendAgentTreeMessage refunds queued sends canceled before dispatch", async () => {
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
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // One aggregate slot left: a queued-then-canceled send that never refunds would consume it
    // permanently and refuse the follow-up.
    reserveFamilyMessageTargetSlots(
      taskService,
      "sib-b",
      TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_MESSAGES - 1
    );

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "queued send")).toEqual(
      Ok({ delivery: "queued", relation: "peer", queueDispatchMode: "tool-end" })
    );
    // A busy target queued the entry; a user interrupt clears the queue before dispatch —
    // AgentSession invokes the entry's onCanceled, which must release the reservation.
    const [, , , internalArg] = sendMessage.mock.calls[0] as [
      string,
      string,
      unknown,
      { onCanceled?: (reason: string) => void },
    ];
    expect(internalArg.onCanceled).toBeDefined();
    internalArg.onCanceled?.("Queue cleared before dispatch");

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "after cancel")).toEqual(
      Ok({ delivery: "queued", relation: "peer", queueDispatchMode: "tool-end" })
    );
  });

  test("failed hard-interrupt cascade persistence retains the descendant's stop latch", async () => {
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
          taskStatus: "running",
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

    taskService.markParentWorkspaceInterrupted("branch-a");
    // Persistence of leaf-a's interrupted status fails: interruptStream's outer catch
    // suppresses the error and reports success, so without fail-closed latch retention the
    // still-running descendant would resume peer sends right after the failed cascade.
    const editSpy = spyOn(config, "editConfig").mockImplementationOnce(() =>
      Promise.reject(new Error("read-only config"))
    );
    expect(await taskService.terminateAllDescendantAgentTasks("branch-a")).toEqual([]);
    editSpy.mockRestore();
    expect(findWorkspaceInConfig(config, "leaf-a")?.taskStatus).toBe("running");

    // User resume clears the level-triggered suppression; only the retained latch refuses.
    taskService.resetAutoResumeCount("branch-a");
    expect(
      await taskService.sendAgentTreeMessage("leaf-a", "sib-b", "escape the failed stop")
    ).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage refuses sends latched at the hard-stop request boundary", async () => {
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
          taskStatus: "running",
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

    // WorkspaceService.interruptStream marks + latches synchronously at the request boundary,
    // then AWAITS the session interrupt before the descendant cascade begins. A user resume
    // during that await clears the level-triggered suppression while no descendant epoch has
    // been bumped and the cascade latch does not exist yet — only the boundary latch can refuse
    // sends entering here.
    taskService.markParentWorkspaceInterrupted("branch-a");
    const releaseHardStopLatch = taskService.latchHardInterruptCascade("branch-a");
    taskService.resetAutoResumeCount("branch-a");

    expect(await taskService.sendAgentTreeMessage("leaf-a", "sib-b", "escape the stop")).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );
    expect(await taskService.sendAgentTreeMessage("sib-b", "leaf-a", "wake the leaf")).toEqual(
      Err({
        code: "refused",
        reason:
          "Target was interrupted by the user and will not accept agent messages until the user resumes it.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();

    // interruptStream releases in its finally (including the failed-interrupt path); with
    // suppression already cleared by the resume, peer messaging must recover — the boundary
    // latch must not leak.
    releaseHardStopLatch();
    expect(await taskService.sendAgentTreeMessage("leaf-a", "sib-b", "after release")).toEqual(
      Ok({ delivery: "queued", relation: "peer", queueDispatchMode: "tool-end" })
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
