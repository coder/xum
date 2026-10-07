import "../dom";
import { fireEvent, waitFor, within } from "@testing-library/react";

import { REVIEW_SORT_ORDER_KEY } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { STORAGE_KEYS } from "@/constants/workspaceDefaults";
import type { APIClient } from "@/browser/contexts/API";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../../ipc/sendMessageTestHelpers";
import { renderReviewPanel, type RenderedApp } from "../renderReviewPanel";
import { cleanupView, setupTestDom, setupWorkspaceView } from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

async function renderReviewPanelForUndoTests(params: {
  apiClient: APIClient;
  metadata: FrontendWorkspaceMetadata;
  workspaceId: string;
}): Promise<RenderedApp> {
  updatePersistedState(STORAGE_KEYS.reviewDiffBase(params.workspaceId), "HEAD");
  await params.apiClient.config.updateUserPreferences({
    patches: [{ review: { includeUncommitted: true } }],
  });
  updatePersistedState("review-show-read", false);
  updatePersistedState(REVIEW_SORT_ORDER_KEY, "file-order");

  return renderReviewPanel({
    apiClient: params.apiClient,
    metadata: params.metadata,
  });
}

async function seedTwoHunkReviewDiff(apiClient: APIClient, workspaceId: string): Promise<void> {
  const result = await apiClient.workspace.executeBash({
    workspaceId,
    script: String.raw`
cat > review-undo-fixture.txt <<'EOF'
line 01
line 02
line 03
line 04
line 05
line 06
line 07
line 08
line 09
line 10
line 11
line 12
EOF

git add review-undo-fixture.txt
git commit -q -m "Seed immersive undo review fixture"

awk 'NR==1{$0="line 01 updated"} NR==12{$0="line 12 updated"} {print}' review-undo-fixture.txt > review-undo-fixture.txt.tmp
mv review-undo-fixture.txt.tmp review-undo-fixture.txt

hunk_count=$(git diff HEAD -- review-undo-fixture.txt | grep -c '^@@')
test "$hunk_count" -eq 2
`,
  });

  expect(result.success).toBe(true);
  if (!result.success) {
    return;
  }

  expect(result.data.success).toBe(true);
}

describeIntegration("Immersive review undo (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("U restores the last read hunk and resets the line cursor", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = setupTestDom();
      await seedTwoHunkReviewDiff(env.orpc, workspaceId);

      const view = await renderReviewPanelForUndoTests({
        apiClient: env.orpc,
        metadata,
        workspaceId,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await view.selectTab("review");

        // Scope to the panel: once the panel reports its stats, the Review tab label also
        // shows "0/2", and a document-wide query then matches twice (#5457).
        await waitFor(
          () => {
            expect(within(view.getByTestId("review-panel")).getByText("0/2")).toBeTruthy();
          },
          { timeout: 30_000 }
        );

        fireEvent.click(view.getByRole("button", { name: "Enter immersive review" }));

        const body = within(view.container.ownerDocument.body);
        const immersiveView = await body.findByTestId(
          "immersive-review-view",
          {},
          { timeout: 10_000 }
        );

        // Entering immersive mode and undoing are the slow steps under CPU load. Measured on 2
        // CPUs shared with 24 busy-loop processes: 2.6-2.8 s here and 0.7-1.1 s after the undo
        // (0.1-0.2 s and ~50 ms idle), so the 1 s default fails under load. 10 s matches the
        // immersive-view wait above.
        await waitFor(
          () => {
            expect(within(immersiveView).getByText("Hunk 1/2")).toBeTruthy();
            expect(within(immersiveView).getByText("Lines 1-1")).toBeTruthy();
          },
          { timeout: 10_000 }
        );

        await waitFor(() => {
          expect(immersiveView.querySelector<HTMLElement>('[data-line-index="1"]')).not.toBeNull();
        });
        const firstHunkSecondLine =
          immersiveView.querySelector<HTMLElement>('[data-line-index="1"]');
        fireEvent.click(firstHunkSecondLine!);

        await waitFor(() => {
          expect(within(immersiveView).getByText("Lines 2-2")).toBeTruthy();
        });

        fireEvent.click(
          within(immersiveView).getAllByRole("button", { name: "Mark hunk as read" })[0]
        );

        await waitFor(() => {
          expect(within(immersiveView).getByText("Hunk 1/1")).toBeTruthy();
        });

        await waitFor(() => {
          expect(immersiveView.querySelector<HTMLElement>('[data-line-index="1"]')).not.toBeNull();
        });
        const secondHunkSecondLine =
          immersiveView.querySelector<HTMLElement>('[data-line-index="1"]');
        fireEvent.click(secondHunkSecondLine!);

        await waitFor(() => {
          expect(within(immersiveView).getByText("Lines 2-2")).toBeTruthy();
        });

        const undoEvent = new window.KeyboardEvent("keydown", {
          key: "u",
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(undoEvent);

        await waitFor(
          () => {
            expect(within(immersiveView).getByText("Hunk 1/2")).toBeTruthy();
            expect(within(immersiveView).getByText("Lines 1-1")).toBeTruthy();
          },
          { timeout: 10_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 120_000);
});
