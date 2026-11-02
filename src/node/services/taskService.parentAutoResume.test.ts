import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { Ok, Err, type Result } from "@/common/types/result";
import { log } from "@/node/services/log";
import type { TaskService } from "@/node/services/taskService";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  projectWorkspace,
  saveWorkspaces,
  streamEnd,
  testTaskSettings,
  workspaceTurnManagerFor,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

// Parent (root) stream-end paths of TaskService.handleStreamEnd that the auto-resume suite does
// not reach: blockers that finish between the parent's own checks, and a failed resume send.

const ROOT_ID = "root-111";
const BUSY_IDLE_ONLY = { type: "unknown", raw: "Workspace is busy; idle-only send was skipped." };

type SendMessageMock = ReturnType<
  typeof mock<
    (
      workspaceId: string,
      message: string,
      options: unknown,
      internal?: { requireIdle?: boolean }
    ) => Promise<Result<void, { type: string; raw: string }>>
  >
>;

function rootStreamEnd(taskService: TaskService, messageId: string): Promise<void> {
  return streamEnd(taskService, {
    type: "stream-end",
    workspaceId: ROOT_ID,
    messageId,
    metadata: { model: "openai:gpt-5.2" },
    parts: [],
  });
}

/**
 * Makes the root own one blocking workspace turn while `isActive()` holds. Workspace turns are the
 * only parent blocker the handler re-lists after its entry snapshot, so they let a test end the
 * background work between the handler's own checks.
 */
function seedBlockingWorkspaceTurn(taskService: TaskService, isActive: () => boolean): void {
  const turnManager = workspaceTurnManagerFor(taskService);
  spyOn(turnManager, "listActiveWorkspaceTurnTaskIdsForOwner").mockImplementation((ownerId) =>
    Promise.resolve(ownerId === ROOT_ID && isActive() ? ["wst_background"] : [])
  );
  spyOn(turnManager, "listBlockingWorkspaceTurnTaskIds").mockImplementation((_ownerId, ids) =>
    Promise.resolve([...ids])
  );
}

describe("TaskService parent stream-end auto-resume", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  async function createRootWithRunningChild(): Promise<
    Awaited<ReturnType<typeof createTestConfig>>
  > {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", ROOT_ID, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", "task-222", {
          name: "agent_explore_child",
          parentWorkspaceId: ROOT_ID,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
        }),
      ],
      testTaskSettings()
    );
    return config;
  }

  async function createRootOnly(): Promise<Awaited<ReturnType<typeof createTestConfig>>> {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", ROOT_ID, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
      ],
      testTaskSettings()
    );
    return config;
  }

  test("does not resume when the background turn ends while resume options resolve", async () => {
    const config = await createRootOnly();
    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    // The first listing (the descendant/workflow check) sees the turn; the recheck after the
    // auto-resume options resolve sees it finished.
    let listings = 0;
    seedBlockingWorkspaceTurn(taskService, () => {
      listings += 1;
      return listings <= 1;
    });

    await rootStreamEnd(taskService, "assistant-root");

    expect(listings).toBe(2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not resume when a follow-up turn appears during the final blocker recheck", async () => {
    const config = await createRootWithRunningChild();
    let queueChecks = 0;
    // Reads: the queue-cut attribution snapshot at entry, the pre-resume idle check, then the
    // final recheck after the auto-resume options resolve; only that third read sees a turn.
    const hasPendingQueuedOrPreparingTurn = mock(() => {
      queueChecks += 1;
      return queueChecks >= 3;
    });
    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      hasPendingQueuedOrPreparingTurn,
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await rootStreamEnd(taskService, "assistant-root");

    expect(queueChecks).toBe(3);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("does not queue the fallback prompt when the busy send outlives the blockers", async () => {
    const config = await createRootOnly();
    let turnActive = true;
    const sendMessage: SendMessageMock = mock(
      (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: { requireIdle?: boolean }
      ): Promise<Result<void, { type: string; raw: string }>> => {
        if (internal?.requireIdle === true) {
          // The workspace was still completing; the background turn ends meanwhile.
          turnActive = false;
          return Promise.resolve(Err(BUSY_IDLE_ONLY));
        }
        return Promise.resolve(Ok(undefined));
      }
    );
    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    seedBlockingWorkspaceTurn(taskService, () => turnActive);

    await rootStreamEnd(taskService, "assistant-root");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      ROOT_ID,
      expect.stringContaining("wst_background"),
      expect.anything(),
      expect.objectContaining({ requireIdle: true })
    );
  });

  test("a failed resume send logs and does not consume the auto-resume budget", async () => {
    const config = await createRootWithRunningChild();
    const sendError = { type: "unknown", raw: "send failed" };
    // Stream ends 1, 3, 4 and 5 fail; 2 succeeds. Each failure restores the counter it found
    // (none before the success, one after it), so every stream end still sends.
    const outcomes = [false, true, false, false, false];
    const sendMessage: SendMessageMock = mock(() => {
      const succeeded = outcomes.shift();
      return Promise.resolve(succeeded === true ? Ok(undefined) : Err(sendError));
    });
    const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    for (let i = 1; i <= 5; i += 1) {
      await rootStreamEnd(taskService, `assistant-root-${i}`);
    }

    expect(sendMessage).toHaveBeenCalledTimes(5);
    const failureLogs = errorSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === "object" &&
        call[1] !== null &&
        "workspaceId" in call[1] &&
        call[1].workspaceId === ROOT_ID &&
        "error" in call[1] &&
        call[1].error === sendError
    );
    expect(failureLogs).toHaveLength(4);
  });
});
