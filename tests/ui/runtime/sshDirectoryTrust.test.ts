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
import {
  cleanupView,
  openCreationEnvironment,
  openProjectCreationView,
  selectCreationIsolation,
} from "../helpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { expandProjects } from "@/browser/stories/helpers/uiState";
import type { ProjectConfig } from "@/common/types/project";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

type AppView = ReturnType<typeof renderApp>;

/**
 * The host and directory inputs are in the environment panel, which is portaled to document.body;
 * the trust row and "Set as default" stay on the page. Both are under the document body.
 */
const page = (): HTMLElement => document.body;

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
  await selectCreationIsolation(view.container, "Project isolation", "SSH");
  await selectCreationIsolation(view.container, "Workspace isolation", "None");

  const user = userEvent.setup({ document: page().ownerDocument });
  const hostInput = await waitFor(() => {
    const input = page().querySelector<HTMLInputElement>('input[placeholder="user@host"]');
    if (!input) throw new Error("SSH host input not found");
    return input;
  });
  await user.clear(hostInput);
  await user.type(hostInput, "devbox");
  const dirInput = page().querySelector<HTMLInputElement>(
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
        const { user } = await openSshNoneForm(view, projectPath, dir);
        await user.click(await findButtonEventually(page(), "Trust directory"));

        await findButtonEventually(page(), "Untrust");
        expect(page().textContent).toContain("Trusted directory");
        // The host-resolved path replaces ~ in the field, matching the stored trust entry. The
        // trust row is on the page, so clicking it closed the panel that holds the field.
        await openCreationEnvironment(view.container);
        const dirInput = page().querySelector<HTMLInputElement>(
          'input[aria-label="Project directory on host"]'
        );
        expect(dirInput?.value).toBe(dir.replace(/^~/, "/home/mock"));
      } finally {
        await cleanupView(view, cleanupDom);
      }
    },
    30_000
  );

  test("says the host is resolving a ~ path while the trust saves", async () => {
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
      await user.click(await findButtonEventually(page(), "Trust directory"));
      const pending = await findButtonEventually(page(), "Trusting…");
      expect(pending.disabled).toBe(true);
      expect(page().querySelector('[data-component="SshDirectoryTrust"]')?.textContent).toContain(
        "Resolving ~/app on devbox…"
      );

      release();
      await findButtonEventually(page(), "Untrust");
    } finally {
      release();
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("a ~ path trusted while the user switched away still shows trusted on return", async () => {
    const cleanupDom = installDom();
    const projectPath = "/Users/dev/ssh-trust-switch";
    expandProjects([projectPath]);
    const client = createMockORPCClient({ projects: trustedProject(projectPath), workspaces: [] });
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
      await user.click(await findButtonEventually(page(), "Trust directory"));
      await findButtonEventually(page(), "Trusting…");
      // Leave SSH x None while the host resolves ~, so the reply finds no field to update.
      await selectCreationIsolation(view.container, "Workspace isolation", "Worktree");
      release();
      await waitFor(() => {
        const saved = client.projects.list().then((list) => new Map(list).get(projectPath));
        return saved.then((cfg) => {
          if (!cfg?.trustedSshDirectories?.length) throw new Error("Trust not saved yet");
        });
      });

      await selectCreationIsolation(view.container, "Workspace isolation", "None");
      await findButtonEventually(page(), "Untrust");
      const dirInput = page().querySelector<HTMLInputElement>(
        'input[aria-label="Project directory on host"]'
      );
      expect(dirInput?.value).toBe("/home/mock/app");
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
      await user.click(await findButtonEventually(page(), "Set as default"));

      await waitFor(() => {
        const state = page().querySelector('[data-component="IsolationDefaultState"]');
        if (!state) throw new Error("Default state not shown");
      });
      const saved = new Map(await client.projects.list()).get(projectPath);
      expect(saved?.defaultIsolation).toEqual({ project: "ssh", workspace: "none" });
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("the Set as default shortcut saves the default from the keyboard", async () => {
    const cleanupDom = installDom();
    const projectPath = "/Users/dev/ssh-default-shortcut";
    expandProjects([projectPath]);
    const client = createMockORPCClient({ projects: trustedProject(projectPath), workspaces: [] });
    const view = renderApp({ apiClient: client });

    try {
      await openSshNoneForm(view, projectPath, "/srv/app");
      await findButtonEventually(page(), "Set as default");
      fireEvent.keyDown(window, {
        key: "D",
        code: "KeyD",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      });

      await waitFor(() => {
        const state = page().querySelector('[data-component="IsolationDefaultState"]');
        if (!state) throw new Error("Default state not shown");
      });
      const saved = new Map(await client.projects.list()).get(projectPath);
      expect(saved?.defaultIsolation).toEqual({ project: "ssh", workspace: "none" });
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});
