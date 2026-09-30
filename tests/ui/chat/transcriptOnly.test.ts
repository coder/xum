/**
 * UI integration test for transcript-only workspaces.
 * Verifies the transcript stays visible while the composer area becomes a single notice.
 */

import "../dom";
import { waitFor } from "@testing-library/react";

import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { createStaticChatHandler } from "@/browser/stories/mocks/chatHandlers";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";

const TRANSCRIPT_ONLY_NOTICE =
  "This workspace's worktree is no longer available. This is a read-only chat transcript kept for historical and usage-tracking reasons.";

describe("Transcript-only workspace UI", () => {
  test("shows one notice instead of chat controls and keeps transcript messages visible", async () => {
    const cleanupDom = installDom();
    const metadata = createWorkspace({
      id: "ws-transcript-only",
      name: "deleted-worktree",
      projectName: "my-app",
      transcriptOnly: true,
    });
    const messages = [
      createUserMessage("msg-user-1", "Past user question", { historySequence: 1 }),
      createAssistantMessage("msg-assistant-1", "Past assistant answer", { historySequence: 2 }),
    ];
    const staticChatHandler = createStaticChatHandler(messages);
    const client = createMockORPCClient({
      projects: groupWorkspacesByProject([metadata]),
      workspaces: [metadata],
      onChat: (workspaceId, emit) => {
        if (workspaceId !== metadata.id) {
          queueMicrotask(() =>
            emit({ type: "caught-up", historyReplayStatus: "complete", hasOlderHistory: false })
          );
          return undefined;
        }
        return staticChatHandler(emit);
      },
    });
    const view = renderApp({ apiClient: client, metadata });

    try {
      await setupWorkspaceView(view, metadata, metadata.id);

      await waitFor(
        () => {
          expect(view.getByText("Past user question")).toBeTruthy();
          expect(view.getByText("Past assistant answer")).toBeTruthy();
        },
        { timeout: 10_000 }
      );

      const notices = view.getAllByText(TRANSCRIPT_ONLY_NOTICE);
      expect(notices).toHaveLength(1);
      expect(notices[0].className).toContain("text-muted");
      expect(notices[0].getAttribute("role")).toBe("note");

      expect(view.container.querySelector('textarea[aria-label="Message Claude"]')).toBeNull();
      expect(view.container.querySelector('[data-component="ChatInputControls"]')).toBeNull();
      expect(view.container.querySelector('[data-component="ChatModeToggles"]')).toBeNull();
      expect(view.container.querySelector('[data-component="ModelSelectorGroup"]')).toBeNull();
      expect(view.queryByLabelText("Send message")).toBeNull();
      expect(view.queryByText(/focus chat/i)).toBeNull();
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});
