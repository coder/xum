import { type Page } from "@playwright/test";
import { electronExpect as expect, electronTest as test } from "../electronTest";
import { REVIEW_SORT_ORDER_KEY } from "../../../src/common/constants/storage";
import { STORAGE_KEYS } from "../../../src/constants/workspaceDefaults";
import {
  disableReviewTutorial,
  seedLargeReviewSingleFileDiff,
  seedReviewHydrationJumpDiff,
  seedReviewMarkReadIterationDiff,
} from "../utils/reviewPerfFixture";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

interface HydrationSample {
  t: number;
  overlayVisible: boolean;
  stageVisible: boolean;
  minimapStageVisible: boolean;
  lineCount: number;
  overlayLineCount: number | null;
  selectedLineIndex: number | null;
  scrollTop: number | null;
  overlayTop: number | null;
  overlayHeight: number | null;
  scrollContainerTop: number | null;
  scrollContainerHeight: number | null;
  minimapCanvasTop: number | null;
  minimapCanvasHeight: number | null;
  selectedTop: number | null;
  activeFilePath: string | null;
  overlayState: string | null;
}

async function primeReviewForHeadDiff(
  page: Page,
  workspaceId: string,
  options: { showReadHunks?: boolean } = {}
): Promise<void> {
  const reviewDiffBaseKey = STORAGE_KEYS.reviewDiffBase(workspaceId);

  await page.evaluate(
    ({ diffBaseKey, sortOrderKey, showReadHunks }) => {
      window.localStorage.setItem(diffBaseKey, JSON.stringify("HEAD"));
      window.localStorage.setItem("review-show-read", JSON.stringify(showReadHunks));
      window.localStorage.setItem(sortOrderKey, JSON.stringify("file-order"));
    },
    {
      diffBaseKey: reviewDiffBaseKey,
      sortOrderKey: REVIEW_SORT_ORDER_KEY,
      showReadHunks: options.showReadHunks ?? true,
    }
  );
}

async function startHydrationSampler(
  page: Page,
  selectedFullLineIndex: number | null
): Promise<void> {
  await page.evaluate((targetLineIndex) => {
    const samples: HydrationSample[] = [];
    let frameId: number | null = null;
    let running = true;
    const startedAt = performance.now();

    const isVisible = (element: Element | null): boolean => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const sample = () => {
      const immersiveView = document.querySelector<HTMLElement>(
        '[data-testid="immersive-review-view"]'
      );
      const stage = document.querySelector<HTMLElement>(
        '[data-testid="immersive-diff-reveal-stage"]'
      );
      const overlay = document.querySelector<HTMLElement>(
        '[data-testid="immersive-diff-reveal-overlay"]'
      );
      const minimapStage = document.querySelector<HTMLElement>(
        '[data-testid="immersive-minimap-reveal-stage"]'
      );
      const minimapCanvas = document.querySelector<HTMLElement>(
        '[data-testid="immersive-minimap-canvas"]'
      );
      const lines = stage
        ? Array.from(stage.querySelectorAll<HTMLElement>("div[data-line-index]"))
        : [];
      const selectedLineIndexText =
        immersiveView?.dataset.selectedLineIndex ?? stage?.dataset.selectedLineIndex ?? null;
      const parsedSelectedLineIndex =
        selectedLineIndexText == null ? Number.NaN : Number.parseInt(selectedLineIndexText, 10);
      const sampledLineIndex =
        targetLineIndex ??
        (Number.isFinite(parsedSelectedLineIndex) ? parsedSelectedLineIndex : null);
      const selectedLine =
        sampledLineIndex == null
          ? null
          : (stage?.querySelector<HTMLElement>(`div[data-line-index="${sampledLineIndex}"]`) ??
            null);
      const scrollContainer = stage?.closest<HTMLElement>(".overflow-y-auto") ?? null;
      const overlayRect = overlay?.getBoundingClientRect() ?? null;
      const scrollContainerRect = scrollContainer?.getBoundingClientRect() ?? null;
      const minimapCanvasRect = minimapCanvas?.getBoundingClientRect() ?? null;
      const overlayLineCountText =
        immersiveView?.dataset.overlayLineCount ?? stage?.dataset.overlayLineCount ?? null;
      const overlayLineCount =
        overlayLineCountText == null ? Number.NaN : Number.parseInt(overlayLineCountText, 10);

      samples.push({
        t: performance.now() - startedAt,
        overlayVisible: isVisible(overlay),
        overlayTop: overlayRect?.top ?? null,
        overlayHeight: overlayRect?.height ?? null,
        scrollContainerTop: scrollContainerRect?.top ?? null,
        scrollContainerHeight: scrollContainerRect?.height ?? null,
        minimapStageVisible: isVisible(minimapStage),
        minimapCanvasTop: minimapCanvasRect?.top ?? null,
        minimapCanvasHeight: minimapCanvasRect?.height ?? null,
        stageVisible: isVisible(stage),
        lineCount: lines.length,
        overlayLineCount: Number.isFinite(overlayLineCount) ? overlayLineCount : null,
        selectedLineIndex: sampledLineIndex,
        scrollTop: scrollContainer?.scrollTop ?? null,
        selectedTop: selectedLine?.getBoundingClientRect().top ?? null,
        activeFilePath:
          immersiveView?.dataset.activeFilePath ?? stage?.dataset.activeFilePath ?? null,
        overlayState: immersiveView?.dataset.overlayState ?? stage?.dataset.overlayState ?? null,
      });

      if (running) {
        frameId = window.requestAnimationFrame(sample);
      }
    };

    window.__muxHydrationJumpSampler = {
      samples,
      stop: () => {
        running = false;
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
          frameId = null;
        }
        sample();
        return samples;
      },
    };

    frameId = window.requestAnimationFrame(sample);
  }, selectedFullLineIndex);
}

