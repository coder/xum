import * as path from "path";
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { readSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { Ok, type Result } from "@/common/types/result";
import { createMuxMessage } from "@/common/types/message";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  streamEnd,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
  removeWorkspaceFromTestConfig,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  test("non-plan subagent stream-end with final assistant text finalizes an implicit report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-progress-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Early finding", title: "Finding" },
          state: "output-available",
          output: { success: true },
        },
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-progress-2",
          toolName: "agent_report",
          input: { reportMarkdown: "Later finding", title: "Latest update" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "## Final answer\n\nImplicit report content from the child." },
      ],
    });

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("output-available");
      const outputJson = JSON.stringify(toolPart?.output);
      expect(outputJson).toContain("Implicit report content from the child.");
      expect(outputJson).not.toContain("fallback");
    }

    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe(
      "## Final answer\n\nImplicit report content from the child."
    );
    expect(report?.title).toBe("Latest update");

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("reported");

    expect(remove).not.toHaveBeenCalled();
    const sendCalls = (sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of sendCalls) {
      const msg = call[1] as string;
      expect(msg).not.toContain("agent_report");
    }
  });

  test("workflow subagent reuses structured agent_report metadata from an earlier turn", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-structured-history";
    const childId = "child-structured-history";
    const workflowRunId = "wfr_structured_history";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["claims"],
              properties: { claims: { type: "array", items: { type: "string" } } },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "structured-history",
        description: "Structured history",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const progressMessage = createMuxMessage(
      "assistant-progress",
      "assistant",
      "",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-progress",
          toolName: "agent_report",
          input: { claims: ["persisted"] },
          state: "output-available",
          output: { success: true },
        },
      ]
    );
    expect((await historyService.appendToHistory(childId, progressMessage)).success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "## Final answer\n\nFinal prose after an earlier update." }],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe("## Final answer\n\nFinal prose after an earlier update.");
    expect(report?.structuredOutput).toEqual({ claims: ["persisted"] });
  });

  test("workflow subagent uses agent_report metadata with the final assistant response", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-structured-text";
    const childId = "child-structured-text";
    const workflowRunId = "wfr_structured_text";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["claims"],
              properties: { claims: { type: "array", items: { type: "string" } } },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "structured-text",
        description: "Structured text",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-structured",
          toolName: "agent_report",
          input: { claims: ["verified"] },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "## Final answer\n\nThis prose is the final workflow summary." },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe(
      "## Final answer\n\nThis prose is the final workflow summary."
    );
    expect(report?.structuredOutput).toEqual({ claims: ["verified"] });
  });

  test("failed final workflow agent_report does not reuse stale structured output", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-stale-structured";
    const childId = "child-stale-structured";
    const workflowRunId = "wfr_stale_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "stale-structured",
        description: "Stale structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    expect(
      (
        await historyService.appendToHistory(
          childId,
          createMuxMessage("assistant-progress", "assistant", "", { timestamp: Date.now() }, [
            {
              type: "dynamic-tool",
              toolCallId: "agent-report-old",
              toolName: "agent_report",
              input: { claims: ["stale"] },
              state: "output-available",
              output: { success: true },
            },
          ])
        )
      ).success
    ).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-failed",
          toolName: "agent_report",
          input: { claims: [1] },
          state: "output-available",
          output: {
            success: false,
            message: "Structured output failed schema validation.",
            errors: [{ path: "$.claims[0]", message: "must be string" }],
          },
        },
        { type: "text", text: "Final summary should not reuse stale output." },
      ],
    });

    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(
      await readSubagentReportArtifact(path.join(config.sessionsDir, parentId), childId)
    ).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("First call agent_report"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
  });

  test("failed newer in-turn workflow agent_report invalidates an earlier success", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-in-turn-stale-structured";
    const childId = "child-in-turn-stale-structured";
    const workflowRunId = "wfr_in_turn_stale_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "in-turn-stale-structured",
        description: "In-turn stale structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-success",
          toolName: "agent_report",
          input: { claims: ["stale"] },
          state: "output-available",
          output: { success: true },
        },
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-failed",
          toolName: "agent_report",
          input: { claims: [1] },
          state: "output-available",
          output: {
            success: false,
            message: "Structured output failed schema validation.",
            errors: [{ path: "$.claims[0]", message: "must be string" }],
          },
        },
        { type: "text", text: "Final summary after failed replacement." },
      ],
    });

    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(
      await readSubagentReportArtifact(path.join(config.sessionsDir, parentId), childId)
    ).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("First call agent_report"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
  });

  test("newer valid in-turn workflow agent_report corrects an earlier failure", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-corrected-structured";
    const childId = "child-corrected-structured";
    const workflowRunId = "wfr_corrected_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "corrected-structured",
        description: "Corrected structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-failed",
          toolName: "agent_report",
          input: { claims: [1] },
          state: "output-available",
          output: {
            success: false,
            message: "Structured output failed schema validation.",
            errors: [{ path: "$.claims[0]", message: "must be string" }],
          },
        },
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-corrected",
          toolName: "agent_report",
          input: { claims: ["corrected"] },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Final summary after correcting structured output." },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe("Final summary after correcting structured output.");
    expect(report?.structuredOutput).toEqual({ claims: ["corrected"] });
  });

  test("recovery final text does not scan past a failed workflow agent_report", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-recovery-stale-structured";
    const childId = "child-recovery-stale-structured";
    const workflowRunId = "wfr_recovery_stale_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "recovery-stale-structured",
        description: "Recovery stale structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    for (const message of [
      createMuxMessage("assistant-old-progress", "assistant", "", { timestamp: Date.now() - 2 }, [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-old",
          toolName: "agent_report",
          input: { claims: ["stale"] },
          state: "output-available",
          output: { success: true },
        },
      ]),
      createMuxMessage(
        "assistant-failed-progress",
        "assistant",
        "",
        { timestamp: Date.now() - 1 },
        [
          {
            type: "dynamic-tool",
            toolCallId: "agent-report-failed",
            toolName: "agent_report",
            input: { claims: [1] },
            state: "output-available",
            output: {
              success: false,
              message: "Structured output failed schema validation.",
              errors: [{ path: "$.claims[0]", message: "must be string" }],
            },
          },
        ]
      ),
    ]) {
      expect((await historyService.appendToHistory(childId, message)).success).toBe(true);
    }

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-recovery-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "Recovery final text without a fresh structured report." }],
    });

    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(
      await readSubagentReportArtifact(path.join(config.sessionsDir, parentId), childId)
    ).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("First call agent_report"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
  });

  test("workflow subagent invalid structured agent_report does not finalize", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-invalid-structured";
    const childId = "child-invalid-structured";
    const workflowRunId = "wfr_invalid_structured";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["claims"],
              properties: { claims: { type: "array", items: { type: "string" } } },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "invalid-structured",
        description: "Invalid structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Done",
            structuredOutput: { claims: [1] },
            title: null,
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Final summary with invalid structured metadata." },
      ],
    });

    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("The previous final assistant response attempt failed"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(
      await readSubagentReportArtifact(path.join(config.sessionsDir, parentId), childId)
    ).toBeNull();
  });

  test("legacy workflow subagent with invalid old outputSchema can finalize markdown-only report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-legacy-invalid-schema";
    const childId = "child-legacy-invalid-schema";
    const workflowRunId = "wfr_legacy_invalid_schema";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: { $ref: "#/defs/pre-upgrade" },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "legacy-invalid-schema",
        description: "Legacy invalid schema",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Legacy report",
            title: null,
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Legacy report" },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe("Legacy report");
    expect(report?.structuredOutput).toBeUndefined();
  });

  test("legacy invalid workflow schemas recover with a final response instead of structured agent_report", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-legacy-invalid-recovery";
    const childId = "child-legacy-invalid-recovery";
    const workflowRunId = "wfr_legacy_invalid_recovery";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: { $ref: "#/defs/pre-upgrade" },
          },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "legacy-invalid-recovery",
        description: "Legacy invalid recovery",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      promptTaskForRequiredCompletionTool: (
        workspaceId: string,
        options: { expectedAttemptId: string | null }
      ) => Promise<boolean>;
    };

    expect(
      await internal.promptTaskForRequiredCompletionTool(childId, { expectedAttemptId: null })
    ).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("respond with your final assistant message"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain("First call agent_report");
  });

  test("workflow subagent treats strict-provider null optional fields as omitted", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-optional-null-structured";
    const childId = "child-optional-null-structured";
    const workflowRunId = "wfr_optional_null_structured";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["code", "nested"],
              properties: {
                code: { type: "string" },
                notes: { type: "string" },
                nullableNote: { type: ["string", "null"] },
                nested: {
                  type: "object",
                  required: ["id"],
                  properties: {
                    id: { type: "string" },
                    detail: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "optional-null-structured",
        description: "Optional null structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            code: "ABC",
            notes: null,
            nullableNote: null,
            nested: { id: "nested-1", detail: null },
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Optional fields normalized." },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.structuredOutput).toEqual({
      code: "ABC",
      nullableNote: null,
      nested: { id: "nested-1" },
    });
  });

  test("workflow subagent accepts direct schema-shaped report for object schema", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-missing-structured";
    const childId = "child-missing-structured";
    const workflowRunId = "wfr_missing_structured";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: { type: "object" },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "missing-structured",
        description: "Missing structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Done",
            title: null,
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Done" },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe("Done");
    expect(report?.structuredOutput).toEqual({ reportMarkdown: "Done", title: null });
  });

  test("length-truncated final assistant text still requires explicit agent_report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "length" },
      parts: [{ type: "text", text: "Partial final-looking text that was cut off" }],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("awaiting_report");
  });

  test("missing agent_report keeps the task awaiting_report and retries with agent_report-only prompts", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      childId,
      expect.stringContaining("Do not continue investigating or call other tools"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("awaiting_report");

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("input-available");
      expect(toolPart?.output).toBeUndefined();
    }

    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
});
