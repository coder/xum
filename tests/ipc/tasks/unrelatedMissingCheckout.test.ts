import * as fs from "fs/promises";

import { parseAgentMessageEnvelope } from "@/common/utils/agentMessageEnvelope";
import { HistoryService } from "@/node/services/historyService";

import { cleanupTestEnvironment, createTestEnvironment, type TestEnvironment } from "../setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  createWorkspaceWithInit,
  generateBranchName,
} from "../helpers";

// Real TaskService -> WorkspaceService -> AgentSession/HistoryService with the mock AI player
// (#4305): an unrelated recipient whose worktree checkout is gone (for example archived with
// checkout deletion, then unarchived) must refuse before anything is persisted, instead of
// accepting the message and failing later with runtime_not_ready.
describe("Unrelated messages and a recipient's missing checkout", () => {
  let env: TestEnvironment | undefined;
  let repoPath: string | undefined;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    env = await createTestEnvironment();
    env.services.aiService.enableMockMode();
    repoPath = await createTempGitRepo();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch {
        // Best-effort cleanup (a deleted checkout can make removal complain).
      }
    }
    if (env) {
      await cleanupTestEnvironment(env);
      env = undefined;
    }
    if (repoPath) {
      await cleanupTempGitRepo(repoPath);
      repoPath = undefined;
    }
  });

  async function createRoot(testEnv: TestEnvironment, repo: string, label: string) {
    const workspace = await createWorkspaceWithInit(
      testEnv,
      repo,
      generateBranchName(label),
      undefined,
      true
    );
    cleanups.push(workspace.cleanup);
    return workspace;
  }

  async function setConsent(testEnv: TestEnvironment, workspaceId: string, enabled: boolean) {
    const result = await testEnv.services.workspaceService.setUnrelatedWorkspaceConsent(
      workspaceId,
      enabled
    );
    if (!result.success) throw new Error(result.error);
  }

  async function historyRows(testEnv: TestEnvironment, workspaceId: string) {
    const result = await new HistoryService(testEnv.config).getHistoryFromLatestBoundary(
      workspaceId
    );
    if (!result.success) throw new Error(String(result.error));
    return result.data;
  }

  const MESSAGE = "hello from another tree";
  const hasEnvelope = (rows: Awaited<ReturnType<typeof historyRows>>) =>
    rows.some((row) =>
      row.parts.some(
        (part) => part.type === "text" && parseAgentMessageEnvelope(part.text)?.message === MESSAGE
      )
    );

  test("refuses before persisting any row, and discovery still lists it", async () => {
    if (!env || !repoPath) throw new Error("Test environment not initialized");
    const sender = await createRoot(env, repoPath, "peer-sender");
    const target = await createRoot(env, repoPath, "peer-missing");
    await setConsent(env, target.workspaceId, true);
    await fs.rm(target.workspacePath, { recursive: true, force: true });
    const rowsBefore = await historyRows(env, target.workspaceId);

    const result = await env.services.taskService.sendAgentTreeMessage(
      sender.workspaceId,
      target.workspaceId,
      MESSAGE
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("refused");
    const reason = result.error.code === "refused" ? result.error.reason : "";
    expect(reason).toContain("checkout is unavailable");
    // The untrusted sender learns nothing about the recipient's paths.
    expect(reason).not.toContain(target.workspacePath);
    expect(await historyRows(env, target.workspaceId)).toEqual(rowsBefore);
    // Discovery stays a snapshot without disk probes: the target is listed and refuses on send.
    const listed = env.services.taskService.listInstanceWorkspaces(sender.workspaceId, {});
    expect(listed.rows.map((row) => row.workspaceId)).toContain(target.workspaceId);
  }, 60_000);

  test("without consent a missing checkout still answers not_found", async () => {
    if (!env || !repoPath) throw new Error("Test environment not initialized");
    const sender = await createRoot(env, repoPath, "peer-sender");
    const target = await createRoot(env, repoPath, "peer-private");
    await setConsent(env, target.workspaceId, false);
    await fs.rm(target.workspacePath, { recursive: true, force: true });

    const result = await env.services.taskService.sendAgentTreeMessage(
      sender.workspaceId,
      target.workspaceId,
      MESSAGE
    );

    expect(result).toEqual({ success: false, error: { code: "not_found" } });
  }, 60_000);

  test("a recipient with a valid checkout accepts and persists the envelope and trigger", async () => {
    if (!env || !repoPath) throw new Error("Test environment not initialized");
    const sender = await createRoot(env, repoPath, "peer-sender");
    const target = await createRoot(env, repoPath, "peer-healthy");
    await setConsent(env, target.workspaceId, true);
    expect(hasEnvelope(await historyRows(env, target.workspaceId))).toBe(false);

    const result = await env.services.taskService.sendAgentTreeMessage(
      sender.workspaceId,
      target.workspaceId,
      MESSAGE
    );

    expect(result.success).toBe(true);
    await env.services.workspaceService.waitForIdle(target.workspaceId);
    const rows = await historyRows(env, target.workspaceId);
    expect(hasEnvelope(rows)).toBe(true);
    expect(rows.some((row) => row.role === "user")).toBe(true);
  }, 60_000);
});
