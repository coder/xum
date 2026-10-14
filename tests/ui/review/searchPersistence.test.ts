import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../../ipc/sendMessageTestHelpers";

import { installDom } from "../dom";
import { renderReviewPanel } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getReviewSearchStateKey } from "@/common/constants/storage";
import { STORAGE_KEYS } from "@/constants/workspaceDefaults";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("ReviewPanel search persistence (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("a search longer than its persisted budget still updates the box", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();
      // The default trunk-ref base does not exist in the test repo (diff error, no search box).
      updatePersistedState(STORAGE_KEYS.reviewDiffBase(workspaceId), "HEAD");
      const view = renderReviewPanel({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await view.selectTab("review");
        const input = await waitFor(
          () => {
            const element = view.container.querySelector<HTMLInputElement>(
              'input[placeholder^="Search..."]'
            );
            if (!element) throw new Error("Review search input not found");
            return element;
          },
          { timeout: 30_000 }
        );

        // A pasted regex longer than the reviewSearchState budget: the box must keep it (a
        // refused persisted write used to leave it empty), and the stored copy drops the input
        // instead of being refused or keeping a stale search.
        const longSearch = "a|".repeat(150);
        fireEvent.change(input, { target: { value: longSearch } });

        await waitFor(() => expect(input.value).toBe(longSearch));
        expect(
          readPersistedState(getReviewSearchStateKey(workspaceId), { input: "unset" }).input
        ).toBe("");
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 120_000);
});
