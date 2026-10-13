/**
 * T3 #5971 (route split): a page chunk that fails to load (a tab opened before a server upgrade asks
 * for an old hashed chunk) shows LazyFeature's Reload state inside the page's one `main`, not a
 * blank page. A throwing export stands in for the rejected `import()`: App's lazy loader reads
 * `ProjectPage`, so its promise rejects. The throw is on the export, not the module factory,
 * because renderReviewPanel imports the page modules up front (#6252) and reads no export.
 */

jest.mock("@/browser/components/ProjectPage/ProjectPage", () => ({
  get ProjectPage(): never {
    throw new Error("Failed to fetch dynamically imported module");
  },
}));

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../../ipc/sendMessageTestHelpers";
import { renderApp } from "../renderReviewPanel";
import { addProjectViaUI, cleanupView, setupTestDom } from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("lazy page load failure (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("a page whose chunk fails to load offers a reload inside the page's one main", async () => {
    const cleanupDom = setupTestDom();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderApp({ apiClient: getSharedEnv().orpc });
    try {
      await view.waitForReady();
      const projectPath = await addProjectViaUI(view, getSharedRepoPath());
      const projectRow = await waitFor(() => {
        const row = view.container.querySelector<HTMLElement>(
          `[data-project-path="${projectPath}"][aria-controls]`
        );
        if (!row) throw new Error("Project not found in sidebar");
        return row;
      });
      fireEvent.click(projectRow);

      const alert = await waitFor(
        () => {
          const el = view.container.querySelector('[role="alert"]');
          if (!el?.textContent?.includes("Page failed to load."))
            throw new Error("No reload state");
          return el;
        },
        { timeout: 30_000 }
      );
      // React hides the previous page with display:none while the boundary shows its error.
      const mains = [...view.container.querySelectorAll("main")].filter(
        (main) => !main.closest('[style*="display: none"]')
      );
      expect(mains).toHaveLength(1);
      expect(mains[0].contains(alert)).toBe(true);
      expect(alert.querySelector("button")?.textContent).toBe("Reload");
      // The rest of the app stays usable: the project sidebar is still there.
      expect(view.container.querySelector(`[data-project-path="${projectPath}"]`)).not.toBeNull();

      // Another kind of page gets a fresh boundary: the scratch page renders, not the old failure.
      fireEvent.click(
        await waitFor(() => {
          const button = view.container.querySelector<HTMLElement>(
            '[aria-label="New scratch chat"]'
          );
          if (!button) throw new Error("New scratch chat button not found");
          return button;
        })
      );
      await waitFor(
        () => {
          if (view.container.querySelector('[role="alert"]')) throw new Error("Failure state kept");
          if (!view.container.querySelector("main textarea"))
            throw new Error("Scratch page not rendered yet");
        },
        { timeout: 30_000 }
      );
    } finally {
      errorSpy.mockRestore();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);
});
