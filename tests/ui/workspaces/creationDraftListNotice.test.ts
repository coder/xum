/**
 * The sidebar tells the user when creation drafts are missing: a failed list load offers Retry
 * (which then shows the saved drafts), and a one-way import that kept older drafts says so.
 */

import "../dom";
import { fireEvent, waitFor, within } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../../ipc/sendMessageTestHelpers";

import { renderApp } from "../renderReviewPanel";
import { cleanupView, setupTestDom } from "../helpers";

import { getDraftScopeId, getInputKey } from "@/common/constants/storage";
import { creationDraftImportId } from "@/node/services/creationDraftService";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Creation draft list notice", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("a failed list offers Retry, which shows the saved draft; a kept older draft is reported", async () => {
    const env = getSharedEnv();
    const drafts = env.services.draftService.creation;
    // Registered (trusted) by createSharedRepo.
    const projectPath = getSharedRepoPath();
    const savedId = "saved-before-retry";
    await drafts.update({
      scope: { kind: "creation", draftId: savedId },
      projectPath,
      text: "saved before the retry",
      manualName: "saved-draft",
    });
    // An older browser draft whose imported record was edited since: the import keeps both.
    const newerId = creationDraftImportId(projectPath, "older");
    await drafts.update({
      scope: { kind: "creation", draftId: newerId },
      projectPath,
      text: "newer",
    });
    const legacyKey = getInputKey(getDraftScopeId(projectPath, "older"));

    const cleanupDom = setupTestDom();
    window.localStorage.setItem(legacyKey, JSON.stringify("older"));
    const listSpy = jest.spyOn(drafts, "list").mockRejectedValueOnce(new Error("backend busy"));
    const view = renderApp({ apiClient: env.orpc });
    try {
      await view.waitForReady();
      const sidebar = within(
        await waitFor(
          () => {
            const nav = view.container.querySelector<HTMLElement>('[aria-label="Projects"]');
            if (!nav) throw new Error("Projects sidebar not rendered");
            return nav;
          },
          { timeout: 10_000 }
        )
      );
      const retry = await sidebar.findByRole("button", { name: "Retry" }, { timeout: 10_000 });
      const projectRow = await waitFor(() => {
        const row = view.container.querySelector<HTMLElement>(
          `[data-project-path="${projectPath}"]`
        );
        if (!row) throw new Error("Project not in the sidebar");
        return row;
      });
      const expand = projectRow.querySelector<HTMLElement>('[aria-label*="Expand project"]');
      if (expand) fireEvent.click(expand);
      expect(sidebar.queryByText("saved-draft")).toBeNull();

      fireEvent.click(retry);

      await sidebar.findByText("saved-draft", {}, { timeout: 10_000 });
      expect(sidebar.queryByRole("button", { name: "Retry" })).toBeNull();
      // The kept older draft is reported, and both versions stay.
      expect(sidebar.getByRole("alert").textContent).not.toBe("");
      expect(window.localStorage.getItem(legacyKey)).not.toBeNull();
      expect((await drafts.get(newerId))?.text).toBe("newer");
    } finally {
      listSpy.mockRestore();
      await cleanupView(view, cleanupDom);
      await drafts.delete(savedId);
      await drafts.delete(newerId);
    }
  }, 60_000);
});
