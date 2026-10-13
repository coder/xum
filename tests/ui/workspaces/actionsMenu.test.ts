/**
 * Integration tests for the Workspace actions menus (#6202).
 *
 * - The sidebar row's settings dialogs are React children of that row. A click on a dialog's
 *   backdrop must not reach the row's own click handler and select the workspace.
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import { generateBranchName } from "../../ipc/helpers";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";
import { detectDefaultTrunkBranch } from "@/node/git";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

function findButton(label: string, root: ParentNode = document): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function getRow(app: AppHarness, workspaceId: string): HTMLElement {
  const row = app.view.container.querySelector<HTMLElement>(
    `[data-workspace-id="${workspaceId}"][data-workspace-path]`
  );
  if (!row) throw new Error(`Row not rendered: ${workspaceId}`);
  return row;
}

async function createOtherWorkspace(app: AppHarness, prefix: string) {
  const result = await app.env.orpc.workspace.create({
    projectPath: app.repoPath,
    branchName: generateBranchName(prefix),
    trunkBranch: await detectDefaultTrunkBranch(app.repoPath),
  });
  if (!result.success) throw new Error(`Failed to create workspace: ${result.error}`);
  // An initializing row offers Cancel instead of its actions menu.
  await app.env.services.initStateManager.waitForInit(result.metadata.id);
  await waitFor(() => getRow(app, result.metadata.id), { timeout: 10_000 });
  return { id: result.metadata.id };
}

describeIntegration("Workspace actions menus (UI)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("a backdrop click on a row's settings dialog does not select that row", async () => {
    const app = await createAppHarness({ branchPrefix: "ui-actions-backdrop" });
    let otherId: string | null = null;
    try {
      const other = await createOtherWorkspace(app, "ui-actions-backdrop-other");
      otherId = other.id;

      for (const [item, dialogName] of [
        ["Configure MCP servers", "Workspace MCP Configuration"],
        ["Messages from other workspaces", "Messages from other workspaces"],
      ] as const) {
        const kebab = await waitFor(
          () => {
            const found = getRow(app, other.id).querySelector(
              'button[aria-label^="Workspace actions for"]'
            );
            if (!found) throw new Error("Row menu not ready");
            return found;
          },
          { timeout: 10_000 }
        );
        fireEvent.click(kebab);
        fireEvent.click(await waitFor(() => findButton(item)));
        // The dialog chunk loads on first open.
        const dialog = await waitFor(
          () => {
            const found = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) =>
              d.textContent?.includes(dialogName)
            );
            if (!found) throw new Error(`Dialog not open: ${dialogName}`);
            return found;
          },
          { timeout: 10_000 }
        );
        // Radix renders the overlay as the content's sibling, outside [role="dialog"].
        const overlay = dialog.previousElementSibling;
        expect(overlay).not.toBeNull();
        fireEvent.click(overlay!);

        expect(getRow(app, other.id).getAttribute("aria-current")).toBeNull();
        expect(getRow(app, app.workspaceId).getAttribute("aria-current")).toBe("true");
        fireEvent.keyDown(dialog, { key: "Escape" });
        await waitFor(() => expect(document.body.textContent).not.toContain(dialogName));
      }
    } finally {
      if (otherId) {
        await app.env.orpc.workspace.remove({ workspaceId: otherId, options: { force: true } });
      }
      await app.dispose();
    }
  }, 60_000);
});
