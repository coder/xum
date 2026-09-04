import { cleanupTestEnvironment, createTestEnvironment, type TestEnvironment } from "../setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  createWorkspace,
  generateBranchName,
  HAIKU_MODEL,
  sendMessageWithModel,
  waitFor,
} from "../helpers";

import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import type { MuxMessage } from "@/common/types/message";

function extractText(message: MuxMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<MuxMessage["parts"][number], { type: "text" }> => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

function findWorkspace(
  env: TestEnvironment,
  workspaceId: string
): WorkspaceConfigEntry | undefined {
  return Array.from(env.config.loadConfigOrDefault().projects.values())
    .flatMap((project) => project.workspaces)
    .find((workspace) => workspace.id === workspaceId);
}

describe("Persistent sub-agent compaction", () => {
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

  test("reawakens a compacted child in place and settles its continuation without a live LLM", async () => {
    if (!env || !repoPath) throw new Error("Test environment not initialized");

    const parentResult = await createWorkspace(
      env,
      repoPath,
      generateBranchName("persistent-compaction-parent")
    );
    if (!parentResult.success) throw new Error(parentResult.error);
    workspaceIds.push(parentResult.metadata.id);

    const childResult = await createWorkspace(
      env,
      repoPath,
      generateBranchName("persistent-compaction-child")
    );
    if (!childResult.success) throw new Error(childResult.error);
    workspaceIds.push(childResult.metadata.id);

    const parentWorkspaceId = parentResult.metadata.id;
    const childWorkspaceId = childResult.metadata.id;
    const historyService = new HistoryService(env.config);
    const seedText = "Original specialist context that should stay behind the boundary";

    const seedResult = await sendMessageWithModel(env, childWorkspaceId, seedText, HAIKU_MODEL, {
      agentId: "explore",
    });
    expect(seedResult.success).toBe(true);
    const seedCompleted = await waitFor(async () => {
      const history = await historyService.getLastMessages(childWorkspaceId, 20);
      return (
        history.success &&
        history.data.some(
          (message) => message.role === "assistant" && extractText(message).includes(seedText)
        )
      );
    }, 10_000);
    if (!seedCompleted) {
      const history = await historyService.getLastMessages(childWorkspaceId, 20);
      throw new Error(`Seed turn did not complete: ${JSON.stringify(history)}`);
    }

    const compactResult = await sendMessageWithModel(
      env,
      childWorkspaceId,
      "Summarize the conversation into a compact form.",
      HAIKU_MODEL,
      {
        agentId: "compact",
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact -t 500",
          parsed: { maxOutputTokens: 500 },
        },
      }
    );
    expect(compactResult.success).toBe(true);
    const compactionCompleted = await waitFor(async () => {
      const history = await historyService.getHistoryFromLatestBoundary(childWorkspaceId);
      return history.success && history.data[0]?.metadata?.compactionBoundary === true;
    }, 10_000);
    if (!compactionCompleted) {
      const history = await historyService.getLastMessages(childWorkspaceId, 20);
      throw new Error(`Compaction did not complete: ${JSON.stringify(history)}`);
    }

    const reportedAt = "2026-08-10T12:00:00.000Z";
    await env.config.addWorkspace(repoPath, {
      ...childResult.metadata,
      parentWorkspaceId,
      agentId: "explore",
      agentType: "explore",
      taskStatus: "reported",
      reportedAt,
      taskModelString: HAIKU_MODEL,
      title: "Compaction specialist",
    });

    const reactivated = await env.services.taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childWorkspaceId,
      "Inspect the regression using the compacted context.",
      "tool-end"
    );
    expect(reactivated.success).toBe(true);
    if (!reactivated.success || reactivated.data.delivery !== "reactivated") {
      throw new Error("Expected the persistent child to reactivate");
    }
    const executionTaskId = reactivated.data.executionTaskId;
    if (!executionTaskId) throw new Error("Expected a reactivated execution task ID");

    const continuation = await env.services.workspaceTurnManager.waitForWorkspaceTurn(
      executionTaskId,
      {
        requestingWorkspaceId: parentWorkspaceId,
        ownerWorkspaceId: parentWorkspaceId,
        backgroundOnMessageQueued: false,
        timeoutMs: 10_000,
      }
    );
    expect(continuation).toMatchObject({
      taskId: executionTaskId,
      workspaceId: childWorkspaceId,
      reportMarkdown: expect.stringContaining(
        "Inspect the regression using the compacted context."
      ),
    });

    const child = findWorkspace(env, childWorkspaceId);
    expect(child).toMatchObject({
      parentWorkspaceId,
      taskStatus: "reported",
      reportedAt,
      taskExecutionId: executionTaskId,
      taskExecutionStatus: "completed",
    });

    const activeHistory = await historyService.getHistoryFromLatestBoundary(childWorkspaceId);
    expect(activeHistory.success).toBe(true);
    if (!activeHistory.success) throw new Error(activeHistory.error);
    expect(activeHistory.data[0]?.metadata?.compactionBoundary).toBe(true);
    expect(activeHistory.data.some((message) => extractText(message).includes(seedText))).toBe(
      false
    );
    expect(
      activeHistory.data.some((message) =>
        extractText(message).includes("Inspect the regression using the compacted context.")
      )
    ).toBe(true);

    const fullHistory: MuxMessage[] = [];
    const fullHistoryResult = await historyService.iterateFullHistory(
      childWorkspaceId,
      "forward",
      (messages) => {
        fullHistory.push(...messages);
      }
    );
    expect(fullHistoryResult.success).toBe(true);
    expect(fullHistory.some((message) => extractText(message).includes(seedText))).toBe(true);

    const lastPrompt =
      env.services.aiService.mockAiStreamPlayer?.debugGetLastPrompt(childWorkspaceId);
    if (lastPrompt == null) throw new Error("Expected a captured mock prompt");
    expect(lastPrompt[0]?.metadata?.compactionBoundary).toBe(true);
    expect(lastPrompt.some((message) => extractText(message).includes(seedText))).toBe(false);
  }, 30_000);
});
