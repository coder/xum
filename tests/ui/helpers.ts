/**
 * Shared UI test helpers for integration coverage (review panel, project creation, git status, etc.).
 */

import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FrontendWorkspaceMetadata, GitStatus } from "@/common/types/workspace";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { TUTORIAL_STATE_KEY, WORKSPACE_DRAFTS_BY_PROJECT_KEY } from "@/common/constants/storage";
import type { RenderedApp } from "./renderReviewPanel";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { useGitStatusStoreRaw } from "@/browser/stores/GitStatusStore";

// ═══════════════════════════════════════════════════════════════════════════════
// REFRESH BUTTON HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the CSS class of the refresh button's SVG icon.
 */
export function getRefreshIconClass(refreshButton: HTMLElement): string {
  return refreshButton.querySelector("svg")?.getAttribute("class") ?? "";
}

/**
 * Wait for the refresh button to be in idle state (not spinning or stopping).
 */
export async function waitForRefreshButtonIdle(
  refreshButton: HTMLElement,
  timeoutMs = 60_000
): Promise<void> {
  await waitFor(
    () => {
      const cls = getRefreshIconClass(refreshButton);
      expect(cls).not.toContain("animate-spin");
      // Stopping state uses `animate-[spin_0.8s_ease-out_forwards]`.
      expect(cls).not.toContain("animate-[");
    },
    { timeout: timeoutMs }
  );
}

/**
 * Assert that the refresh button has lastRefreshInfo data attribute set.
 * We use a data attribute because Radix tooltip portals don't work in happy-dom.
 */
export async function assertRefreshButtonHasLastRefreshInfo(
  refreshButton: HTMLElement,
  expectedTrigger: string,
  timeoutMs = 5_000
): Promise<void> {
  await waitFor(
    () => {
      const trigger = refreshButton.getAttribute("data-last-refresh-trigger");
      if (!trigger) {
        throw new Error("data-last-refresh-trigger not set on button");
      }
      if (trigger !== expectedTrigger) {
        throw new Error(`Expected trigger "${expectedTrigger}" but got "${trigger}"`);
      }
    },
    { timeout: timeoutMs }
  );
}

/**
 * Simulate a file-modifying tool completion (e.g., file_edit_*, bash).
 * This triggers the RefreshController's schedule() without requiring actual AI calls.
 */
