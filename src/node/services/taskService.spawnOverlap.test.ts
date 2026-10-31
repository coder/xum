import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Ok, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { Config } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import type { TaskService } from "@/node/services/taskService";
import * as forkOrchestrator from "@/node/services/utils/forkOrchestrator";
import {
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  projectWorkspace,
  saveLocalParentWorkspace,
  saveTestConfig,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
  waitForWorkspaceTaskStatus,
} from "@/node/services/taskService.shared.testHarness";

const OVERLAP_WAIT_MS = 3_000;
const TEST_TIMEOUT_MS = 30_000;

async function within<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed out">((resolve) => {
    timer = setTimeout(() => resolve("timed out"), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function spawn(taskService: TaskService, parentWorkspaceId: string, prompt: string) {
  return taskService.create({
    parentWorkspaceId,
    kind: "agent",
    agentId: "explore",
    prompt,
    title: prompt,
  });
}

async function createdTaskIds(creates: ReadonlyArray<ReturnType<typeof spawn>>) {
  return (await Promise.all(creates)).map((created) => {
    if (!created.success) throw new Error(`create failed: ${created.error}`);
    return created.data.taskId;
  });
}

describe("concurrent sub-agent spawns", () => {
  let rootDir: string;
  let gates: Array<() => void>;
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    gates.push(open);
    return { opened, open };
  }

  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    gates = [];
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    for (const open of gates) open();
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  test(
    "have every first send in flight at once, and each create returns before its send",
    async () => {
      const config = await createTestConfig(rootDir);
      const { parentId } = await saveLocalParentWorkspace(config, rootDir);
      const spawns = config.loadConfigOrDefault().taskSettings?.maxParallelAgentTasks ?? 0;
      expect(spawns).toBeGreaterThan(1);

      const sends = gate();
      const allSending = gate();
      let sending = 0;
      const { workspaceService } = createWorkspaceServiceMocks({
        sendMessage: mock(async (): Promise<Result<void, SendMessageError>> => {
          sending++;
          if (sending === spawns) allSending.open();
          await sends.opened;
          return Ok(undefined);
        }),
      });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const creates = Array.from({ length: spawns }, (_, index) =>
        spawn(taskService, parentId, `part ${index}`)
      );
      expect(await within(Promise.all(creates), OVERLAP_WAIT_MS)).not.toBe("timed out");
      expect(await within(allSending.opened, OVERLAP_WAIT_MS)).not.toBe("timed out");
      expect(sending).toBe(spawns);

      sends.open();
      for (const taskId of await createdTaskIds(creates)) {
        await waitForWorkspaceTaskStatus(config, taskId, "running");
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "a create holds no TaskService lock while its fork runs",
    async () => {
      const config = await createTestConfig(rootDir);
      const [parentId] = await saveWorktreeParents(config, rootDir, ["alpha"]);
      const { taskService } = createTaskServiceHarness(config, {
        workspaceService: createWorkspaceServiceMocks().workspaceService,
      });
      const forks = gate();
      const forkEntered = gate();
      const realFork = forkOrchestrator.orchestrateFork;
      spyOn(forkOrchestrator, "orchestrateFork").mockImplementation(async (params) => {
        forkEntered.open();
        await forks.opened;
        return realFork(params);
      });

      const created = spawn(taskService, parentId, "fork slowly");
      await forkEntered.opened;
      const createdWhileForking = await within(created, OVERLAP_WAIT_MS);
      expect(createdWhileForking !== "timed out" && createdWhileForking.success).toBe(true);
      const lock = taskService.acquireTaskCreationLock();
      const lockWhileForking = await within(lock, OVERLAP_WAIT_MS);
      forks.open();
      await (await lock)[Symbol.asyncDispose]();
      expect(lockWhileForking).not.toBe("timed out");

      const [taskId] = await createdTaskIds([created]);
      await waitForWorkspaceTaskStatus(config, taskId, "running");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "fork children of different projects at the same time",
    async () => {
      const config = await createTestConfig(rootDir);
      const parents = await saveWorktreeParents(config, rootDir, ["alpha", "beta"]);
      const { taskService } = createTaskServiceHarness(config, {
        workspaceService: createWorkspaceServiceMocks().workspaceService,
      });
      const allForking = gate();
      let forking = 0;
      let maxForking = 0;
      const realFork = forkOrchestrator.orchestrateFork;
      spyOn(forkOrchestrator, "orchestrateFork").mockImplementation(async (params) => {
        forking++;
        maxForking = Math.max(maxForking, forking);
        if (forking === parents.length) allForking.open();
        try {
          await within(allForking.opened, OVERLAP_WAIT_MS);
          return await realFork(params);
        } finally {
          forking--;
        }
      });

      const creates = parents.map((parentId) => spawn(taskService, parentId, `fork ${parentId}`));
      for (const taskId of await createdTaskIds(creates)) {
        await waitForWorkspaceTaskStatus(config, taskId, "running");
      }
      expect(maxForking).toBe(parents.length);
    },
    TEST_TIMEOUT_MS
  );
});

async function saveWorktreeParents(config: Config, rootDir: string, names: readonly string[]) {
  const parents = await Promise.all(
    names.map(async (name, index) => ({
      projectPath: await createTestProject(rootDir, name),
      parentId: `wtparent${index}`,
    }))
  );
  await saveTestConfig(
    config,
    parents.map(({ projectPath, parentId }) => [
      projectPath,
      {
        trusted: true,
        workspaces: [
          {
            ...projectWorkspace(projectPath, "root", parentId, {
              runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            }),
            path: projectPath,
          },
        ],
      },
    ]),
    { taskSettings: testTaskSettings(4, 3) }
  );
  return parents.map(({ parentId }) => parentId);
}
