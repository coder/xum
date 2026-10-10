import { expect, waitFor, within } from "@storybook/test";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar } from "./helpers/uiState";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createWorkspace } from "./mocks/workspaces";

export default { ...appMeta, title: "App/RightSidebarOverview" };

const WORKSPACE_ID = "ws-overview";

function sideChat(id: string, title: string, createdAt: string): FrontendWorkspaceMetadata {
  return {
    ...createWorkspace({ id, name: id, projectName: "my-app", title, createdAt }),
    sideChatParentWorkspaceId: WORKSPACE_ID,
  };
}

/**
 * The collapsed right sidebar (Codex desktop style): instead of a full-height rail it floats a
 * bounded overview card over the chat's top-right corner, and the chat keeps the full width.
 */
export const CollapsedOverview: AppStory = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } } },
  render: () => (
    <AppWithMocks
      setup={() => {
        // setupSimpleChatStory collapses the right sidebar, which is what this story shows.
        const client = setupSimpleChatStory({
          workspaceId: WORKSPACE_ID,
          workspaceName: "feature/settlement-reconciler",
          messages: [
            createUserMessage("msg-1", "Why did the reconciler withdraw the hedge?", {
              historySequence: 1,
            }),
            createAssistantMessage(
              "msg-2",
              "The order filled for about 49 seconds, then the reconciler reduced it from 25 to " +
                "12 contracts and withdrew the rest. That was a per-order action, not a " +
                "portfolio-wide revision cancellation.",
              { historySequence: 2 }
            ),
          ],
          gitStatus: { ahead: 3, dirty: 2, outgoingAdditions: 29692, outgoingDeletions: 6248 },
          additionalWorkspaces: [
            sideChat("side-bq", "Give me the BQ migration", "2026-01-01T10:00:00.000Z"),
            sideChat("side-hedger", "How real-time is the hedger?", "2026-01-01T11:00:00.000Z"),
          ],
        });
        collapseLeftSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByRole(
      "complementary",
      { name: "Workspace insights" },
      { timeout: 15_000 }
    );
    const sideChats = await within(card).findByRole("region", { name: "Side chats" });
    await within(sideChats).findByText("How real-time is the hedger?");
    await waitFor(() =>
      expect(within(card).getByRole("button", { name: /Changes/ })).toHaveTextContent("+29,692")
    );

    // Bounded: the card is a fraction of the workspace's height, and the chat is not narrowed
    // by a collapsed rail: it reaches the workspace's right edge.
    const shell = canvasElement.querySelector<HTMLElement>("[data-workspace-shell]");
    await expect(shell).not.toBeNull();
    await waitFor(async () => {
      const shellRect = shell!.getBoundingClientRect();
      await expect(card.getBoundingClientRect().height).toBeLessThan(shellRect.height / 2);
      await expect(canvas.getByRole("main").getBoundingClientRect().right).toBe(shellRect.right);
    });
  },
};
