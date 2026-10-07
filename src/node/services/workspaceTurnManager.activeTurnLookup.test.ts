import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import {
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import {
  createWorkspaceTurnManagerHarness,
  finalizeWorkspaceTurnStreamEndForTest,
  startWorkspaceTurnForTest,
} from "@/node/services/workspaceTurnManager.testHarness";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { Ok, type Result } from "@/common/types/result";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
  workspaceTurnRecord,
  workspaceTurnStreamEndEvent,
} from "@/node/services/taskService.testHarness";

/**
 * #5569: `getActiveWorkspaceTurnMuxMetadataForWorkspace` must find a target's active turn even
 * when this backend never registered it: another backend created, settled or revived it, or this
 * process restarted. Settle wakes and report rows correlate through this lookup, so a miss runs
 * them uncorrelated. Each backend is a real WorkspaceTurnManager on its own Config instance for
 * the same root.
 */
describe("active workspace-turn lookup without a live registration (#5569)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-turn-lookup-"));
  });
  afterEach(async () => {
    mock.restore();
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  const lookup = (manager: WorkspaceTurnManager, workspaceId: string) =>
    manager.getActiveWorkspaceTurnMuxMetadataForWorkspace(workspaceId);

  const freshBackend = async () =>
    createWorkspaceTurnManagerHarness(await createTestConfig(rootDir)).taskService;

  const reviveOf = (manager: WorkspaceTurnManager) =>
    (
      manager as unknown as {
        reviveRetryingWorkspaceTurn: (
          record: WorkspaceTurnTaskHandleRecord
        ) => Promise<WorkspaceTurnTaskHandleRecord | null>;
      }
    ).reviveRetryingWorkspaceTurn.bind(manager);

  /** Writes config rows and handle records directly, as another backend left them on disk. */
  async function seedOnDisk(
    rows: (projectPath: string) => WorkspaceConfigEntry[],
    records: WorkspaceTurnTaskHandleRecord[]
  ): Promise<Config> {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(config, projectPath, rows(projectPath), testTaskSettings());
    const store = new TaskHandleStore(config);
    for (const record of records) await store.upsertWorkspaceTurn(record);
    return config;
  }

  test("T1: finds a delegated root's turn that another backend created after a lookup here", async () => {
    const backendA = await freshBackend();
    expect(await lookup(backendA, "childworkspace")).toBeUndefined();

    // Backend B creates the delegated root through its real createWorkspaceTurn.
    const { parentId } = await startWorkspaceTurnForTest(rootDir);

    expect(await lookup(backendA, "childworkspace")).toMatchObject({
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
    });
  });

  test("T2: finds the follow-up turn of a root without a creator tag or mark", async () => {
    const backendA = createWorkspaceTurnManagerHarness(
      await seedOnDisk(
        (projectPath) => [
          projectWorkspace(projectPath, "owner", "owner"),
          projectWorkspace(projectPath, "untagged", "untagged"),
        ],
        [
          workspaceTurnRecord("owner", "untagged", "wst_create", "completed", {
            createdWorkspace: true,
          }),
          workspaceTurnRecord("owner", "untagged", "wst_follow", "running", {
            createdAt: "2026-06-19T00:00:05.000Z",
          }),
        ]
      )
    ).taskService;

    expect(await lookup(backendA, "untagged")).toMatchObject({
      taskHandleId: "wst_follow",
      ownerWorkspaceId: "owner",
    });
  });

  test("T3: finds a nested agent task's turn owned by its grandparent", async () => {
    const backendA = createWorkspaceTurnManagerHarness(
      await seedOnDisk(
        (projectPath) => [
          projectWorkspace(projectPath, "root", "root"),
          projectWorkspace(projectPath, "mid", "mid", { parentWorkspaceId: "root" }),
          projectWorkspace(projectPath, "leaf", "leaf", { parentWorkspaceId: "mid" }),
        ],
        [workspaceTurnRecord("root", "leaf", "wst_grand", "running")]
      )
    ).taskService;

    expect(await lookup(backendA, "leaf")).toMatchObject({
      taskHandleId: "wst_grand",
      ownerWorkspaceId: "root",
    });
  });

  test("T4: follows another backend's settle, revive and follow-up of a root's turn", async () => {
    const backendA = await freshBackend();
    const {
      config,
      parentId,
      taskService: backendB,
    } = await startWorkspaceTurnForTest(rootDir, {
      stableIds: ["handle", "turn", "secondhandle", "secondturn"],
    });
    const settleOnB = (messageId: string) =>
      finalizeWorkspaceTurnStreamEndForTest(
        backendB,
        workspaceTurnStreamEndEvent(parentId, messageId, "done")
      );
    const handle = { taskHandleId: "wst_handle", ownerWorkspaceId: parentId };

    expect(await lookup(backendA, "childworkspace")).toMatchObject(handle);

    await settleOnB("msg_first");
    expect(await lookup(backendA, "childworkspace")).toBeUndefined();

    const settled = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    expect(await reviveOf(backendB)(settled!)).toMatchObject({ status: "running" });
    expect(await lookup(backendA, "childworkspace")).toMatchObject(handle);

    // A new turn on the same target must replace the earlier answer, not repeat it.
    await settleOnB("msg_second");
    expect(await lookup(backendA, "childworkspace")).toBeUndefined();
    const followUp = await backendB.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
    expect(await lookup(backendA, "childworkspace")).toMatchObject({
      taskHandleId: "wst_secondhandle",
      ownerWorkspaceId: parentId,
    });
  });

  test("T5: picks the newest running record across an agent task's ancestors", async () => {
    const backendA = createWorkspaceTurnManagerHarness(
      await seedOnDisk(
        (projectPath) => [
          projectWorkspace(projectPath, "root", "root"),
          projectWorkspace(projectPath, "mid", "mid", { parentWorkspaceId: "root" }),
          projectWorkspace(projectPath, "leaf", "leaf", { parentWorkspaceId: "mid" }),
        ],
        [
          workspaceTurnRecord("mid", "leaf", "wst_newer", "running", {
            createdAt: "2026-06-19T00:00:09.000Z",
          }),
          workspaceTurnRecord("root", "leaf", "wst_older", "running", {
            createdAt: "2026-06-19T00:00:01.000Z",
          }),
        ]
      )
    ).taskService;

    expect(await lookup(backendA, "leaf")).toMatchObject({
      taskHandleId: "wst_newer",
      ownerWorkspaceId: "mid",
    });
  });

  test("T6: a restarted backend finds surviving turns of a root and of an agent task", async () => {
    const { config, parentId, projectPath } = await startWorkspaceTurnForTest(rootDir);
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push(
        projectWorkspace(projectPath, "agent-child", "agentchild", {
          parentWorkspaceId: parentId,
        })
      );
      return cfg;
    });
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "agentchild", "wst_agent", "running")
    );

    const restarted = await freshBackend();

    expect(await lookup(restarted, "childworkspace")).toMatchObject({
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
    });
    expect(await lookup(restarted, "agentchild")).toMatchObject({
      taskHandleId: "wst_agent",
      ownerWorkspaceId: parentId,
    });
  });

  // T7 pins the owner rule the narrowed lookup relies on (#5569 plan §4, §7.2). Case (a), a
  // root follow-up by an owner without the root's creating record, is pinned by
  // workspaceTurnManager.createWorkspaceTurn.test.ts ("other-parent" and "independently created
  // root" cases).
  test("T7b: the reawaken path refuses an agent task for an owner that is not its ancestor", async () => {
    const config = await seedOnDisk(
      (projectPath) => [
        projectWorkspace(projectPath, "parent", "parent"),
        projectWorkspace(projectPath, "stranger", "stranger"),
        projectWorkspace(projectPath, "child", "child", {
          parentWorkspaceId: "parent",
          agentType: "explore",
          taskStatus: "reported",
          runtimeConfig: { type: "local" },
        }),
      ],
      []
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, { workspaceService });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: "stranger",
      prompt: "Continue",
      title: "Reawaken",
      allowAgentWorkspace: true,
      workspace: { mode: "existing", workspaceId: "child" },
    });

    expect(result.success ? "admitted" : result.error).toContain("invalid_scope");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
