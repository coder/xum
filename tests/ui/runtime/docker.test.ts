/**
 * UI integration tests for Docker runtime selection during workspace creation.
 *
 * These tests validate the creation controls without invoking real AI models:
 * - Docker runtime can be selected and exposes the image input
 * - Docker runtime is disabled for non-git projects (requires git)
 */

import "../dom";
import { waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { shouldRunIntegrationTests } from "../../testUtils";
import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import {
  checkedCreationIsolation,
  cleanupView,
  findCreationIsolationOption,
  openCreationEnvironment,
  openProjectCreationView,
  selectCreationIsolation,
} from "../helpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { expandProjects } from "@/browser/stories/helpers/uiState";
import type { ProjectConfig } from "@/node/config";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/** Helper to create a project config for a path with no workspaces */
function projectWithNoWorkspaces(path: string): [string, ProjectConfig] {
  return [path, { workspaces: [] }];
}

describeIntegration("Docker runtime selection (UI)", () => {
  test("selecting Docker shows image input", async () => {
    const cleanupDom = installDom();

    const projectPath = "/Users/dev/docker-project";
    expandProjects([projectPath]);

    const client = createMockORPCClient({
      projects: new Map([projectWithNoWorkspaces(projectPath)]),
      workspaces: [],
    });

    const view = renderApp({ apiClient: client });

    try {
      await view.waitForReady();
      await openProjectCreationView(view, projectPath);

      // Wait for runtime controls to render (depends on listBranches finishing)
      await waitFor(
        () => {
          const group = view.container.querySelector('[data-component="RuntimeTypeGroup"]');
          if (!group) {
            throw new Error("Runtime controls not found");
          }
        },
        { timeout: 5_000 }
      );

      await selectCreationIsolation(view.container, "Workspace isolation", "Docker");

      // Verify Docker runtime becomes active in the workspace-type trigger.
      await waitFor(
        () => {
          if (!checkedCreationIsolation("Workspace isolation").startsWith("Docker")) {
            throw new Error("Docker runtime not selected");
          }
        },
        { timeout: 2_000 }
      );

      // Docker image input should appear
      const imageInput = await waitFor(
        () => {
          const input = document.querySelector<HTMLInputElement>('input[placeholder="node:20"]');
          if (!input) {
            throw new Error("Docker image input not found");
          }
          return input;
        },
        { timeout: 2_000 }
      );

      // SSH host input should NOT be visible
      const hostInput = document.querySelector('input[placeholder="user@host"]');
      expect(hostInput).toBeNull();

      const user = userEvent.setup({ document: view.container.ownerDocument });
      await user.clear(imageInput);
      await user.type(imageInput, "node:20");
      expect(imageInput.value).toBe("node:20");

      // Switching to SSH should hide Docker image input and show host input
      await selectCreationIsolation(view.container, "Project isolation", "SSH");

      await waitFor(
        () => {
          const input = document.querySelector('input[placeholder="user@host"]');
          if (!input) throw new Error("SSH host input not found");
        },
        { timeout: 2_000 }
      );

      const imageInputAfter = document.querySelector('input[placeholder="node:20"]');
      expect(imageInputAfter).toBeNull();
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("Docker runtime is disabled for non-git projects", async () => {
    const cleanupDom = installDom();

    const projectPath = "/Users/dev/non-git-docker-project";
    expandProjects([projectPath]);

    // For non-git projects, the backend returns runtimeAvailability with git-based
    // runtimes unavailable. The UI uses this to disable the buttons.
    const client = createMockORPCClient({
      projects: new Map([projectWithNoWorkspaces(projectPath)]),
      workspaces: [],
      listBranches: async () => ({ branches: [], recommendedTrunk: null }),
      runtimeAvailability: {
        local: { available: true },
        worktree: { available: false, reason: "Requires git repository" },
        ssh: { available: false, reason: "Requires git repository" },
        docker: { available: false, reason: "Requires git repository" },
        devcontainer: { available: false, reason: "Requires git repository" },
      },
    });

    const view = renderApp({ apiClient: client });

    try {
      await view.waitForReady();
      await openProjectCreationView(view, projectPath);

      // Wait for the git init banner to confirm the project is treated as non-git
      await waitFor(
        () => {
          const banner = view.container.querySelector('[data-testid="git-init-banner"]');
          if (!banner) {
            throw new Error("Git init banner not found");
          }
        },
        { timeout: 5_000 }
      );

      // Local should be forced when repo is not a git repository.
      await waitFor(
        () => {
          // Without isolation the chip names the shared directory instead of "None".
          const summary = view.container.querySelector(
            '[data-component="WorkspaceIsolationSummary"]'
          );
          if (!summary?.textContent?.includes("Project directory")) {
            throw new Error("No workspace isolation not selected for non-git repo");
          }
        },
        { timeout: 2_000 }
      );

      await openCreationEnvironment(view.container);

      const dockerOption = await waitFor(
        () => {
          const option = findCreationIsolationOption("Workspace isolation", "Docker");
          if (!option) {
            throw new Error("Docker option not found");
          }
          return option;
        },
        { timeout: 2_000 }
      );

      expect(dockerOption.getAttribute("aria-disabled")).toBe("true");
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});
