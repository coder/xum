/**
 * New opens a creation draft without a sidebar row: the row appears once the user writes
 * something (#3089). The composer's own setup (agent defaults, branch list) adds no row.
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
import { renderApp } from "../renderReviewPanel";
import {
  addProjectViaUI,
  cleanupView,
  openProjectCreationView,
  setupTestDom,
  waitForOpenDraftId,
} from "../helpers";
import { ChatHarness } from "../harness";
import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";
import { getDraftScopeId } from "@/common/constants/storage";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("creation draft sidebar row", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("New adds no draft row until the user types", async () => {
    const cleanupDom = setupTestDom();
    const view = renderApp({ apiClient: getSharedEnv().orpc });
    try {
      const projectPath = await addProjectViaUI(view, getSharedRepoPath());
      // The project row is New: a fresh draft, opened in the creation composer.
      await openProjectCreationView(view, projectPath);
      const draftId = await waitForOpenDraftId();
      const store = getCreationDraftStore();
      const row = () => view.container.querySelector(`[data-draft-id="${draftId}"]`);
      // Draft rows render inside the expanded project.
      const expand = view.container.querySelector<HTMLElement>(
        `button[data-project-path="${projectPath}"][aria-label^="Expand project"]`
      );
      if (expand) fireEvent.click(expand);
      await waitFor(() =>
        expect(
          view.container
            .querySelector(`button[data-project-path="${projectPath}"]`)
            ?.getAttribute("aria-label")
        ).toMatch(/^Collapse project/)
      );

      // Whatever the composer set up on mount has had its save.
      await store.flush(draftId);
      expect(store.getDraftsByProject()[projectPath]?.map((d) => d.draftId) ?? []).not.toContain(
        draftId
      );
      expect(row()).toBeNull();

      const chat = new ChatHarness(view.container, getDraftScopeId(projectPath, draftId), {
        kind: "creation",
        draftId,
      });
      await chat.typeWithoutSending("fix the flaky test");
      await waitFor(() => expect(row()).not.toBeNull(), { timeout: 10_000 });
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 120_000);
});
