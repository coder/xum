import "../dom";
import { fireEvent, waitFor, within } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import { STORAGE_KEYS } from "@/constants/workspaceDefaults";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  cleanupSharedRepo,
  configureTestRetries,
  createSharedRepo,
  withSharedWorkspaceNoProvider,
} from "../../ipc/sendMessageTestHelpers";

import { installDom } from "../dom";
import { renderReviewPanel } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";

configureTestRetries(2);

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("ReviewPanel FileTree view mode (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("Flat mode shows file names with a truncated parent path (no directories)", async () => {
    await withSharedWorkspaceNoProvider(async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      // Force HEAD so the diff reflects the working tree.
      updatePersistedState(STORAGE_KEYS.reviewDiffBase(workspaceId), "HEAD");
      await env.orpc.config.updateUserPreferences({
        patches: [{ review: { fileTreeViewMode: "structured" } }],
      });

      const bashRes = await env.orpc.workspace.executeBash({
        workspaceId,
        script: "mkdir -p a/b && echo 'x' > a/b/c.ts && git add a/b/c.ts",
      });
      expect(bashRes.success).toBe(true);
      if (!bashRes.success) return;
      expect(bashRes.data.success).toBe(true);

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await view.selectTab("review");

        const fileTree = await view.findByTestId("review-file-tree", {}, { timeout: 60_000 });

        // Structured mode shows directories.
        await within(fileTree).findByText("a", {}, { timeout: 60_000 });
        await within(fileTree).findByText("c.ts", {}, { timeout: 60_000 });
        expect(fileTree.querySelector("[data-toggle]")).not.toBeNull();

        const viewModeToggle = view.getByTestId("review-file-tree-view-mode");
        fireEvent.click(within(viewModeToggle).getByRole("button", { name: "Flat" }));

        // Flat mode shows file names + parent paths and hides directory-only rows.
        await within(fileTree).findByText("a/b", {}, { timeout: 10_000 });
        await waitFor(
          () => {
            expect(fileTree.querySelector("[data-toggle]")).toBeNull();
          },
          { timeout: 5_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 120_000);
});