async function stopHydrationSampler(page: Page): Promise<HydrationSample[]> {
  return page.evaluate(() => window.__muxHydrationJumpSampler?.stop() ?? []);
}

declare global {
  interface Window {
    __muxHydrationJumpSampler?: {
      samples: HydrationSample[];
      stop: () => HydrationSample[];
    };
  }
}

test.describe("immersive review hydration stability", () => {
  test("keeps m-key mark-read loading overlay sized to the scrollport", async ({
    page,
    ui,
    workspace,
  }) => {
    await disableReviewTutorial(page);
    const diffSummary = seedReviewMarkReadIterationDiff(workspace.demoProject.workspacePath);

    await primeReviewForHeadDiff(page, workspace.demoProject.workspaceId);

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
    await immersiveButton.dispatchEvent("click");

    const immersiveReview = page.getByTestId("immersive-review-view");
    await expect(immersiveReview).toBeVisible({ timeout: 20_000 });
    await expect(immersiveReview.getByText(diffSummary.filePaths[0])).toBeVisible({
      timeout: 20_000,
    });
    await expect(immersiveReview.getByTestId("immersive-diff-reveal-overlay")).not.toBeVisible({
      timeout: 20_000,
    });

    await startHydrationSampler(page, null);
    await immersiveReview.focus();
    await page.evaluate(async (filePaths) => {
      const immersiveView = document.querySelector<HTMLElement>(
        '[data-testid="immersive-review-view"]'
      );
      if (!immersiveView) {
        throw new Error("Immersive review view was not found");
      }

      const waitForFrame = () =>
        new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

      for (const filePath of filePaths.slice(1)) {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "m",
            bubbles: true,
            cancelable: true,
          })
        );

        while (immersiveView.dataset.activeFilePath !== filePath) {
          await waitForFrame();
        }
        await waitForFrame();
      }
    }, diffSummary.filePaths);

    const samples = await stopHydrationSampler(page);
    const overlaySamples = samples.filter(
      (sample) =>
        sample.overlayVisible &&
        sample.overlayTop !== null &&
        sample.overlayHeight !== null &&
        sample.scrollContainerTop !== null &&
        sample.scrollContainerHeight !== null
    );
    expect(overlaySamples.length).toBeGreaterThan(0);

    for (const sample of overlaySamples) {
      expect(
        Math.abs((sample.overlayTop ?? 0) - (sample.scrollContainerTop ?? 0))
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs((sample.overlayHeight ?? 0) - (sample.scrollContainerHeight ?? 0))
      ).toBeLessThanOrEqual(2);
    }

    expect(overlaySamples.every((sample) => !sample.minimapStageVisible)).toBe(true);

    const hiddenRevealSamples = samples.filter(
      (sample) => !sample.stageVisible && sample.overlayVisible
    );
    expect(hiddenRevealSamples.length).toBeGreaterThan(0);
    expect(
      samples.filter((sample) => !sample.stageVisible).every((sample) => sample.overlayVisible)
    ).toBe(true);
  });

  test("keeps Shift+M file-read advancement covered while read hunks are hidden", async ({
    page,
    ui,
    workspace,
  }) => {
    await disableReviewTutorial(page);
    const diffSummary = seedReviewMarkReadIterationDiff(workspace.demoProject.workspacePath);

    await primeReviewForHeadDiff(page, workspace.demoProject.workspaceId, { showReadHunks: false });

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
    await immersiveButton.dispatchEvent("click");

    const immersiveReview = page.getByTestId("immersive-review-view");
    await expect(immersiveReview).toBeVisible({ timeout: 20_000 });
    await expect(immersiveReview.getByText(diffSummary.filePaths[0])).toBeVisible({
      timeout: 20_000,
    });
    await expect(immersiveReview.getByTestId("immersive-diff-reveal-overlay")).not.toBeVisible({
      timeout: 20_000,
    });

    await startHydrationSampler(page, null);
    await immersiveReview.focus();
    await page.evaluate(async (nextFilePath) => {
      const sampler = window.__muxHydrationJumpSampler;
      if (sampler) {
        sampler.samples.length = 0;
      }
      const immersiveView = document.querySelector<HTMLElement>(
        '[data-testid="immersive-review-view"]'
      );
      if (!immersiveView) {
        throw new Error("Immersive review view was not found");
      }

      const waitForFrame = () =>
        new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "M",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );

      while (immersiveView.dataset.activeFilePath !== nextFilePath) {
        await waitForFrame();
      }
      await waitForFrame();
    }, diffSummary.filePaths[1]);

    await expect(immersiveReview.getByText(diffSummary.filePaths[1])).toBeVisible({
      timeout: 20_000,
    });
    const samples = await stopHydrationSampler(page);
    const staleVisibleSamples = samples.filter(
      (sample) =>
        sample.stageVisible &&
        !sample.overlayVisible &&
        sample.activeFilePath !== null &&
        sample.activeFilePath !== diffSummary.filePaths[1]
    );
    expect(staleVisibleSamples).toEqual([]);

    expect(
      samples
        .filter((sample) => sample.overlayVisible)
        .every((sample) => !sample.minimapStageVisible)
    ).toBe(true);
    expect(
      samples.filter((sample) => !sample.stageVisible).every((sample) => sample.overlayVisible)
    ).toBe(true);
  });

  test("keeps compact-to-full file hydration hidden until selected hunk geometry is stable", async ({
    page,
    ui,
    workspace,
  }) => {
    await disableReviewTutorial(page);
    const diffSummary = seedReviewHydrationJumpDiff(workspace.demoProject.workspacePath);
    const expectedFullOverlayLineCount = diffSummary.lineCount + diffSummary.deletedLines;

    await primeReviewForHeadDiff(page, workspace.demoProject.workspaceId);

    await ui.projects.openFirstWorkspace();
    await ui.metaSidebar.expectVisible();
    await ui.metaSidebar.selectTab("Review");

    const reviewPanel = page.getByTestId("review-panel");
    await expect(reviewPanel).toBeVisible();
    await expect(reviewPanel.getByText("0/1", { exact: true })).toBeVisible({ timeout: 20_000 });

    const immersiveButton = reviewPanel.getByRole("button", { name: "Enter immersive review" });
    await expect(immersiveButton).toBeVisible();
    await startHydrationSampler(page, diffSummary.changedLineNumber);
    await immersiveButton.dispatchEvent("click");

    const immersiveReview = page.getByTestId("immersive-review-view");
    await expect(immersiveReview).toBeVisible({ timeout: 20_000 });
    await expect(immersiveReview).toHaveAttribute("data-selected-hunk-position", "1", {
      timeout: 20_000,
    });

    const diffLineContainers = immersiveReview.locator(
      '[data-testid="immersive-diff-reveal-stage"] div[data-line-index]'
    );
    await expect(diffLineContainers).toHaveCount(expectedFullOverlayLineCount, { timeout: 20_000 });
    await expect(immersiveReview.getByTestId("immersive-diff-reveal-overlay")).not.toBeVisible({
      timeout: 20_000,
    });

    const samples = await stopHydrationSampler(page);
    expect(samples.length).toBeGreaterThan(0);

    const visibleCompactSamples = samples.filter(
      (sample) =>
        sample.stageVisible &&
        !sample.overlayVisible &&
        sample.lineCount > 0 &&
        sample.lineCount < expectedFullOverlayLineCount
    );
    expect(visibleCompactSamples).toEqual([]);

    const visibleOverlaySamples = samples.filter(
      (sample) => sample.overlayVisible && sample.overlayTop !== null
    );
    expect(visibleOverlaySamples.length).toBeGreaterThan(0);
    const overlayTops = visibleOverlaySamples.map((sample) => sample.overlayTop ?? 0);
    const overlayTopRange = Math.max(...overlayTops) - Math.min(...overlayTops);
    expect(overlayTopRange).toBeLessThanOrEqual(2);
    expect(visibleOverlaySamples.every((sample) => !sample.minimapStageVisible)).toBe(true);

    const visibleSelectedSamples = samples.filter(
      (sample) =>
        sample.stageVisible &&
        !sample.overlayVisible &&
        sample.lineCount === expectedFullOverlayLineCount &&
        sample.selectedTop !== null
    );
    expect(visibleSelectedSamples.length).toBeGreaterThan(0);

    const selectedTops = visibleSelectedSamples.map((sample) => sample.selectedTop ?? 0);
    const selectedTopRange = Math.max(...selectedTops) - Math.min(...selectedTops);
    expect(selectedTopRange).toBeLessThanOrEqual(2);
  });

  test("keeps same-file J/K hunk iteration visually stable after hydration", async ({
    page,
    ui,
    workspace,
  }) => {
    await disableReviewTutorial(page);
    const diffSummary = seedLargeReviewSingleFileDiff(workspace.demoProject.workspacePath, {
      hunkCount: 24,
      hunkSpacing: 20,
      lineCount: 600,
    });
    const expectedFullOverlayLineCount = diffSummary.lineCount + diffSummary.deletedLines;

    await primeReviewForHeadDiff(page, workspace.demoProject.workspaceId);

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
    await immersiveButton.dispatchEvent("click");

    const immersiveReview = page.getByTestId("immersive-review-view");
    await expect(immersiveReview).toBeVisible({ timeout: 20_000 });
    await expect(immersiveReview).toHaveAttribute("data-selected-hunk-position", "1", {
      timeout: 20_000,
    });

    const diffLineContainers = immersiveReview.locator(
      '[data-testid="immersive-diff-reveal-stage"] div[data-line-index]'
    );
    await expect(diffLineContainers).toHaveCount(expectedFullOverlayLineCount, { timeout: 20_000 });
    await expect(immersiveReview.getByTestId("immersive-diff-reveal-overlay")).not.toBeVisible({
      timeout: 20_000,
    });

    await startHydrationSampler(page, null);
    await immersiveReview.focus();
    await page.evaluate(async () => {
      const immersiveView = document.querySelector<HTMLElement>(
        '[data-testid="immersive-review-view"]'
      );
      if (!immersiveView) {
        throw new Error("Immersive review view was not found");
      }

      const waitForFrame = () =>
        new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

      for (let step = 0; step < 10; step += 1) {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "j",
            bubbles: true,
            cancelable: true,
          })
        );

        const expectedPosition = String(step + 2);
        while (immersiveView.dataset.selectedHunkPosition !== expectedPosition) {
          await waitForFrame();
        }
        await waitForFrame();
      }
    });

    const samples = await stopHydrationSampler(page);
    expect(samples.length).toBeGreaterThan(0);

    // Same-file J/K must never replay the loading cover: the file is already hydrated, so
    // iterating hunks is an instant scroll, not a loading state.
    expect(samples.filter((sample) => sample.overlayVisible)).toEqual([]);

    const visibleCompactSamples = samples.filter(
      (sample) =>
        sample.stageVisible &&
        !sample.overlayVisible &&
        (sample.overlayLineCount ?? sample.lineCount) > 0 &&
        (sample.overlayLineCount ?? sample.lineCount) < expectedFullOverlayLineCount
    );
    expect(visibleCompactSamples).toEqual([]);

    const visibleSelectedSamples = samples.filter(
      (sample) =>
        sample.stageVisible &&
        !sample.overlayVisible &&
        sample.selectedTop !== null &&
        sample.scrollContainerTop !== null &&
        sample.scrollContainerHeight !== null
    );
    expect(visibleSelectedSamples.length).toBeGreaterThan(0);
    for (const sample of visibleSelectedSamples) {
      const containerTop = sample.scrollContainerTop ?? 0;
      const containerBottom = containerTop + (sample.scrollContainerHeight ?? 0);
      expect(sample.selectedTop ?? 0).toBeGreaterThanOrEqual(containerTop - 4);
      expect(sample.selectedTop ?? 0).toBeLessThanOrEqual(containerBottom + 4);
    }

    const scrollSamples = samples
      .filter(
        (sample) => sample.stageVisible && !sample.overlayVisible && sample.scrollTop !== null
      )
      .map((sample) => sample.scrollTop ?? 0);
    expect(scrollSamples.length).toBeGreaterThan(0);
    let furthestScrollTop = scrollSamples[0] ?? 0;
    for (const scrollTop of scrollSamples) {
      expect(scrollTop).toBeGreaterThanOrEqual(furthestScrollTop - 4);
      furthestScrollTop = Math.max(furthestScrollTop, scrollTop);
    }
  });

  test("keeps same-file mark-read iteration instant while read hunks are hidden", async ({
    page,
    ui,
    workspace,
  }) => {
    await disableReviewTutorial(page);
    const diffSummary = seedLargeReviewSingleFileDiff(workspace.demoProject.workspacePath, {
      hunkCount: 24,
      hunkSpacing: 20,
      lineCount: 600,
    });
    const expectedFullOverlayLineCount = diffSummary.lineCount + diffSummary.deletedLines;

    // Hide read hunks so marking a hunk read removes it from the visible set -- the
    // overlay rebuild that previously re-read the file and replayed the loading cover.
    await primeReviewForHeadDiff(page, workspace.demoProject.workspaceId, { showReadHunks: false });

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
    await immersiveButton.dispatchEvent("click");

    const immersiveReview = page.getByTestId("immersive-review-view");
    await expect(immersiveReview).toBeVisible({ timeout: 20_000 });
    await expect(immersiveReview).toHaveAttribute("data-selected-hunk-position", "1", {
      timeout: 20_000,
    });
    // Wait for full-file hydration so the file is on screen before we start marking hunks.
    const diffLineContainers = immersiveReview.locator(
      '[data-testid="immersive-diff-reveal-stage"] div[data-line-index]'
    );
    await expect(diffLineContainers).toHaveCount(expectedFullOverlayLineCount, { timeout: 20_000 });
    await expect(immersiveReview.getByTestId("immersive-diff-reveal-overlay")).not.toBeVisible({
      timeout: 20_000,
    });

    await startHydrationSampler(page, null);
    await immersiveReview.focus();
    await page.evaluate(async () => {
      const immersiveView = document.querySelector<HTMLElement>(
        '[data-testid="immersive-review-view"]'
      );
      if (!immersiveView) {
        throw new Error("Immersive review view was not found");
      }

      const waitForFrame = () =>
        new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const startPath = immersiveView.dataset.activeFilePath;
      // Mark several hunks read within the same file; each removes the selected hunk and
      // advances to the next one without leaving the file.
      for (let step = 0; step < 8; step += 1) {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "m", bubbles: true, cancelable: true })
        );
        for (let frame = 0; frame < 6; frame += 1) {
          await waitForFrame();
        }
        if (immersiveView.dataset.activeFilePath !== startPath) {
          break;
        }
      }
    });

    const samples = await stopHydrationSampler(page);
    expect(samples.length).toBeGreaterThan(0);

    // The whole iteration stays in one file, so the loading cover must never appear and
    // the diff stage must never be hidden behind it.
    expect(samples.filter((sample) => sample.overlayVisible)).toEqual([]);
    expect(samples.every((sample) => sample.stageVisible)).toBe(true);
  });
});
