import { describe, it, expect, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { Ok, type Result } from "@/common/types/result";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { WorkspaceLifecycleResult } from "@/node/services/taskWorkspaceSeam";
import { createTaskWorkspaceLifecycleTool } from "./task_workspace_lifecycle";
import { TestTempDir, createFakeWorkspaceTurnManager, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

describe("task_workspace_lifecycle tool", () => {
  it("archives each target through the scoped task service lifecycle API", async () => {
    using tempDir = new TestTempDir("test-task-workspace-lifecycle-archive");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const archiveOwnedWorkspaceTurnWorkspace = mock(
      (): Promise<Result<WorkspaceLifecycleResult, string>> =>
        Promise.resolve(
          Ok({ status: "archived" as const, action: "archive" as const, workspaceId: "child-a" })
        )
    );
    const workspaceTurnManager = createFakeWorkspaceTurnManager({
      archiveOwnedWorkspaceTurnWorkspace,
    });
    const tool = createTaskWorkspaceLifecycleTool({ ...baseConfig, workspaceTurnManager });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { action: "archive", targets: [{ workspaceId: "child-a" }], interrupt_active: true },
        mockToolCallOptions
      )
    );

    expect(archiveOwnedWorkspaceTurnWorkspace).toHaveBeenCalledWith(
      "root-workspace",
      { workspaceId: "child-a" },
      { interruptActive: true }
    );
    expect(result).toEqual({
      results: [{ status: "archived", action: "archive", workspaceId: "child-a" }],
    });
  });

  it("dedupes duplicate targets before dispatching", async () => {
    using tempDir = new TestTempDir("test-task-workspace-lifecycle-dedupe");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const archiveOwnedWorkspaceTurnWorkspace = mock(
      (): Promise<Result<WorkspaceLifecycleResult, string>> =>
        Promise.resolve(
          Ok({ status: "archived" as const, action: "archive" as const, workspaceId: "child-a" })
        )
    );
    const workspaceTurnManager = createFakeWorkspaceTurnManager({
      archiveOwnedWorkspaceTurnWorkspace,
    });
    const tool = createTaskWorkspaceLifecycleTool({ ...baseConfig, workspaceTurnManager });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          action: "archive",
          targets: [{ workspaceId: "child-a" }, { workspaceId: "child-a" }],
        },
        mockToolCallOptions
      )
    );

    expect(archiveOwnedWorkspaceTurnWorkspace).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      results: [{ status: "archived", action: "archive", workspaceId: "child-a" }],
    });
  });

  it("routes unarchive to the scoped unarchive API without interrupt options", async () => {
    using tempDir = new TestTempDir("test-task-workspace-lifecycle-unarchive");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const unarchiveOwnedWorkspaceTurnWorkspace = mock(
      (): Promise<Result<WorkspaceLifecycleResult, string>> =>
        Promise.resolve(
          Ok({
            status: "unarchived" as const,
            action: "unarchive" as const,
            taskId: "wst_child",
            workspaceId: "child-a",
          })
        )
    );
    const workspaceTurnManager = createFakeWorkspaceTurnManager({
      unarchiveOwnedWorkspaceTurnWorkspace,
    });
    const tool = createTaskWorkspaceLifecycleTool({ ...baseConfig, workspaceTurnManager });

    // interrupt_active applies to archive only; unarchive must never receive it.
    const result: unknown = await Promise.resolve(
      tool.execute!(
        { action: "unarchive", targets: [{ taskId: "wst_child" }], interrupt_active: true },
        mockToolCallOptions
      )
    );

    expect(unarchiveOwnedWorkspaceTurnWorkspace).toHaveBeenCalledWith("root-workspace", {
      taskId: "wst_child",
    });
    expect(result).toEqual({
      results: [
        {
          status: "unarchived",
          action: "unarchive",
          taskId: "wst_child",
          workspaceId: "child-a",
        },
      ],
    });
  });

  it("rejects model-supplied untracked-file acknowledgements at the input schema boundary", () => {
    // #3950: any path list returned to the model can be echoed back by the model, so a
    // model-side acknowledgement is not user consent. The live schema must not accept one;
    // lossy archives are refused and the user archives through the UI confirmation instead.
    const echoedAcknowledgement = {
      action: "archive" as const,
      targets: [{ workspaceId: "child-a" }],
      acknowledged_untracked_paths: { "child-a": ["scratch.txt"] },
    };
    expect(
      TOOL_DEFINITIONS.task_workspace_lifecycle.schema.safeParse(echoedAcknowledgement).success
    ).toBe(false);
  });

  it("isolates one target's unexpected throw as a per-target error result", async () => {
    using tempDir = new TestTempDir("test-task-workspace-lifecycle-isolation");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const archiveOwnedWorkspaceTurnWorkspace = mock(
      (
        _owner: string,
        target: { workspaceId?: string }
      ): Promise<Result<WorkspaceLifecycleResult, string>> => {
        if (target.workspaceId === "child-b") {
          throw new Error("unexpected lifecycle failure");
        }
        return Promise.resolve(
          Ok({ status: "archived" as const, action: "archive" as const, workspaceId: "child-a" })
        );
      }
    );
    const workspaceTurnManager = createFakeWorkspaceTurnManager({
      archiveOwnedWorkspaceTurnWorkspace,
    });
    const tool = createTaskWorkspaceLifecycleTool({ ...baseConfig, workspaceTurnManager });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          action: "archive",
          targets: [{ workspaceId: "child-a" }, { workspaceId: "child-b" }],
        },
        mockToolCallOptions
      )
    );

    expect(result).toEqual({
      results: [
        { status: "archived", action: "archive", workspaceId: "child-a" },
        {
          status: "error",
          action: "archive",
          workspaceId: "child-b",
          error: "unexpected lifecycle failure",
        },
      ],
    });
  });

  it("selects a valid workspaceId when the accompanying taskId is blank", async () => {
    using tempDir = new TestTempDir("test-task-workspace-lifecycle-blank-task-id");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const archiveOwnedWorkspaceTurnWorkspace = mock(
      (): Promise<Result<WorkspaceLifecycleResult, string>> =>
        Promise.resolve(
          Ok({ status: "archived" as const, action: "archive" as const, workspaceId: "child-a" })
        )
    );
    const workspaceTurnManager = createFakeWorkspaceTurnManager({
      archiveOwnedWorkspaceTurnWorkspace,
    });
    const tool = createTaskWorkspaceLifecycleTool({ ...baseConfig, workspaceTurnManager });

    // The input schema treats a whitespace-only identifier as absent; target normalization must
    // apply the same trimmed-presence rule instead of selecting the blank taskId and failing
    // invalid_scope.
    const result: unknown = await Promise.resolve(
      tool.execute!(
        { action: "archive", targets: [{ taskId: "   ", workspaceId: "child-a" }] },
        mockToolCallOptions
      )
    );

    expect(archiveOwnedWorkspaceTurnWorkspace).toHaveBeenCalledWith(
      "root-workspace",
      { workspaceId: "child-a" },
      expect.anything()
    );
    expect(result).toEqual({
      results: [{ status: "archived", action: "archive", workspaceId: "child-a" }],
    });
  });

  it("rejects non-workspace-turn task IDs without touching the task service", async () => {
    using tempDir = new TestTempDir("test-task-workspace-lifecycle-invalid-scope");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });

    const archiveOwnedWorkspaceTurnWorkspace = mock(
      (): Promise<Result<WorkspaceLifecycleResult, string>> =>
        Promise.reject(new Error("must not be called"))
    );
    const workspaceTurnManager = createFakeWorkspaceTurnManager({
      archiveOwnedWorkspaceTurnWorkspace,
    });
    const tool = createTaskWorkspaceLifecycleTool({ ...baseConfig, workspaceTurnManager });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { action: "archive", targets: [{ taskId: "subagent-child" }] },
        mockToolCallOptions
      )
    );

    expect(archiveOwnedWorkspaceTurnWorkspace).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [
        {
          status: "invalid_scope",
          action: "archive",
          taskId: "subagent-child",
          note: "task_workspace_lifecycle only accepts workspace-turn task IDs (wst_...).",
        },
      ],
    });
  });

  it("rejects plan-agent usage", async () => {
    using tempDir = new TestTempDir("test-task-workspace-lifecycle-plan-agent");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "root-workspace" });
    const tool = createTaskWorkspaceLifecycleTool({
      ...baseConfig,
      planFileOnly: true,
    });

    let caught: unknown;
    try {
      await Promise.resolve(
        tool.execute!(
          { action: "archive", targets: [{ workspaceId: "child" }] },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.message : "").toContain("not available in plan mode");
  });
});
