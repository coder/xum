import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { Config } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import type { HistoryService } from "@/node/services/historyService";
import type { TaskService } from "@/node/services/taskService";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  saveLocalParentWorkspace,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  flushTerminalAttentionDrains,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const SEND_FAILURE = "provider unavailable";

async function failureMessages(historyService: HistoryService, parentId: string) {
  const history = await historyService.getHistoryFromLatestBoundary(parentId);
  assert(history.success, "the parent's history must be readable");
  return history.data
    .filter((message) => message.role === "user" && message.metadata?.synthetic === true)
    .map((message) =>
      message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    )
    .filter((text) => text.includes("<mux_subagent_failure>"));
}

describe("a sub-agent whose launch fails", () => {
  let rootDir: string;
  let config: Config;
  let parentId: string;
  let services: TaskService[];
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    ({ parentId } = await saveLocalParentWorkspace(config, rootDir));
    services = [];
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    for (const taskService of services) {
      await taskService.reservedLaunchesSettled();
      await flushTerminalAttentionDrains(taskService);
    }
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  function serviceFailingChildSends(beforeFailing: Promise<void> = Promise.resolve()) {
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage: mock(async (workspaceId: string): Promise<Result<void, SendMessageError>> => {
        if (workspaceId === parentId) return Ok(undefined);
        await beforeFailing;
        return Err({ type: "unknown", raw: SEND_FAILURE });
      }),
    });
    const harness = createTaskServiceHarness(config, { workspaceService });
    services.push(harness.taskService);
    return harness;
  }

  async function spawnInBackground(taskService: TaskService) {
    const created = await taskService.createMany([
      {
        parentWorkspaceId: parentId,
        kind: "agent",
        agentId: "explore",
        prompt: "Survey the repository",
        title: "Survey",
        attentionPolicy: "notify_on_terminal",
      },
    ]);
    assert(created.success, "the spawn must be reserved");
    const [result] = created.data;
    assert(result != null, "one spawn reserves one task");
    return result.taskId;
  }

  test("puts the failure in the parent's history and owes the parent a wake", async () => {
    const { taskService, historyService } = serviceFailingChildSends();
    const wakes = spyOn(taskService, "enqueueTerminalAttention");

    const taskId = await spawnInBackground(taskService);
    await taskService.reservedLaunchesSettled();

    expect(findWorkspaceInConfig(config, taskId)?.taskLaunchError).toBe(SEND_FAILURE);
    const failures = await failureMessages(historyService, parentId);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`<task_id>${taskId}</task_id>`);
    expect(failures[0]).toContain("<error_type>launch_failed</error_type>");
    expect(failures[0]).toContain(SEND_FAILURE);
    expect(wakes).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerWorkspaceId: parentId,
        sourceKind: "agent_task",
        terminalOutcome: "failed",
        sourceId: taskId,
      })
    );
  });

  test("leaves the parent's history alone when a waiter already holds the failure", async () => {
    let failSend!: () => void;
    const sendFails = new Promise<void>((resolve) => (failSend = resolve));
    const { taskService, historyService } = serviceFailingChildSends(sendFails);

    const taskId = await spawnInBackground(taskService);
    const waited = taskService.waitForAgentReport(taskId, { requestingWorkspaceId: parentId });
    failSend();

    await expect(waited).rejects.toThrow(SEND_FAILURE);
    await taskService.reservedLaunchesSettled();
    expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("interrupted");
    expect(await failureMessages(historyService, parentId)).toEqual([]);
  });
});
