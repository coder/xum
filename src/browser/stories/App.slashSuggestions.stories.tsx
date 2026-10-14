/**
 * Typing "/" in the composer opens the slash command suggestions (#5991). The composer then loads
 * MCP prompts through `workspace.mcp.prompts.list`, so the stories mock must serve that endpoint;
 * without it the chat pane crashed into the workspace error boundary.
 */

import { expect, userEvent, waitFor, within } from "@storybook/test";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";

export default {
  ...appMeta,
  title: "App/SlashSuggestions",
};

/** Behavioral contract only, so Pixel snapshots are off. */
export const OpensWithoutCrashing: AppStory = {
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-slash-suggestions",
          workspaceName: "slash-suggestions",
          projectName: "xum",
          messages: [
            createUserMessage("msg-1", "Hello", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60_000,
            }),
            createAssistantMessage("msg-2", "Hi.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 50_000,
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);

    const composer = await canvas.findByRole("textbox", { name: "Message" }, { timeout: 15_000 });
    await userEvent.click(composer);
    await userEvent.keyboard("/");

    const list = await body.findByRole("listbox", { name: "Slash command suggestions" });
    await expect(within(list).getAllByRole("option").length).toBeGreaterThan(0);
    // The MCP prompt request settles after the list opens; the pane must survive it.
    await waitFor(async () => {
      await expect(body.queryByText(/Something went wrong/)).toBeNull();
      await expect(canvas.getByRole("textbox", { name: "Message" })).toBe(composer);
    });
    await expect(composer).toHaveValue("/");
  },
};
