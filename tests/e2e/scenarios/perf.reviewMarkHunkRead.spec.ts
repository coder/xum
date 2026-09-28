import { electronTest as test, electronExpect as expect } from "../electronTest";
import { getXumE2EEnv } from "../env";
import { REVIEW_SORT_ORDER_KEY } from "../../../src/common/constants/storage";
import { STORAGE_KEYS } from "../../../src/constants/workspaceDefaults";
import {
  readReactProfileSnapshot,
  resetReactProfileSamples,
  withChromeProfiles,
  writePerfArtifacts,
} from "../utils/perfProfile";
import { LARGE_CHANGE_ROOT, seedLargeReviewDiff } from "../utils/reviewPerfFixture";

const shouldRunPerfScenarios = getXumE2EEnv("E2E_RUN_PERF") === "1";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("immersive review performance profiling", () => {
  test.skip(!shouldRunPerfScenarios, "Set XUM_E2E_RUN_PERF=1 to run perf profiling scenarios");

  test("perf: mark hunk as read in immersive review for a large diff", async ({
    page,
    ui,
    workspace,
  }, testInfo) => {
    const diffSummary = seedLargeReviewDiff(workspace.demoProject.workspacePath);
    const reviewDiffBaseKey = STORAGE_KEYS.reviewDiffBase(workspace.demoProject.workspaceId);

    // The demo repo has no origin/main, so the perf scenario pins Review to HEAD before
    // the panel mounts. That keeps the scenario focused on a real local git diff.
    await page.evaluate(
      ({ diffBaseKey, sortOrderKey }) => {
        window.localStorage.setItem(diffBaseKey, JSON.stringify("HEAD"));
        window.localStorage.setItem("review-show-read", JSON.stringify(true));
        window.localStorage.setItem(sortOrderKey, JSON.stringify("file-order"));
      },
      {
        diffBaseKey: reviewDiffBaseKey,
        sortOrderKey: REVIEW_SORT_ORDER_KEY,
      }
    );

    await ui.projects.openFirstWorkspace();
    await ui.metaSidebar.expectVisible();
    await ui.metaSidebar.selectTab("Review");

    const reviewPanel = page.getByTestId("review-panel");
    await expect(reviewPanel).toBeVisible();
    await expect(reviewPanel.getByText(`0/${diffSummary.hunkCount}`, { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    const immersiveButton = reviewPanel.getByRole("button", { name: "Enter immersive review" });
    await expect(immersiveButton).toBeVisible();
    // Dispatch directly so the review tutorial backdrop cannot intercept the perf interaction.
    await immersiveButton.dispatchEvent("click");

    const immersiveReview = page.getByTestId("immersive-review-view");
    await expect(immersiveReview).toBeVisible({ timeout: 20_000 });

    const firstFilePath = `${LARGE_CHANGE_ROOT}/group-01/bucket-01/probe-001.ts`;
    const secondFilePath = `${LARGE_CHANGE_ROOT}/group-01/bucket-01/probe-002.ts`;
    await expect(immersiveReview.getByText(firstFilePath)).toBeVisible({ timeout: 20_000 });
    await expect(immersiveReview).toHaveAttribute("data-selected-hunk-position", "1", {
      timeout: 20_000,
    });
    const markReadButton = immersiveReview.getByRole("button", { name: "Mark hunk as read" });
    await expect(markReadButton).toBeVisible({ timeout: 20_000 });

    await resetReactProfileSamples(page);

    const runLabel = `review-immersive-mark-read-${diffSummary.fileCount}-files-${diffSummary.hunkCount}-hunks`;
    const chromeProfile = await withChromeProfiles(page, { label: runLabel }, async () => {
      await markReadButton.dispatchEvent("click");
      await expect(immersiveReview.getByText(secondFilePath)).toBeVisible({ timeout: 20_000 });
      await expect(immersiveReview).toHaveAttribute("data-selected-hunk-position", "1", {
        timeout: 20_000,
      });
      await expect(immersiveReview.getByRole("button", { name: "Mark hunk as read" })).toBeVisible({
        timeout: 20_000,
      });
      // Read state lives in the backend review-state store now; the completion bar reflects
      // the composed store view the mark-read click updated.
      await expect
        .poll(
          async () =>
            Number(
              await immersiveReview
                .getByRole("progressbar", { name: "Review completion by changed lines" })
                .getAttribute("aria-valuenow")
            ),
          { timeout: 20_000 }
        )
        .toBeGreaterThan(0);
    });

    const reactProfileSnapshot = await readReactProfileSnapshot(page);
    if (!reactProfileSnapshot) {
      throw new Error("React profile snapshot was not captured");
    }

    const artifactDirectory = await writePerfArtifacts({
      testInfo,
      runLabel,
      chromeProfile,
      reactProfile: reactProfileSnapshot,
      historyProfile: {
        kind: "immersive-review-mark-read",
        ...diffSummary,
      },
    });

    expect(chromeProfile.wallTimeMs).toBeLessThan(1_000);
    expect(chromeProfile.cpuProfile).not.toBeNull();
    expect(reactProfileSnapshot.enabled).toBe(true);

    testInfo.annotations.push({
      type: "perf-artifact",
      description: artifactDirectory,
    });
  });
});
