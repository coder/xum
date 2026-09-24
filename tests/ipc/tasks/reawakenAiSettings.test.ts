import { cleanupTestEnvironment, createTestEnvironment, type TestEnvironment } from "../setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  createWorkspace,
  generateBranchName,
  HAIKU_MODEL,
} from "../helpers";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err } from "@/common/types/result";

const DELEGATED_MODEL = KNOWN_MODELS.SONNET.id;

function findWorkspace(
  env: TestEnvironment,
  workspaceId: string
): WorkspaceConfigEntry | undefined {
  return Array.from(env.config.loadConfigOrDefault().projects.values())
    .flatMap((project) => project.workspaces)
    .find((workspace) => workspace.id === workspaceId);
}

// Real TaskService -> WorkspaceTurnManager -> WorkspaceService -> AgentSession admission with the
// mock AI player: an ancestor reawakening of a new-style child runs on the current Delegated
// default and commits it at acceptance; a refusal before acceptance commits nothing.
describe("Reawakened sub-agent AI settings", () => {
  let env: TestEnvironment | undefined;
  let repoPath: string | undefined;
  const workspaceIds: string[] = [];

  beforeEach(async () => {
    env = await createTestEnvironment();
    env.services.aiService.enableMockMode();
    repoPath = await createTempGitRepo();
  });

  afterEach(async () => {
    if (env) {
      for (const workspaceId of workspaceIds.splice(0).reverse()) {
        try {
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } catch {
          // Best-effort cleanup.
        }
      }
      await cleanupTestEnvironment(env);
      env = undefined;
    }
    if (repoPath) {
      await cleanupTempGitRepo(repoPath);
      repoPath = undefined;
    }
  });

  async function createReportedChild(testEnv: TestEnvironment, repo: string) {
    const parent = await createWorkspace(testEnv, repo, generateBranchName("reawaken-parent"));
    if (!parent.success) throw new Error(parent.error);
    const parentId = parent.metadata.id;
    workspaceIds.push(parentId);
    const child = await createWorkspace(testEnv, repo, generateBranchName("reawaken-child"));
    if (!child.success) throw new Error(child.error);
    const childId = child.metadata.id;
    workspaceIds.push(childId);
    await testEnv.config.addWorkspace(repo, {
      ...child.metadata,
      parentWorkspaceId: parentId,
      agentId: "exec",
      agentType: "exec",
      taskStatus: "reported",
      taskModelString: HAIKU_MODEL,
      title: "Reviewer",
    });
    await testEnv.config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const workspace = project.workspaces.find((entry) => entry.id === childId);
        if (workspace) {
          workspace.taskThinkingLevel = "high";
          workspace.aiSettings = { model: HAIKU_MODEL, thinkingLevel: "high" };
          workspace.taskAiPins = {};
        }
      }
      cfg.agentAiDefaults = {
        ...cfg.agentAiDefaults,
        exec: { ...cfg.agentAiDefaults?.exec, subagent: { modelString: DELEGATED_MODEL } },
      };
      return cfg;
    });
    return { parentId, childId };
  }

  test("an accepted reawakening runs on the current Delegated default", async () => {
    if (!env || !repoPath) throw new Error("Test environment not initialized");
    const { parentId, childId } = await createReportedChild(env, repoPath);
    const { taskService, workspaceTurnManager } = env.services;

    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentId,
      childId,
      "Take another pass.",
      "tool-end"
    );
    if (!reactivated.success || reactivated.data.executionTaskId == null) {
      throw new Error("Expected a reactivated execution");
    }
    await workspaceTurnManager.waitForWorkspaceTurn(reactivated.data.executionTaskId, {
      requestingWorkspaceId: parentId,
      backgroundOnMessageQueued: false,
      timeoutMs: 10_000,
    });

    expect(env.services.aiService.mockAiStreamPlayer?.debugGetLastModel(childId)).toBe(
      DELEGATED_MODEL
    );
    const committed = findWorkspace(env, childId);
    expect(committed?.taskModelString).toBe(DELEGATED_MODEL);
    expect(committed?.aiSettings?.model).toBe(DELEGATED_MODEL);
    expect(committed?.aiSettingsByAgent?.exec?.model).toBe(DELEGATED_MODEL);
  }, 25_000);

  test("a refusal before acceptance leaves the AI-settings snapshot unchanged", async () => {
    if (!env || !repoPath) throw new Error("Test environment not initialized");
    const { parentId, childId } = await createReportedChild(env, repoPath);
    const { taskService, workspaceService } = env.services;
    const session = workspaceService.getOrCreateSession(childId);
    const send = jest
      .spyOn(session, "sendMessage")
      .mockResolvedValueOnce(Err({ type: "unknown", raw: "session admission refused" }));
    try {
      expect(
        await taskService.sendMessageToDescendantAgentTask(
          parentId,
          childId,
          "Refused follow-up",
          "tool-end"
        )
      ).toMatchObject({ success: false, error: { code: "send_failed" } });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
    const child = findWorkspace(env, childId);
    expect(child?.taskModelString).toBe(HAIKU_MODEL);
    expect(child?.aiSettings?.model).toBe(HAIKU_MODEL);
    expect(child?.aiSettingsByAgent?.exec).toBeUndefined();
  }, 25_000);
});
