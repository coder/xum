import * as path from "path";
import * as fsPromises from "fs/promises";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspacesWithCheckouts as saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";
import {
  workspaceUseLeasesFor,
  workspaceUseLockDir,
  type WorkspaceUseKind,
} from "@/node/services/workspaceUseLeases";

/**
 * #4801: backend B starting on a root where backend A still runs a sub-agent task must not
 * re-drive that task. A's use lease on the task workspace (turn, init, MCP, command, terminal,
 * editor) is the cross-process evidence. Each backend is a real TaskService on its own Config.
 */
describe("startup recovery leaves tasks another live backend is using (#4801)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  const TASK_ID = "task-in-use";
  const ATTEMPT_ID = "att_00000000000000a1";

  async function saveTask(taskStatus: WorkspaceConfigEntry["taskStatus"]): Promise<void> {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", "parent-root"),
        projectWorkspace(projectPath, "task", TASK_ID, {
          parentWorkspaceId: "parent-root",
          agentId: "exec",
          agentType: "exec",
          taskStatus,
          taskAttemptId: ATTEMPT_ID,
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );
  }

  async function recoverInBackendB() {
    const configB = await createTestConfig(rootDir);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(configB, { workspaceService });
    await taskService.recoverInterruptedTasks();
    const messaged = (sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (call) => call[0]
    );
    return { configB, messaged };
  }

  test.each<[WorkspaceConfigEntry["taskStatus"], WorkspaceUseKind]>([
    ["running", "turn"],
    ["running", "mcp"],
    ["awaiting_report", "turn"],
    ["starting", "init"],
  ])(
    "a %s task whose workspace backend A holds a %s lease on is left alone",
    async (status, kind) => {
      await saveTask(status);
      const configA = await createTestConfig(rootDir);
      await workspaceUseLeasesFor(configA).hold(TASK_ID, kind);

      const { configB, messaged } = await recoverInBackendB();

      expect(messaged).not.toContain(TASK_ID);
      // No rotation, no unproven mark, no starting→queued flip: the row is A's as it was.
      const row = findWorkspaceInConfig(configB, TASK_ID);
      expect(row?.taskAttemptId).toBe(ATTEMPT_ID);
      expect(row?.taskAttemptUnproven).toBeUndefined();
      expect(row?.taskStatus).toBe(status);
    }
  );

  test("a task whose lease holder died is re-driven as after a restart", async () => {
    await saveTask("running");
    const configA = await createTestConfig(rootDir);
    await workspaceUseLeasesFor(configA).hold(TASK_ID, "turn");
    // A's process died: its lease record names a token no live process holds.
    const dir = workspaceUseLockDir(rootDir, TASK_ID);
    for (const name of await fsPromises.readdir(dir)) {
      const file = path.join(dir, name);
      const record = JSON.parse(await fsPromises.readFile(file, "utf-8")) as object;
      await fsPromises.writeFile(file, JSON.stringify({ ...record, token: "dead-owner" }));
    }

    const { configB, messaged } = await recoverInBackendB();

    expect(messaged).toContain(TASK_ID);
    const row = findWorkspaceInConfig(configB, TASK_ID);
    expect(row?.taskAttemptId).not.toBe(ATTEMPT_ID);
    expect(row?.taskAttemptUnproven).toBe(true);
  });
});
