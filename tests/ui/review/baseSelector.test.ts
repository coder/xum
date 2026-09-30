/**
 * Integration tests for ReviewPanel base selector.
 *
 * Tests use UI interactions (clicking dropdown, selecting suggestions) to verify
 * that changing the diff base works correctly. Pattern follows agentPicker tests.
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  configureTestRetries,
  createSharedRepo,
  withSharedWorkspace,
} from "../../ipc/sendMessageTestHelpers";

import { installDom } from "../dom";
import { renderReviewPanel, type RenderedApp } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { STORAGE_KEYS, WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";

configureTestRetries(2);

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Helper to set up the full App UI and navigate to the Review tab.
 */
async function setupReviewPanel(
  view: RenderedApp,
  metadata: FrontendWorkspaceMetadata,
  workspaceId: string
): Promise<void> {
  await setupWorkspaceView(view, metadata, workspaceId);
  await view.selectTab("review");
  // Wait for ReviewControls to render (base selector is always shown).
  // We avoid waiting on diff output here because the default base is a trunk ref,
  // which may not exist as a remote tracking branch in test repos.
  await waitFor(
    () => {
      const btn = view.container.querySelector('[data-testid="review-base-value"]');
      if (!btn) throw new Error("Base selector trigger not found");
    },
    { timeout: 60_000 }
  );
}

/**
 * Open the base selector dropdown by clicking the trigger button.
 * The component uses conditional rendering (not portal), so dropdown is inside container.
 */
async function openBaseSelectorDropdown(container: HTMLElement): Promise<void> {
  const trigger = await waitFor(
    () => {
      const btn = container.querySelector('[data-testid="review-base-value"]')!;
      if (!btn) throw new Error("Base selector trigger not found");
      return btn;
    },
    { timeout: 5_000 }
  );

  fireEvent.click(trigger);

  // Wait for dropdown to appear with input field
  await waitFor(
    () => {
      const input = container.querySelector('[placeholder="Enter base..."]');
      if (!input) throw new Error("Base selector dropdown not open");
    },
    { timeout: 5_000 }
  );
}

/**
 * Click a suggestion button in the base selector dropdown.
 */
async function selectBaseSuggestion(container: HTMLElement, base: string): Promise<void> {
  const button = await waitFor(
    () => {
      const btn = container.querySelector(`[data-testid="base-suggestion-${base}"]`)!;
      if (!btn) throw new Error(`Base suggestion "${base}" not found`);
      return btn;
    },
    { timeout: 2_000 }
  );
  fireEvent.click(button);
}

/**
 * Wait for the dropdown to close (input field no longer visible).
 */
async function waitForDropdownClose(container: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const input = container.querySelector('[placeholder="Enter base..."]');
      if (input) throw new Error("Dropdown still open");
    },
    { timeout: 2_000 }
  );
}

/**
 * Get the current displayed base value from the trigger button.
 */
function getDisplayedBase(container: HTMLElement): string {
  const trigger = container.querySelector('[data-testid="review-base-value"]');
  return trigger?.textContent ?? "";
}

// ═══════════════════════════════════════════════════════════════════════════════
// BASE SELECTOR TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("ReviewPanel base selector", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("clicking a suggestion updates the displayed base value", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      // Reset persisted review-base keys so this test validates trunk auto-detection
      // rather than inheriting state from prior tests in the same browser storage.
      updatePersistedState(STORAGE_KEYS.reviewDefaultBase(metadata.projectPath), null);
      updatePersistedState(STORAGE_KEYS.reviewDiffBase(workspaceId), null);

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupReviewPanel(view, metadata, workspaceId);

        const branchResult = await env.orpc.projects.listBranches({
          projectPath: metadata.projectPath,
        });
        const expectedInitialBase =
          branchResult.recommendedTrunk && branchResult.recommendedTrunk.trim().length > 0
            ? `origin/${branchResult.recommendedTrunk.trim()}`
            : WORKSPACE_DEFAULTS.reviewBase;

        await waitFor(
          () => {
            expect(getDisplayedBase(view.container)).toBe(expectedInitialBase);
          },
          { timeout: 5_000 }
        );

        // Open dropdown and click HEAD~1
        await openBaseSelectorDropdown(view.container);
        await selectBaseSuggestion(view.container, "HEAD~1");
        await waitForDropdownClose(view.container);

        // Verify the displayed value updated
        await waitFor(
          () => {
            expect(getDisplayedBase(view.container)).toBe("HEAD~1");
          },
          { timeout: 5_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 90_000);

  test("multiple suggestion clicks work correctly", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupReviewPanel(view, metadata, workspaceId);

        // Click through multiple suggestions
        const selections = ["HEAD~1", "main", "origin/main"];

        for (const base of selections) {
          await openBaseSelectorDropdown(view.container);
          await selectBaseSuggestion(view.container, base);
          await waitForDropdownClose(view.container);

          await waitFor(
            () => {
              expect(getDisplayedBase(view.container)).toBe(base);
            },
            { timeout: 5_000 }
          );
        }

        // Final verification
        expect(getDisplayedBase(view.container)).toBe("origin/main");
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 90_000);
});
