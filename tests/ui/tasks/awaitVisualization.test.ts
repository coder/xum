/**
 * UI integration test for task_await execution visualization.
 *
 * When a task_await tool call is in-progress (state: input-available), we should render
 * the awaited task IDs (best-effort) instead of only a generic "Waiting..." message.
 */

import "../dom";

import { waitFor } from "@testing-library/react";

import { createTestEnvironment, cleanupTestEnvironment, preloadTestModules } from "../../ipc/setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  generateBranchName,
  trustProject,
} from "../../ipc/helpers";
import { detectDefaultTrunkBranch } from "@/node/git";
import { HistoryService } from "@/node/services/historyService";
import { createMuxMessage } from "@/common/types/message";

import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";

async function waitForWorkspaceChatToRender(container: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const messageWindow = container.querySelector('[data-testid="message-window"]');
      if (!messageWindow) {
        throw new Error("Workspace chat view not rendered yet");
      }
    },
    { timeout: 30_000 }
  );
}

async function seedHistory(historyService: HistoryService, workspaceId: string): Promise<void> {
  const awaitedTaskIds = ["task-a", "task-b"];

  const userMessage = createMuxMessage("user-1", "user", "Wait for tasks");

  const taskAwaitToolMessage = createMuxMessage(
    "assistant-task-await",
    "assistant",
    "",
    undefined,
    [
      {
        type: "dynamic-tool" as const,
        toolCallId: "tool-task-await-1",
        toolName: "task_await" as const,
        state: "input-available" as const,
        input: {
          task_ids: awaitedTaskIds,
          timeout_secs: 30,
        },
      },
    ]
  );

  for (const msg of [userMessage, taskAwaitToolMessage]) {
    const result = await historyService.appendToHistory(workspaceId, msg);
    if (!result.success) {
      throw new Error(`Failed to append history: ${result.error}`);
    }
  }
}

describe("task_await executing visualization", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("renders awaited task IDs while executing", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    await trustProject(env, repoPath);
    const cleanupDom = installDom();
    let view: ReturnType<typeof renderApp> | undefined;
    let workspaceId: string | undefined;

    try {
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);
      const branchName = generateBranchName("ui-task-await-visualization");

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      if (!createResult.success) {
        throw new Error(`Failed to create workspace: ${createResult.error}`);
      }

      workspaceId = createResult.metadata.id;

      const historyService = new HistoryService(env.config);
      await seedHistory(historyService, workspaceId);

      view = renderApp({ apiClient: env.orpc, metadata: createResult.metadata });
      await setupWorkspaceView(view, createResult.metadata, workspaceId);
      await waitForWorkspaceChatToRender(view.container);

      const taskAwaitSummary = await waitFor(
        () => {
          const node = view?.queryByLabelText("Waiting for 2 tasks. Show task wait details");
          if (!node) {
            throw new Error("task_await summary has not hydrated yet");
          }
          return node;
        },
        { timeout: 30_000 }
      );
      taskAwaitSummary.click();

      await waitFor(() => {
        expect(view?.queryAllByText("task-a")).toHaveLength(1);
        expect(view?.queryAllByText("task-b")).toHaveLength(1);
      });
    } finally {
      if (view) {
        await cleanupView(view, cleanupDom);
      } else {
        cleanupDom();
      }

      if (workspaceId) {
        try {
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } catch {
          // Best effort cleanup.
        }
      }

      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 60_000);
});
