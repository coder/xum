/**
 * Story: the right sidebar's open/collapsed state belongs to each workspace. The user opens the
 * sidebar in the playground, then creates a second workspace: it starts collapsed (the overview
 * card), not open on the New tab's "Open a tool" list, which an open sidebar shows for a workspace
 * with no tools yet. Back in the playground the sidebar is still open, and both states survive a
 * reload. Before this change the state was one global flag, so the new workspace opened with it.
 *
 * The exact checks read the shell's toggle button, whose label names the state of the shown
 * workspace's sidebar ("Expand right sidebar" while collapsed).
 */
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, WORKSPACE_TITLE } from "../bugbash/repros/helpers";

const SECOND = "second-chat";

test(
  "a new workspace starts with its right sidebar collapsed while another keeps it open",
  { tags: ["story"], timeout: 600_000 },
  async ({ app, agent, browser, screen }) => {
    const expandToggle = screen.getByRole("button", "Expand right sidebar");
    const collapseToggle = screen.getByRole("button", "Collapse right sidebar");
    const toolList = screen.getByText("Open a tool");

    await disableTutorials(app);
    await app.open();
    await agent.act(`open the '${WORKSPACE_TITLE}' workspace in the left sidebar`);
    await agent.act("open the right sidebar with the 'Expand right sidebar' button");
    await expect(collapseToggle).toBeVisible({ timeout: 15_000 });

    await agent.act(
      `create a new workspace in the demo-app project from the left sidebar: type the ` +
        `workspace name '${SECOND}', type the message 'hello', and send it`
    );
    // The new workspace opens; its menu bar shows the notifications button.
    await expect(screen.getByRole("button", "Notifications")).toBeVisible({ timeout: 30_000 });
    await expect(expandToggle).toBeVisible({ timeout: 15_000 });
    await expect(toolList).toBeHidden();
    await agent.assert(
      `the '${SECOND}' workspace is shown with its right sidebar collapsed: no 'Open a tool' ` +
        "list of tools is shown next to the chat"
    );

    await agent.act(`open the '${WORKSPACE_TITLE}' workspace in the left sidebar`);
    await expect(collapseToggle).toBeVisible({ timeout: 15_000 });

    // Both states are saved: after a reload the playground (still selected) stays open, and the
    // second workspace stays collapsed.
    await browser.reload();
    await expect(collapseToggle).toBeVisible({ timeout: 30_000 });
    await agent.act(`open the '${SECOND}' workspace in the left sidebar`);
    await expect(expandToggle).toBeVisible({ timeout: 15_000 });
    await expect(toolList).toBeHidden();
  }
);
