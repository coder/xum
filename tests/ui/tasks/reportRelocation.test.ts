/**
 * UI integration test for retroactive task report placement.
 *
 * When a background `task` later completes (via `task_await`), we should render the final
 * report under the original `task` tool call card and avoid duplicating it under `task_await`.
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
  const taskId = "task-1";

  const userMessage = createMuxMessage("user-1", "user", "Spawn a background task");

  const taskToolMessage = createMuxMessage("assistant-task", "assistant", "", undefined, [
    {
      type: "dynamic-tool" as const,
      toolCallId: "tool-task-1",
      toolName: "task" as const,
      state: "output-available" as const,
      input: {
        subagent_type: "explore" as const,
        prompt: "Do some analysis",
        title: "Background analysis",
        run_in_background: true,
      },
      output: {
        status: "running" as const,
        taskId,
      },
    },
  ]);

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
        state: "output-available" as const,
        input: {
          task_ids: [taskId],
          timeout_secs: 0,
        },
        output: {
          results: [
            {
              status: "completed" as const,
              taskId,
              reportMarkdown: "Hello from **report**\n\n- item 1\n- item 2",
            },
          ],
        },
      },
    ]
  );

  for (const msg of [userMessage, taskToolMessage, taskAwaitToolMessage]) {
    const result = await historyService.appendToHistory(workspaceId, msg);
    if (!result.success) {
      throw new Error(`Failed to append history: ${result.error}`);
    }
  }
}

describe("Task report relocation UI", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("renders completed task report under original task tool call", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    await trustProject(env, repoPath);
    const cleanupDom = installDom();
    let view: ReturnType<typeof renderApp> | undefined;
    let workspaceId: string | undefined;

    try {
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);
      const branchName = generateBranchName("ui-task-report-relocation");

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

      await waitFor(() => {
        expect(view?.queryAllByText(/^task$/)).toHaveLength(1);
      });

      const taskToolName = view.getByText(/^task$/);
      const taskMessageBlock = taskToolName.closest('[data-testid="chat-message"]');
      expect(taskMessageBlock).toBeTruthy();

      // Task tool cards should start collapsed by default.
      expect(taskMessageBlock?.textContent).not.toContain("Hello from report");

      taskToolName.click();

      await waitFor(() => {
        expect(view?.queryAllByText("item 1")).toHaveLength(1);
      });

      expect(taskMessageBlock?.textContent).toContain("Hello from report");
      // Ensure markdown is actually rendered (not shown as raw "**bold**" syntax).
      expect(taskMessageBlock?.textContent).not.toContain("**report**");

      const strong = taskMessageBlock?.querySelector('[data-streamdown="strong"]');
      expect(strong).toBeTruthy();
      expect(strong?.textContent).toBe("report");

      const listItems = taskMessageBlock?.querySelectorAll("li");
      expect(listItems?.length).toBe(2);
      expect(taskMessageBlock?.textContent).toContain("item 1");
      expect(taskMessageBlock?.textContent).toContain("item 2");

      const awaitSummary = view.getByLabelText("1 task completed. Show task wait details");
      const awaitMessageBlock = awaitSummary.closest('[data-testid="chat-message"]');
      expect(awaitMessageBlock).toBeTruthy();

      awaitSummary.click();

      await waitFor(() => {
        expect(awaitMessageBlock?.textContent).toContain("task-1");
      });

      expect(awaitMessageBlock?.textContent).toContain("completed");
      expect(awaitMessageBlock?.textContent).toContain("Background analysis");
      expect(awaitMessageBlock?.textContent).not.toContain("Hello from report");
      expect(awaitMessageBlock?.textContent).not.toContain("item 1");
      expect(awaitMessageBlock?.textContent).not.toContain("item 2");
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
