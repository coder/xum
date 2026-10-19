/**
 * The workspace menu bar in Xum Electron is the window's title bar: 36 px high
 * (DESKTOP_TITLEBAR_HEIGHT_PX, src/browser/hooks/useDesktopTitlebar.ts) and a drag region
 * (`titlebar-drag`) for moving the window. In a browser the bar is 32 px and does not drag.
 */
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { WORKSPACE_TITLE } from "../../bugbash/repros/helpers";

test(
  "the workspace menu bar is the desktop title bar",
  { tags: ["story"] },
  async ({ app, agent, screen }) => {
    await app.open();
    // In Electron the seeded project starts collapsed.
    const expand = screen.getByRole("button", "Expand project demo-app");
    await expect(expand).toBeVisible({ timeout: 30_000 });
    await expand.tap();
    await screen.getByText(WORKSPACE_TITLE).first().tap();
    const bar = screen.getByTestId("workspace-menu-bar");
    await expect(bar).toBeVisible({ timeout: 15_000 });
    expect((await bar.boundingBox())?.height).toBe(36);
    expect((await bar.getAttribute("class"))?.split(/\s+/)).toContain("titlebar-drag");
    await agent.assert(
      `the top bar of the '${WORKSPACE_TITLE}' workspace shows its title and its buttons in one row`
    );
  }
);
