/**
 * UI integration test for a long transcript: more rows than the old 64-row display cap.
 * The chat pane bounds what it mounts with a tail-first window, so nothing is cut out of the
 * transcript: every turn shows, with no "hidden for performance" marker.
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

async function seedHistoryWithToolCalls(
  historyService: HistoryService,
  workspaceId: string,
  pairCount: number
): Promise<void> {
  for (let i = 0; i < pairCount; i++) {
    const userMessage = createMuxMessage(`user-${i}`, "user", `user-${i}`);
    const toolMessage = {
      id: `assistant-tool-${i}`,
      role: "assistant" as const,
      parts: [
        { type: "reasoning" as const, text: `thinking-${i}` },
        {
          type: "dynamic-tool" as const,
          toolCallId: `tool-${i}`,
          toolName: "bash",
          state: "output-available" as const,
          input: { script: "echo test" },
          output: { success: true },
        },
      ],
    };
    const assistantMessage = createMuxMessage(`assistant-${i}`, "assistant", `assistant-${i}`);

    const userResult = await historyService.appendToHistory(workspaceId, userMessage);
    if (!userResult.success) {
      throw new Error(`Failed to append user history: ${userResult.error}`);
    }

    const toolResult = await historyService.appendToHistory(workspaceId, toolMessage);
    if (!toolResult.success) {
      throw new Error(`Failed to append tool history: ${toolResult.error}`);
    }

    const assistantResult = await historyService.appendToHistory(workspaceId, assistantMessage);
    if (!assistantResult.success) {
      throw new Error(`Failed to append assistant history: ${assistantResult.error}`);
    }
  }
}

describe("Long transcript UI", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("shows every turn of a long transcript, with no hidden-messages marker", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    await trustProject(env, repoPath);
    const cleanupDom = installDom();
    let view: ReturnType<typeof renderApp> | undefined;
    let workspaceId: string | undefined;

    try {
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);
      const branchName = generateBranchName("ui-long-transcript");

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
      const pairCount = 33;
      await seedHistoryWithToolCalls(historyService, workspaceId, pairCount);

      view = renderApp({ apiClient: env.orpc, metadata: createResult.metadata });
      await setupWorkspaceView(view, createResult.metadata, workspaceId);
      await waitForWorkspaceChatToRender(view.container);

      // The oldest turn mounts with the rest: the mount window reveals it tail-first, and
      // nothing in a transcript this long is replaced by a marker.
      const oldestReply = await waitFor(() => view!.getByText("assistant-0"), {
        // Full integration runs can hydrate the seeded transcript slower than
        // Testing Library's default 1s wait, even though the chat window exists.
        timeout: 30_000,
      });
      const transcriptText = view.container.textContent ?? "";
      expect(transcriptText).not.toMatch(/hidden for performance/i);
      expect(view.queryByRole("button", { name: /load all/i })).toBeNull();
      for (let i = 0; i < pairCount; i++) {
        expect(view.getByText(`user-${i}`)).toBeTruthy();
        expect(view.getByText(`assistant-${i}`)).toBeTruthy();
      }

      // Every reply keeps its actions and time, the oldest included.
      const messageBlock = oldestReply.closest("[data-message-block]");
      expect(messageBlock).toBeTruthy();
      expect(messageBlock?.querySelector("[data-message-meta]")).not.toBeNull();
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
