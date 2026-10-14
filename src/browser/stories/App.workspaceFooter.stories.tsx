/**
 * Workspace footer interactions at desktop width, where the footer carries the PR links.
 */
import { expect, userEvent, waitFor, within } from "@storybook/test";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";
import { setupSimpleChatStory } from "./helpers/chatSetup";

const meta = { ...appMeta, title: "App/WorkspaceFooter" };
export default meta;

const STACK_VIEW_JSON = JSON.stringify({
  trunk: "main",
  branches: [
    {
      name: "mike/stack-base",
      isCurrent: false,
      isMerged: true,
      isQueued: false,
      needsRebase: false,
      pr: { number: 30019, state: "MERGED", url: "https://github.com/coder/xum/pull/30019" },
    },
    {
      name: "mike/stack-menu",
      isCurrent: true,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
      pr: { number: 30021, state: "OPEN", url: "https://github.com/coder/xum/pull/30021" },
    },
    {
      name: "mike/stack-top",
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
    },
  ],
});

export const StackMenu: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-footer-stack",
          workspaceName: "stack-menu",
          projectName: "xum",
          executeBash: (_workspaceId, script) =>
            Promise.resolve({
              success: true as const,
              output: script.includes("gh stack view") ? STACK_VIEW_JSON : "",
              exitCode: 0,
              wall_duration_ms: 5,
            }),
          messages: [
            createUserMessage("msg-1", "Show me the stack", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "It has three layers.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 50000,
            }),
          ],
        })
      }
    />
  ),
  // Play-only: the snapshot budget (scripts/check-storybook-snapshot-budget.mjs) is full, and
  // PRStackBadge stories already capture the open menu.
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const footer = await waitFor(
      () => {
        const element = canvasElement.querySelector<HTMLElement>(
          '[data-testid="workspace-footer-bar"]'
        );
        if (!element) throw new Error("Footer not rendered");
        return element;
      },
      { timeout: 10_000 }
    );
    const trigger = await within(footer).findByRole(
      "button",
      { name: "View stack with 3 branches" },
      { timeout: 10_000 }
    );
    await userEvent.click(trigger);

    const menu = await within(document.body).findByRole("menu", { name: "Pull request stack" });
    // The footer row's edge fade is a mask that hides, and blocks clicks on, anything the row
    // paints outside its box, so each row must be hit where it is drawn, not just be in the DOM.
    for (const row of within(menu).getAllByRole("menuitem")) {
      const rect = row.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      await expect(row.contains(hit)).toBe(true);
    }
  },
};
