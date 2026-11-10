import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";

import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { pendingRemovalAdmissionMessage } from "@/constants/agentMessaging";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import {
  createTaskServiceStack,
  createTestProject,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";

/**
 * reawakenInterruptedTask's early exits that no other suite reaches: the stop-cascade barrier at
 * entry and the pendingRemoval refusal. Both must leave the row exactly as it was.
 */
describe("TaskService.reawakenInterruptedTask early exits", () => {
  const rootId = "root-reawaken";
  const taskId = "child-reawaken";
  const previousAttemptId = "att_00000000000000aa";
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;

  beforeEach(async () => {
    fixture = await createTestHistoryService();
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  async function setupInterruptedChild(overrides: Partial<WorkspaceConfigEntry> = {}) {
    const config = fixture.config;
    await fsPromises.mkdir(config.srcDir, { recursive: true });
    const projectPath = await createTestProject(fixture.tempDir, "repo", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId, { runtimeConfig: { type: "local" } }),
        projectWorkspace(projectPath, taskId, taskId, {
          parentWorkspaceId: rootId,
          agentType: "explore",
          agentId: "explore",
          taskStatus: "interrupted",
          taskAttemptId: previousAttemptId,
          taskModelString: "openai:gpt-5.2",
          runtimeConfig: { type: "local" },
          ...overrides,
        }),
      ],
      testTaskSettings(4, 3)
    );
    const { taskService } = createTaskServiceStack(config, {
      historyService: fixture.historyService,
    });
    return { config, taskService };
  }

  function expectRowUnchanged(config: Config) {
    const row = findWorkspaceInConfig(config, taskId);
    expect(row?.taskStatus).toBe("interrupted");
    expect(row?.taskAttemptId).toBe(previousAttemptId);
    expect(row?.taskAttemptUnproven).toBeUndefined();
  }

  test("a stop in progress makes an interrupted child not applicable until its latch releases", async () => {
    const { config, taskService } = await setupInterruptedChild();
    const release = taskService.latchHardInterruptCascade(taskId);

    expect(await taskService.reawakenInterruptedTask(taskId)).toEqual({ kind: "not-applicable" });
    expectRowUnchanged(config);

    // The barrier was the only reason: once the stop settles, the same row reawakens.
    release();
    const outcome = await taskService.reawakenInterruptedTask(taskId);
    const row = findWorkspaceInConfig(config, taskId);
    expect(row?.taskStatus).toBe("running");
    expect(row?.taskAttemptId).not.toBe(previousAttemptId);
    expect(outcome).toMatchObject({ kind: "reawakened", statusChanged: true });
    expect(outcome.kind === "reawakened" ? outcome.attemptId : undefined).toBe(row?.taskAttemptId);
  });

  test("a child being removed refuses the send instead of reading as not applicable", async () => {
    const pendingRemoval = {
      removalId: "remove-child",
      instanceId: "test-instance",
      pid: process.pid,
      identity: {
        birth: null,
        bootId: null,
        pidNs: null,
        machineId: null,
        platform: process.platform,
        hostname: null,
      },
      at: new Date().toISOString(),
    };
    const { config, taskService } = await setupInterruptedChild({ pendingRemoval });
    expect(findWorkspaceInConfig(config, taskId)?.pendingRemoval).toBeDefined();

    expect(await taskService.reawakenInterruptedTask(taskId)).toEqual({
      kind: "refused",
      message: pendingRemovalAdmissionMessage(pendingRemoval),
    });
    expectRowUnchanged(config);
  });
});
