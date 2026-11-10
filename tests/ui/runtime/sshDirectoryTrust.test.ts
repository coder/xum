/**
 * UI integration tests for the creation page's SSH+None directory trust row and its
 * "Set as default" action.
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
import type { ProjectConfig } from "@/common/types/project";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

type IsolationAxis = "Project isolation" | "Workspace isolation";
type AppView = ReturnType<typeof renderApp>;

async function selectIsolation(container: HTMLElement, axis: IsolationAxis, label: string) {
  const trigger = await waitFor(
    () => {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${axis}"]`);
      if (!button) throw new Error(`${axis} trigger not found`);
      return button;
    },
    { timeout: 5_000 }
  );
  fireEvent.click(trigger);
  const option = await waitFor(() => {
    const match = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (candidate) => candidate.textContent?.startsWith(label)
    );
    if (!match) throw new Error(`Option '${label}' not found`);
    return match;
  });
  fireEvent.click(option);
}

function findButton(container: HTMLElement, name: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === name
    ) ?? null
  );
}

function findButtonEventually(container: HTMLElement, name: string) {
  return waitFor(() => {
    const button = findButton(container, name);
    if (!button) throw new Error(`${name} button not found`);
    return button;
  });
}

/** Opens the project's creation page on SSH x None with host "devbox" and the given directory. */
async function openSshNoneForm(view: AppView, projectPath: string, dir: string) {
  await view.waitForReady();
  await openProjectCreationView(view, projectPath);
  await selectIsolation(view.container, "Project isolation", "SSH");
  await selectIsolation(view.container, "Workspace isolation", "None");

  const user = userEvent.setup({ document: view.container.ownerDocument });
  const hostInput = await waitFor(() => {
    const input = view.container.querySelector<HTMLInputElement>('input[placeholder="user@host"]');
    if (!input) throw new Error("SSH host input not found");
    return input;
  });
  await user.clear(hostInput);
  await user.type(hostInput, "devbox");
  const dirInput = view.container.querySelector<HTMLInputElement>(
    'input[aria-label="Project directory on host"]'
  );
  if (!dirInput) throw new Error("Directory input not found");
  await user.clear(dirInput);
  await user.type(dirInput, dir);
  return { user, dirInput };
}

function trustedProject(projectPath: string): Map<string, ProjectConfig> {
  return new Map([[projectPath, { workspaces: [], trusted: true }]]);
}

describeIntegration("SSH+None directory trust (UI)", () => {
  test.each(["/srv/app", "~/app"])(
    "trusting %s shows the directory as trusted",
    async (dir) => {
      const cleanupDom = installDom();
      const projectPath = "/Users/dev/ssh-trust-project";
      expandProjects([projectPath]);
      const client = createMockORPCClient({
        projects: trustedProject(projectPath),
        workspaces: [],
      });
      const view = renderApp({ apiClient: client });

      try {
        const { user, dirInput } = await openSshNoneForm(view, projectPath, dir);
        await user.click(await findButtonEventually(view.container, "Trust directory"));

        await findButtonEventually(view.container, "Untrust");
        expect(view.container.textContent).toContain("Trusted directory");
        // The host-resolved path replaces ~ in the field, matching the stored trust entry.
        expect(dirInput.value).toBe(dir.replace(/^~/, "/home/mock"));
      } finally {
        await cleanupView(view, cleanupDom);
      }
    },
    30_000
  );

  test("shows that the host is being checked while a ~ path resolves", async () => {
    const cleanupDom = installDom();
    const projectPath = "/Users/dev/ssh-trust-slow";
    expandProjects([projectPath]);
    const client = createMockORPCClient({ projects: trustedProject(projectPath), workspaces: [] });
    // Hold the request open: resolving ~ over SSH takes seconds against a real host.
    const save = client.projects.setSshDirectoryTrust.bind(client.projects);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.projects.setSshDirectoryTrust = async (input) => {
      await held;
      return save(input);
    };
    const view = renderApp({ apiClient: client });

    try {
      const { user } = await openSshNoneForm(view, projectPath, "~/app");
      await user.click(await findButtonEventually(view.container, "Trust directory"));
      const pending = await findButtonEventually(view.container, "Checking devbox…");
      expect(pending.disabled).toBe(true);

      release();
      await findButtonEventually(view.container, "Untrust");
    } finally {
      release();
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("Set as default makes the shown isolation the project's default", async () => {
    const cleanupDom = installDom();
    const projectPath = "/Users/dev/ssh-default-project";
    expandProjects([projectPath]);
    const client = createMockORPCClient({ projects: trustedProject(projectPath), workspaces: [] });
    const view = renderApp({ apiClient: client });

    try {
      const { user } = await openSshNoneForm(view, projectPath, "/srv/app");
      await user.click(await findButtonEventually(view.container, "Set as default"));

      await waitFor(() => {
        const state = view.container.querySelector('[data-component="IsolationDefaultState"]');
        if (!state) throw new Error("Default state not shown");
      });
      const saved = new Map(await client.projects.list()).get(projectPath);
      expect(saved?.defaultIsolation).toEqual({ project: "ssh", workspace: "none" });
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});
