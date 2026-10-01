import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Config } from "@/node/config";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { TaskService } from "@/node/services/taskService";
import {
  createTaskServiceStack,
  createTestProject,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";

/**
 * W8 (formal/workflow-runs MC_two_stall_fixed): a resuming workflow runner tombstones a
 * checkpointed child ID that has no task row before replacing it, so a stalled reservation's late
 * commit refuses (cross-process: WorkflowRunner.workflowRunsFormalRepro.test.ts). These cover the
 * two cases where the tombstone must be refused, because a commit has landed or still may land.
 */
const PARENT_ID = "parenttomb01";
const CHILD_ID = "tombchild001";

describe("TaskService.tombstoneUnpublishedReservation", () => {
  let root: DisposableTempDir;

  beforeEach(async () => {
    root = new DisposableTempDir("task-reservation-tombstone");
    const config = new Config(root.path);
    await fs.mkdir(config.srcDir, { recursive: true });
    const projectPath = await createTestProject(root.path, "repo", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "parent", PARENT_ID, { runtimeConfig: { type: "local" } })],
      testTaskSettings(4, 3)
    );
  });
  afterEach(() => {
    root[Symbol.dispose]();
  });

  /** One backend process: its own Config and TaskService on the shared root. */
  function backend(): { config: Config; taskService: TaskService } {
    const config = new Config(root.path);
    stubStableIds(config, [CHILD_ID]);
    const { taskService } = createTaskServiceStack(config);
    spyOn(
      taskService as unknown as { startReservedAgentTask: () => Promise<void> },
      "startReservedAgentTask"
    ).mockImplementation(() => Promise.resolve());
    return { config, taskService };
  }

  function reserve(
    taskService: TaskService,
    onTaskReserved?: () => Promise<void>
  ): ReturnType<TaskService["createMany"]> {
    return taskService.createMany(
      [
        {
          parentWorkspaceId: PARENT_ID,
          kind: "agent",
          agentId: "exec",
          prompt: "Summarize",
          title: "summarize",
          workflowTask: { runId: "wfr_tomb", stepId: "summarize" },
        },
      ],
      { onTaskReserved }
    );
  }

  const tombstonesOf = (config: Config) =>
    findWorkspaceInConfig(config, PARENT_ID)?.taskReservationTombstones;

  test("refuses once the child is published, so a live child is never replaced", async () => {
    const owner = backend();
    const created = await reserve(owner.taskService);
    expect(created.success).toBe(true);

    const other = backend();
    const tombstoned = await other.taskService.tombstoneUnpublishedReservation(PARENT_ID, CHILD_ID);
    expect(tombstoned).toEqual({ success: false, error: "the task was published" });
    expect(tombstonesOf(other.config)).toBeUndefined();
  });

  test("refuses while this process owns the reservation, whose commit then publishes", async () => {
    const owner = backend();
    let refusal: unknown;
    const created = await reserve(owner.taskService, async () => {
      refusal = await owner.taskService.tombstoneUnpublishedReservation(PARENT_ID, CHILD_ID);
    });
    expect(refusal).toEqual({
      success: false,
      error: "this process owns an attempt for the task",
    });
    expect(created.success).toBe(true);
    expect(findWorkspaceInConfig(owner.config, CHILD_ID)).toBeDefined();
    expect(tombstonesOf(owner.config)).toBeUndefined();
  });
});
