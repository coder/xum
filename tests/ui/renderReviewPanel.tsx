import { render, type RenderResult, waitFor } from "@testing-library/react";

import { AppLoader } from "@/browser/components/AppLoader/AppLoader";
import type { APIClient } from "@/browser/contexts/API";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

/** Row names in the right sidebar's New tab launcher. */
const LAUNCHER_TOOL_NAMES = { costs: "Stats", review: "Review", terminal: "Terminal" } as const;

interface RenderReviewPanelParams {
  apiClient: APIClient;
  /** Metadata for the workspace to select (optional - app can render without a workspace) */
  metadata?: FrontendWorkspaceMetadata;
}

export interface RenderedApp extends RenderResult {
  /** Wait for app to be ready (loading screen gone) */
  waitForReady(): Promise<void>;
  /** Select a workspace by clicking in sidebar */
  selectWorkspace(workspaceId: string): Promise<void>;
  /** Switch to a specific tab in the right sidebar */
  selectTab(tab: "costs" | "review"): Promise<void>;
}

/**
 * Render the full App via AppLoader for true integration testing.
 * This exercises the real component tree, providers, and state management.
 *
 * @deprecated Use renderApp instead - the name better reflects what this does
 */
export function renderReviewPanel(props: RenderReviewPanelParams): RenderedApp {
  return renderApp(props);
}

/**
 * Render the full App via AppLoader for true integration testing.
 * This exercises the real component tree, providers, and state management.
 */
export function renderApp(props: RenderReviewPanelParams): RenderedApp {
  const result = render(<AppLoader client={props.apiClient} />);

  return {
    ...result,

    async waitForReady(): Promise<void> {
      // Wait for loading screen to disappear
      await waitFor(
        () => {
          const loading = result.container.querySelector('[data-testid="loading-screen"]');
          if (loading) {
            throw new Error("Still loading");
          }
          // Also check for "Loading..." text
          if (result.container.textContent?.includes("Loading...")) {
            throw new Error("Still loading");
          }
        },
        { timeout: 10000 }
      );
    },

    async selectWorkspace(workspaceId: string): Promise<void> {
      await waitFor(
        () => {
          // Find workspace in sidebar by data attribute or text
          const workspaceElement = result.container.querySelector(
            `[data-workspace-id="${workspaceId}"]`
          );
          if (!workspaceElement) {
            throw new Error(`Workspace ${workspaceId} not found in sidebar`);
          }
          (workspaceElement as HTMLElement).click();
        },
        { timeout: 5000 }
      );
    },

    async selectTab(tab: "costs" | "review" | "terminal"): Promise<void> {
      await waitFor(
        () => {
          // Find tab button by role and name
          const tabButton = result.container.querySelector<HTMLElement>(
            `[role="tab"][aria-controls*="${tab}"]`
          );
          if (tabButton) {
            tabButton.click();
            return;
          }
          // The strip holds only opened tabs: open the tool from a New tab's launcher, adding
          // a New tab with "+" first when none is showing. The retry then selects the tab.
          const launcherRow = Array.from(
            result.container.querySelectorAll<HTMLElement>(
              '[role="tabpanel"][id*="-panel-new"] button'
            )
          ).find((row) => row.getAttribute("aria-label") === LAUNCHER_TOOL_NAMES[tab]);
          if (launcherRow) {
            launcherRow.click();
          } else {
            result.container.querySelector<HTMLElement>('button[aria-label="New tab"]')?.click();
          }
          throw new Error(`Tab "${tab}" not open yet`);
        },
        { timeout: 5000 }
      );
    },
  };
}