export function simulateFileModifyingToolEnd(workspaceId: string): void {
  workspaceStore.simulateFileModifyingToolEnd(workspaceId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE/VIEW SETUP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Set up the full App UI and navigate to a workspace.
 * Expands project tree and selects the workspace.
 */
export async function setupWorkspaceView(
  view: RenderedApp,
  metadata: FrontendWorkspaceMetadata,
  workspaceId: string
): Promise<void> {
  await view.waitForReady();

  // Expand project tree
  const projectRow = await waitFor(
    () => {
      const el = view.container.querySelector(`[data-project-path="${metadata.projectPath}"]`);
      if (!el) throw new Error("Project not found in sidebar");
      return el as HTMLElement;
    },
    { timeout: 10_000 }
  );

  const expandButton = projectRow.querySelector('[aria-label*="Expand project"]');
  if (expandButton) {
    fireEvent.click(expandButton);
  } else {
    fireEvent.click(projectRow);
  }

  // Select the workspace
  const workspaceElement = await waitFor(
    () => {
      const el = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
      if (!el) throw new Error("Workspace not found in sidebar");
      // Wait until the workspace is selectable (not still creating) before clicking.
      if (el.getAttribute("aria-disabled") === "true") {
        throw new Error("Workspace still disabled");
      }
      return el as HTMLElement;
    },
    { timeout: 10_000 }
  );
  fireEvent.click(workspaceElement);

  // Ensure the workspace is registered and activated in the store so that
  // runOnChatSubscription starts. In the real app, WorkspaceContext handles
  // registration via syncWorkspaces and activation via useLayoutEffect, but
  // in happy-dom tests these may not have completed by the time the test
  // asserts on transcript content. Both calls are idempotent.
  workspaceStore.addWorkspace(metadata);
  workspaceStore.setActiveWorkspaceId(workspaceId);
}

/**
 * Navigate to a project's creation page (ProjectPage) by clicking the project row.
 *
 * Tests that need the creation UI must explicitly open the project page.
 */
export async function openProjectCreationView(
  view: RenderedApp,
  projectPath: string
): Promise<void> {
  await view.waitForReady();

  const projectRow = await waitFor(
    () => {
      const el = view.container.querySelector(
        `[data-project-path="${projectPath}"][aria-controls]`
      );
      if (!el) throw new Error("Project not found in sidebar");
      return el;
    },
    { timeout: 10_000 }
  );

  fireEvent.click(projectRow);

  await waitFor(
    () => {
      const textarea = view.container.querySelector("textarea");
      if (!textarea) {
        throw new Error("Project creation page not rendered");
      }
    },
    { timeout: 10_000 }
  );
}

/**
 * Add a project through the sidebar modal.
 * Radix Dialog content is portaled to document.body, so query the body instead of the app container.
 */
export async function addProjectViaUI(view: RenderedApp, projectPath: string): Promise<string> {
  await view.waitForReady();

  const existingProjectPaths = new Set(
    Array.from(view.container.querySelectorAll("[data-project-path]"))
      .map((element) => element.getAttribute("data-project-path"))
      .filter((value): value is string => !!value)
  );

  // Shared UI test state can already include the project; avoid re-adding it and
  // triggering the "Project already exists" dialog error.
  const normalizedInputPath = projectPath.replace(/[\\/]+$/, "");
  const existingMatch = Array.from(existingProjectPaths).find((existingPath) => {
    return existingPath.replace(/[\\/]+$/, "") === normalizedInputPath;
  });
  if (existingMatch) {
    return existingMatch;
  }

  const addProjectButton = await waitFor(
    () => {
      const button = view.container.querySelector('[aria-label="Add project"]');
      if (!button) {
        throw new Error("Add project button not found");
      }
      return button as HTMLElement;
    },
    { timeout: 10_000 }
  );

  fireEvent.click(addProjectButton);

  const body = within(view.container.ownerDocument.body);
  const dialog = await body.findByRole("dialog", {}, { timeout: 10_000 });
  const dialogCanvas = within(dialog);

  const pathInput = await dialogCanvas.findByRole("textbox", {}, { timeout: 10_000 });
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.clear(pathInput);
  await user.type(pathInput, projectPath);

  const submitButton = await dialogCanvas.findByRole(
    "button",
    { name: /add project/i },
    { timeout: 10_000 }
  );
  fireEvent.click(submitButton);

  const projectRow = await waitFor(
    () => {
      const error = dialog.querySelector(".text-error");
      if (error?.textContent) {
        throw new Error(`Project creation failed: ${error.textContent}`);
      }

      const rows = Array.from(view.container.querySelectorAll("[data-project-path]"));
      const newRow = rows.find((row) => {
        const path = row.getAttribute("data-project-path");
        return !!path && !existingProjectPaths.has(path);
      });

      if (!newRow) {
        throw new Error("Project row not found after adding project");
      }

      return newRow as HTMLElement;
    },
    { timeout: 10_000 }
  );

  const normalizedPath = projectRow.getAttribute("data-project-path");
  if (!normalizedPath) {
    throw new Error("Project row missing data-project-path");
  }

  return normalizedPath;
}

export function getWorkspaceDraftIds(projectPath: string): string[] {
  const parsedDrafts = readPersistedState<Record<string, { draftId: string }[]>>(
    WORKSPACE_DRAFTS_BY_PROJECT_KEY,
    {}
  );
  const draftsForProject = parsedDrafts[projectPath] ?? [];
  return draftsForProject.map((draft) => draft.draftId);
}

export async function waitForLatestDraftId(
  projectPath: string,
  timeoutMs = 5_000
): Promise<string> {
  return waitFor(
    () => {
      const drafts = getWorkspaceDraftIds(projectPath);
      const latestDraft = drafts[drafts.length - 1];
      if (!latestDraft) {
        throw new Error("Draft not registered yet");
      }
      return latestDraft;
    },
    { timeout: timeoutMs }
  );
}

/**
 * Clean up after a UI test: unmount view, run RTL cleanup, then restore DOM.
 * Use in finally blocks to ensure consistent cleanup.
 */
export async function cleanupView(view: RenderedApp, cleanupDom: () => void): Promise<void> {
  view.unmount();
  cleanup();
  // Wait for any pending React updates to settle before destroying DOM
  await new Promise((r) => setTimeout(r, 100));
  cleanupDom();
}

/**
 * Disable the tutorial overlay for tests.
 * Called automatically by setupTestDom().
 */
export function disableTutorial(): void {
  updatePersistedState(TUTORIAL_STATE_KEY, { disabled: true, completed: {} });
}

/**
 * Standard test DOM setup: installs happy-dom and disables tutorial by default.
 * Returns a cleanup function to restore DOM.
 *
 * @param options.enableTutorial - Set to true for tests that specifically test tutorial behavior
 */
export function setupTestDom(options?: { enableTutorial?: boolean }): () => void {
  // Import here to avoid circular dependency issues
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { installDom } = require("./dom") as typeof import("./dom");
  const cleanupDom = installDom();

  if (!options?.enableTutorial) {
    disableTutorial();
  }

  return cleanupDom;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIT STATUS HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the current git status for a workspace row.
 * Falls back to the shared GitStatusStore when inline data attributes are absent.
 */
export function getGitStatusFromElement(element: HTMLElement): Partial<GitStatus> | null {
  const statusAttr = element.getAttribute("data-git-status");
  if (statusAttr) {
    try {
      return JSON.parse(statusAttr) as Partial<GitStatus>;
    } catch {
      return null;
    }
  }

  const workspaceId = element.getAttribute("data-workspace-id");
  if (!workspaceId) {
    return null;
  }

  const store = useGitStatusStoreRaw();
  return store.getStatus(workspaceId);
}

/**
 * Wait for a workspace row to render and for git status to be available in the store.
 */
export async function waitForGitStatusElement(
  container: HTMLElement,
  workspaceId: string,
  timeoutMs = 30_000
): Promise<HTMLElement> {
  const store = useGitStatusStoreRaw();

  return waitFor(
    () => {
      const el = container.querySelector(`[data-workspace-id="${workspaceId}"]`);
      if (!el) throw new Error("Git status element not found");
      const status = store.getStatus(workspaceId);
      if (!status) throw new Error("Git status not yet available");
      return el as HTMLElement;
    },
    { timeout: timeoutMs }
  );
}

/**
 * Wait for git status to match a condition.
 */
async function waitForGitStatus(
  _container: HTMLElement,
  workspaceId: string,
  predicate: (status: Partial<GitStatus>) => boolean,
  description: string,
  timeoutMs: number
): Promise<GitStatus> {
  const store = useGitStatusStoreRaw();
  let lastStatus: Partial<GitStatus> | null = null;

  await waitFor(
    () => {
      lastStatus = store.getStatus(workspaceId);
      if (!lastStatus) throw new Error("Git status not yet available");
      if (!predicate(lastStatus)) {
        throw new Error(`Expected ${description}, got: ${JSON.stringify(lastStatus)}`);
      }
    },
    { timeout: timeoutMs }
  );

  return lastStatus as unknown as GitStatus;
}

/**
 * Wait for git status to indicate dirty (uncommitted changes).
 */
export function waitForDirtyStatus(
  container: HTMLElement,
  workspaceId: string,
  timeoutMs = 60_000
): Promise<GitStatus> {
  return waitForGitStatus(container, workspaceId, (s) => !!s.dirty, "dirty status", timeoutMs);
}

/**
 * Wait for git status to indicate clean (no uncommitted changes).
 */
export function waitForCleanStatus(
  container: HTMLElement,
  workspaceId: string,
  timeoutMs = 60_000
): Promise<GitStatus> {
  return waitForGitStatus(container, workspaceId, (s) => !s.dirty, "clean status", timeoutMs);
}

/**
 * Wait for git status to show at least N commits ahead of remote.
 */
export function waitForAheadStatus(
  container: HTMLElement,
  workspaceId: string,
  minAhead: number,
  timeoutMs = 60_000
): Promise<GitStatus> {
  return waitForGitStatus(
    container,
    workspaceId,
    (s) => (s.ahead ?? 0) >= minAhead,
    `ahead >= ${minAhead}`,
    timeoutMs
  );
}

/**
 * Wait for git status to report a specific branch name.
 */
export function waitForBranchStatus(
  container: HTMLElement,
  workspaceId: string,
  expectedBranch: string,
  timeoutMs = 60_000
): Promise<GitStatus> {
  return waitForGitStatus(
    container,
    workspaceId,
    (s) => s.branch === expectedBranch,
    `branch === "${expectedBranch}"`,
    timeoutMs
  );
}

/**
 * Wait for git status to be idle (no fetch in-flight) AND match a predicate.
 * Use this to ensure no background fetch can race with subsequent operations.
 */
export function waitForIdleGitStatus(
  workspaceId: string,
  predicate: (status: GitStatus) => boolean,
  description: string,
  timeoutMs = 60_000
): Promise<GitStatus> {
  const store = useGitStatusStoreRaw();

  return waitFor(
    () => {
      // Check global in-flight state, not per-workspace (initial fetch doesn't set per-workspace flag)
      if (store.isAnyRefreshInFlight()) {
        throw new Error("Git status fetch in-flight");
      }
      const status = store.getStatus(workspaceId);
      if (!status) throw new Error("Git status not yet available");
      if (!predicate(status)) {
        throw new Error(`Expected ${description}, got: ${JSON.stringify(status)}`);
      }
      return status;
    },
    { timeout: timeoutMs }
  );
}
