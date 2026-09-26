/**
 * UI integration tests for Docker runtime selection during workspace creation.
 *
 * These tests validate the creation controls without invoking real AI models:
 * - Docker runtime can be selected and exposes the image input
 * - Docker runtime is disabled for non-git projects (requires git)
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { shouldRunIntegrationTests } from "../../testUtils";
import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView, openProjectCreationView } from "../helpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { expandProjects } from "@/browser/stories/helpers/uiState";
import type { ProjectConfig } from "@/node/config";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/** Helper to create a project config for a path with no workspaces */
function projectWithNoWorkspaces(path: string): [string, ProjectConfig] {
  return [path, { workspaces: [] }];
}

function getWorkspaceTypeTrigger(container: HTMLElement): HTMLButtonElement | null {
  const group = container.querySelector(
    '[data-component="RuntimeTypeGroup"]'
  );
  if (!group) {
    return null;
  }

  return group.querySelector('button[aria-label="Workspace type"]');
}

function findRuntimeOption(label: string): HTMLElement | null {
  const options = Array.from(document.querySelectorAll('[role="option"]'));
  return options.find((option) => option.textContent?.includes(label)) ?? null;
}

async function selectRuntime(container: HTMLElement, label: string): Promise<void> {
  const trigger = getWorkspaceTypeTrigger(container);
  if (!trigger) {
    throw new Error("Workspace type trigger not found");
  }

  fireEvent.click(trigger);
  const option = await waitFor(
    () => {
      const candidate = findRuntimeOption(label);
      if (!candidate) {
        throw new Error(`Runtime option '${label}' not found`);
      }
      return candidate;
    },
    { timeout: 2_000 }
  );

  fireEvent.click(option);
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

      await selectRuntime(view.container, "Docker");

      // Verify Docker runtime becomes active in the workspace-type trigger.
      await waitFor(
        () => {
          const trigger = getWorkspaceTypeTrigger(view.container);
          if (!trigger) throw new Error("Workspace type trigger not found");
          if (!trigger.textContent?.includes("Docker")) {
            throw new Error("Docker runtime not selected");
          }
        },
        { timeout: 2_000 }
      );

      // Docker image input should appear
      const imageInput = await waitFor(
        () => {
          const input = view.container.querySelector(
            'input[placeholder="node:20"]'
          );
          if (!input) {
            throw new Error("Docker image input not found");
          }
          return input;
        },
        { timeout: 2_000 }
      );

      // SSH host input should NOT be visible
      const hostInput = view.container.querySelector('input[placeholder="user@host"]');
      expect(hostInput).toBeNull();

      const user = userEvent.setup({ document: view.container.ownerDocument });
      await user.clear(imageInput);
      await user.type(imageInput, "node:20");
      expect(imageInput.value).toBe("node:20");

      // Switching to SSH should hide Docker image input and show host input
      await selectRuntime(view.container, "SSH");

      await waitFor(
        () => {
          const input = view.container.querySelector(
            'input[placeholder="user@host"]'
          );
          if (!input) throw new Error("SSH host input not found");
        },
        { timeout: 2_000 }
      );

      const imageInputAfter = view.container.querySelector('input[placeholder="node:20"]');
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
          const trigger = getWorkspaceTypeTrigger(view.container);
          if (!trigger) throw new Error("Workspace type trigger not found");
          if (!trigger.textContent?.includes("Local")) {
            throw new Error("Local runtime not selected for non-git repo");
          }
        },
        { timeout: 2_000 }
      );

      const trigger = getWorkspaceTypeTrigger(view.container);
      expect(trigger).toBeTruthy();
      fireEvent.click(trigger!);

      const dockerOption = await waitFor(
        () => {
          const option = findRuntimeOption("Docker");
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
