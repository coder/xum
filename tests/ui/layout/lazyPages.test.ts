/**
 * T3 #5971 (route split): the workspace, project and scratch pages are lazy chunks inside one
 * page-level LazyFeature. Each page renders through the real lazy import and keeps exactly one
 * `main` landmark (#5969, #6017), like the root route shell next to them.
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../../ipc/sendMessageTestHelpers";
import { cleanupTestEnvironment, createTestEnvironment } from "../../ipc/setup";
import { renderApp } from "../renderReviewPanel";
import { addProjectViaUI, cleanupView, openProjectCreationView, setupTestDom } from "../helpers";
import { createAppHarness } from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/**
 * The page's `main` landmarks. While a page chunk loads, React keeps the previous page in the DOM
 * with `display: none` (out of the accessibility tree) and shows the fallback, so count visible ones.
 */
function visibleMains(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll("main")].filter(
    (main) => !main.closest('[style*="display: none"]')
  );
}

describeIntegration("lazy pages (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("the first-run page (no project yet) renders inside the page boundary with one main", async () => {
    const env = await createTestEnvironment();
    const cleanupDom = setupTestDom();
    const view = renderApp({ apiClient: env.orpc });
    try {
      await view.waitForReady();
      await waitFor(
        () =>
          expect(view.container.textContent).toContain("Select or add a project to get started."),
        { timeout: 30_000 }
      );
      expect(visibleMains(view.container)).toHaveLength(1);
    } finally {
      await cleanupView(view, cleanupDom);
      await cleanupTestEnvironment(env);
    }
  }, 90_000);

  test("project and scratch pages each render after their chunk loads, with one main", async () => {
    const cleanupDom = setupTestDom();
    const view = renderApp({ apiClient: getSharedEnv().orpc });
    try {
      await view.waitForReady();
      const projectPath = await addProjectViaUI(view, getSharedRepoPath());
      await openProjectCreationView(view, projectPath);
      expect(visibleMains(view.container)).toHaveLength(1);

      fireEvent.click(
        await waitFor(() => {
          const button = view.container.querySelector<HTMLElement>(
            '[aria-label="New scratch chat"]'
          );
          if (!button) throw new Error("New scratch chat button not found");
          return button;
        })
      );
      // Every state on the way (the old page, "Opening page..." while the chunk loads, the scratch
      // page) has exactly one visible `main`.
      await waitFor(() => {
        const mains = visibleMains(view.container);
        expect(mains).toHaveLength(1);
        if (!mains[0].querySelector("textarea") || mains[0].textContent?.includes("Opening page")) {
          throw new Error("Scratch page not rendered yet");
        }
      });
      expect(visibleMains(view.container)).toHaveLength(1);
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  test("the workspace page renders after its chunk loads, with one main", async () => {
    const app = await createAppHarness({ branchPrefix: "lazy-page" });
    try {
      expect(app.view.container.querySelector('[data-testid="message-window"]')).not.toBeNull();
      expect(visibleMains(app.view.container)).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  }, 90_000);
});
