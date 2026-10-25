/**
 * T3 #5971 (route split): while a page chunk loads, the page column shows LazyFeature's "Opening
 * page..." fallback inside the page's one `main` (#6017). renderReviewPanel imports the page modules
 * up front (#6252), so no other tests/ui test sees that state (#6262).
 *
 * The page's import() cannot be held here: under babel-jest it is a synchronous require, and a
 * mocked export (a getter) cannot await. So the loader is held one level up: React.lazy's own
 * load. Only the load that resolves to ProjectPage waits for the test's release, so every other
 * lazy feature loads as usual. Its own file: React.lazy caches a resolved page for the rest of
 * the file, so this must be the file's first ProjectPage navigation.
 */

let mockReleaseProjectPage: () => void = () => undefined;
const mockProjectPageGate = new Promise<void>((resolve) => {
  mockReleaseProjectPage = resolve;
});

jest.mock("react", () => {
  const actual = jest.requireActual<typeof import("react")>("react");
  return {
    ...actual,
    lazy: (load: Parameters<typeof actual.lazy>[0]) =>
      actual.lazy(async () => {
        const loaded = await load();
        const { ProjectPage } = jest.requireActual<
          typeof import("@/browser/components/ProjectPage/ProjectPage")
        >("@/browser/components/ProjectPage/ProjectPage");
        if (loaded.default === ProjectPage) await mockProjectPageGate;
        return loaded;
      }),
  };
});

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

/** As in lazyPages.test.ts: React hides a replaced page with display:none, so count visible ones. */
function visibleMains(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll("main")].filter(
    (main) => !main.closest('[style*="display: none"]')
  );
}

describeIntegration("lazy page loading (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("while a page chunk loads, the page column shows the loading state in its one main, then the page", async () => {
    const cleanupDom = setupTestDom();
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

      const loading = await waitFor(
        () => {
          const mains = visibleMains(view.container);
          expect(mains).toHaveLength(1);
          expect(mains[0].textContent).toContain("Opening page...");
          return mains[0];
        },
        { timeout: 30_000 }
      );
      expect(loading.querySelector("textarea")).toBeNull();

      mockReleaseProjectPage();
      await waitFor(
        () => {
          const mains = visibleMains(view.container);
          expect(mains).toHaveLength(1);
          expect(mains[0].textContent).not.toContain("Opening page");
          expect(mains[0].querySelector("textarea")).not.toBeNull();
        },
        { timeout: 30_000 }
      );
    } finally {
      mockReleaseProjectPage();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);
});
