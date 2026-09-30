/**
 * Welcome/Empty state and workspace creation stories
 */

import { within, userEvent, waitFor, expect } from "@storybook/test";

import { expandProjects } from "@/browser/stories/helpers/uiState";
import { PIXEL_DUAL_THEME, appMeta, AppWithMocks, type AppStory } from "@/browser/stories/meta.js";
import { createMockORPCClient, type MockSessionUsage } from "@/browser/stories/mocks/orpc";
import { createArchivedWorkspace, NOW } from "@/browser/stories/mocks/workspaces";
import { LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";
import type { ProjectConfig } from "@/node/config";

// Integration: stories render full app to test ProjectPage workspace creation flows, git init banners, and provider configuration.
export default {
  ...appMeta,
  title: "Components/ProjectPage",
};

/** Helper to create session usage data with a specific total cost */
function createSessionUsage(cost: number): MockSessionUsage {
  // Distribute cost across components realistically
  const inputCost = cost * 0.55;
  const outputCost = cost * 0.25;
  const cachedCost = cost * 0.15;
  const reasoningCost = cost * 0.05;

  return {
    byModel: {
      "claude-sonnet-4-20250514": {
        input: { tokens: Math.round(inputCost * 2000), cost_usd: inputCost },
        cached: { tokens: Math.round(cachedCost * 2000), cost_usd: cachedCost },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: Math.round(outputCost * 500), cost_usd: outputCost },
        reasoning: { tokens: Math.round(reasoningCost * 1000), cost_usd: reasoningCost },
        model: "claude-sonnet-4-20250514",
      },
    },
    version: 1,
  };
}

async function openFirstProjectCreationView(storyRoot: HTMLElement): Promise<void> {
  // Navigate to the first project's creation page so creation/banner UI is visible.

  const projectRow = await waitFor(
    () => {
      // Guard: a previous story's play-function may have left the sidebar
      // collapsed via localStorage. Check the canonical data-attribute on
      // <html> (set by App.tsx) which works for both desktop (width-based)
      // and mobile (transform-based) collapse modes.
      if (document.documentElement.dataset.leftSidebarCollapsed === "true") {
        const expandBtn = storyRoot.querySelector<HTMLElement>("[aria-label='Expand sidebar']");
        if (expandBtn) expandBtn.click();
        throw new Error("Sidebar collapsed – expanding…");
      }

      const el = storyRoot.querySelector("[data-project-path][aria-controls]");
      if (!el) throw new Error("Project row not found");
      return el;
    },
    { timeout: 10_000 }
  );

  await userEvent.click(projectRow);
}

/** Helper to create a project config for a path with no workspaces */
function projectWithNoWorkspaces(path: string): [string, ProjectConfig] {
  return [path, { workspaces: [] }];
}

/**
 * Creation view - shown when a project exists but no workspace is selected
 */
export const CreateWorkspace: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openFirstProjectCreationView(storyRoot);
  },
};

/** Creation view with multiple projects - shows sidebar with projects */
export const CreateWorkspaceMultipleProjects: AppStory = {
  parameters: {
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["laptop", "phone"] },
    },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects([
          "/Users/dev/frontend-app",
          "/Users/dev/backend-api",
          "/Users/dev/mobile-client",
        ]);
        return createMockORPCClient({
          projects: new Map([
            projectWithNoWorkspaces("/Users/dev/frontend-app"),
            projectWithNoWorkspaces("/Users/dev/backend-api"),
            projectWithNoWorkspaces("/Users/dev/mobile-client"),
          ]),
          workspaces: [],
        });
      }}
    />
  ),
};

/**
 * Creation view with sub-projects configured.
 * Sub-projects are shown in the sidebar rather than in a creation-time section selector.
 *
 * Includes mobile snapshot variants: the sidebar starts expanded via
 * localStorage so the play function can click the project row, then
 * collapses it so the creation form is the main visible content.
 */
export const CreateWorkspaceWithSections: AppStory = {
  parameters: {
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["laptop", "phone"] },
    },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        // Ensure the sidebar starts expanded so the play function can click
        // the project row even in mobile viewport modes.
        localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(false));
        return createMockORPCClient({
          projects: new Map([
            ["/Users/dev/my-project", { workspaces: [] }],
            [
              "/Users/dev/my-project/frontend",
              {
                displayName: "Frontend",
                color: "#4f8cf7",
                parentProjectPath: "/Users/dev/my-project",
                workspaces: [],
              },
            ],
            [
              "/Users/dev/my-project/backend",
              {
                displayName: "Backend",
                color: "#f76b4f",
                parentProjectPath: "/Users/dev/my-project",
                workspaces: [],
              },
            ],
            [
              "/Users/dev/my-project/infra",
              {
                displayName: "Infra",
                color: "#8b5cf6",
                parentProjectPath: "/Users/dev/my-project",
                workspaces: [],
              },
            ],
          ]),
          workspaces: [],
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    // Wrap the entire interaction in try/finally so localStorage cleanup
    // runs even if navigation or assertions fail (prevents cross-story leaks).
    try {
      await openFirstProjectCreationView(storyRoot);

      // On mobile, handleAddWorkspace auto-collapses the sidebar after the
      // project click. On desktop it stays open — collapse it so the creation
      // form dominates the snapshot.
      const sidebar = storyRoot.querySelector<HTMLElement>("[data-testid='left-sidebar']");
      const sidebarIsExpanded = sidebar && sidebar.getBoundingClientRect().width > 40;
      if (sidebarIsExpanded) {
        const collapseBtn = sidebar.querySelector<HTMLElement>("[aria-label='Collapse sidebar']");
        if (collapseBtn) {
          await userEvent.click(collapseBtn);
        }
      }

      // The creation form should stay focused on workspace setup; sub-project selection
      // now happens by navigating to the nested project in the sidebar.
      await waitFor(
        () => {
          const workspaceNameGroup = storyRoot.querySelector(
            "[data-component='WorkspaceNameGroup']"
          );
          if (!workspaceNameGroup) {
            throw new Error("Workspace name header row not found");
          }
        },
        { timeout: 10000 }
      );
    } finally {
      // The sidebar collapse above writes to localStorage. Remove the key
      // so subsequent stories start with the default (expanded on desktop-
      // width viewports). Using finally ensures cleanup even on assertion
      // failure, preventing misleading cascading failures in later stories.
      localStorage.removeItem(LEFT_SIDEBAR_COLLAPSED_KEY);
    }
  },
};

/**
 * Non-git repository - shows git init banner prompting user to initialize git.
 * Banner is displayed above the ChatInput when the project directory is not a git repo.
 */
export const NonGitRepository: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/new-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/new-project")]),
          workspaces: [],
          // Return empty branches (indicates non-git repo)
          listBranches: () => Promise.resolve({ branches: [], recommendedTrunk: null }),
          // Mark non-local runtimes as unavailable for non-git repos
          // Dev container hidden (no config found) rather than disabled
          runtimeAvailability: {
            local: { available: true },
            worktree: { available: false, reason: "Requires git repository" },
            ssh: { available: false, reason: "Requires git repository" },
            docker: { available: false, reason: "Requires git repository" },
            devcontainer: { available: false, reason: "No devcontainer.json found" },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openFirstProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for the banner to appear and scroll into view
    const banner = await canvas.findByTestId("git-init-banner", {}, { timeout: 10000 });
    banner.scrollIntoView({ block: "center" });
  },
};

/**
 * Non-git repository success flow - demonstrates clicking "Run git init"
 * which shows a success message explaining Worktree and Remote are now available.
 */
export const NonGitRepositorySuccess: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/new-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/new-project")]),
          workspaces: [],
          // Always return empty branches so banner stays visible after success
          listBranches: () => Promise.resolve({ branches: [], recommendedTrunk: null }),
          // Mark non-local runtimes as unavailable for non-git repos
          // Dev container hidden (no config found) rather than disabled
          runtimeAvailability: {
            local: { available: true },
            worktree: { available: false, reason: "Requires git repository" },
            ssh: { available: false, reason: "Requires git repository" },
            docker: { available: false, reason: "Requires git repository" },
            devcontainer: { available: false, reason: "No devcontainer.json found" },
          },
          // Simulate git init success
          gitInit: () => Promise.resolve({ success: true as const }),
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openFirstProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for the banner to appear
    const banner = await canvas.findByTestId("git-init-banner", {}, { timeout: 10000 });
    banner.scrollIntoView({ block: "center" });

    // Click the git init button to trigger success flow
    const button = await canvas.findByTestId("git-init-button");
    await userEvent.click(button);

    // Wait for success message to appear
    await waitFor(() => {
      if (!canvas.queryByTestId("git-init-success")) {
        throw new Error("Success message not visible");
      }
    });
  },
};

/**
 * Non-git repository with in-progress state - demonstrates the loading UI
 * while git init is running.
 */
export const NonGitRepositoryInProgress: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/new-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/new-project")]),
          workspaces: [],
          listBranches: () => Promise.resolve({ branches: [], recommendedTrunk: null }),
          // Dev container hidden (no config found) rather than disabled
          runtimeAvailability: {
            local: { available: true },
            worktree: { available: false, reason: "Requires git repository" },
            ssh: { available: false, reason: "Requires git repository" },
            docker: { available: false, reason: "Requires git repository" },
            devcontainer: { available: false, reason: "No devcontainer.json found" },
          },
          // Never resolve - keeps in loading state
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          gitInit: () => new Promise(() => {}),
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openFirstProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for the banner to appear
    const banner = await canvas.findByTestId("git-init-banner", {}, { timeout: 10000 });
    banner.scrollIntoView({ block: "center" });

    // Click the button to trigger loading state
    const button = await canvas.findByTestId("git-init-button");
    await userEvent.click(button);

    // Verify loading state is shown
    await waitFor(() => {
      if (!canvas.queryByText("Running...")) {
        throw new Error("Loading state not visible");
      }
    });
  },
};

/**
 * Non-git repository with error state - demonstrates the error message
 * when git init fails.
 */
export const NonGitRepositoryError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/new-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/new-project")]),
          workspaces: [],
          listBranches: () => Promise.resolve({ branches: [], recommendedTrunk: null }),
          // Dev container hidden (no config found) rather than disabled
          runtimeAvailability: {
            local: { available: true },
            worktree: { available: false, reason: "Requires git repository" },
            ssh: { available: false, reason: "Requires git repository" },
            docker: { available: false, reason: "Requires git repository" },
            devcontainer: { available: false, reason: "No devcontainer.json found" },
          },
          // Return error
          gitInit: () =>
            Promise.resolve({
              success: false as const,
              error: "Permission denied: cannot write to /Users/dev/new-project",
            }),
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openFirstProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for the banner to appear
    const banner = await canvas.findByTestId("git-init-banner", {}, { timeout: 10000 });
    banner.scrollIntoView({ block: "center" });

    // Click the button to trigger error
    const button = await canvas.findByTestId("git-init-button");
    await userEvent.click(button);

    // Verify error message is shown
    await waitFor(() => {
      if (!canvas.queryByTestId("git-init-error")) {
        throw new Error("Error message not visible");
      }
    });
  },
};

/**
 * Docker unavailable - demonstrates the UI when Docker daemon is not running.
 * The Docker button should be greyed out with a tooltip explaining why.
 */
export const DockerUnavailable: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/new-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/new-project")]),
          workspaces: [],
          // Docker unavailable, but git repo exists
          // Dev container hidden (no config found) rather than disabled
          runtimeAvailability: {
            local: { available: true },
            worktree: { available: true },
            ssh: { available: true },
            docker: { available: false, reason: "Docker daemon not running" },
            devcontainer: { available: false, reason: "No devcontainer.json found" },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openFirstProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for workspace type buttons to appear
    await canvas.findByText("Workspace Type", {}, { timeout: 10000 });

    // Wait for Docker option to become disabled (runtimeAvailability loads async).
    await waitFor(async () => {
      const runtimeTrigger = canvas.getByLabelText("Workspace type");
      await userEvent.click(runtimeTrigger);

      const dockerOption = await within(document.body).findByRole("option", {
        name: /^Docker/i,
      });
      await expect(dockerOption).toHaveAttribute("aria-disabled", "true");

      await userEvent.keyboard("{Escape}");
    });
  },
};

/** Helper to generate archived workspaces with varied dates for timeline grouping */
function generateArchivedWorkspaces(projectPath: string, projectName: string) {
  const MINUTE = 60000;
  const HOUR = 3600000;
  const DAY = 86400000;

  const workspaces: Array<ReturnType<typeof createArchivedWorkspace>> = [];
  const sessionUsage = new Map<string, MockSessionUsage>();

  // Intentionally large set to exercise ProjectPage scrolling + bulk selection UX.
  // Keep timestamps deterministic (based on NOW constant).
  for (let i = 0; i < 34; i++) {
    const n = i + 1;

    // Mix timeframes:
    // - first ~6: today (minutes/hours)
    // - next ~8: last week
    // - next ~10: last month
    // - remaining: older (spans multiple month/year buckets)
    let archivedDeltaMs: number;
    if (n <= 3) {
      archivedDeltaMs = n * 15 * MINUTE;
    } else if (n <= 6) {
      archivedDeltaMs = n * 2 * HOUR;
    } else if (n <= 14) {
      archivedDeltaMs = n * DAY;
    } else if (n <= 24) {
      archivedDeltaMs = n * 3 * DAY;
    } else {
      // Older: jump further back to create multiple month/year group headers
      archivedDeltaMs = (n - 10) * 15 * DAY;
    }

    const kind = n % 6;
    const name =
      kind === 0
        ? `feature/batch-${n}`
        : kind === 1
          ? `bugfix/issue-${n}`
          : kind === 2
            ? `refactor/cleanup-${n}`
            : kind === 3
              ? `chore/deps-${n}`
              : kind === 4
                ? `feature/ui-${n}`
                : `bugfix/regression-${n}`;

    const id = `archived-${n}`;
    workspaces.push(
      createArchivedWorkspace({
        id,
        name,
        projectName,
        projectPath,
        archivedAt: new Date(NOW - archivedDeltaMs).toISOString(),
      })
    );

    // Generate varied costs: some cheap ($0.05-$0.50), some expensive ($1-$5)
    // Skip some workspaces to show missing cost data
    if (n % 4 !== 0) {
      const baseCost = n % 3 === 0 ? 1.5 + (n % 7) * 0.5 : 0.1 + (n % 5) * 0.08;
      sessionUsage.set(id, createSessionUsage(baseCost));
    }
  }

  return { workspaces, sessionUsage };
}

/**
 * Project page with archived workspaces - demonstrates:
 * - Timeline grouping (Today, Yesterday, This Week, etc.)
 * - Cost display per workspace, per time bucket, and total
 * - Search bar (visible with >3 workspaces)
 * - Bulk selection with checkboxes
 * - Select all checkbox
 * - Restore and delete actions
 */
export const ProjectPageWithArchivedWorkspaces: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        const { workspaces, sessionUsage } = generateArchivedWorkspaces(
          "/Users/dev/my-project",
          "my-project"
        );
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces,
          sessionUsage,
        });
      }}
    />
  ),
};

/**
 * No providers configured - shows the configure providers prompt.
 * This is displayed instead of ChatInput when the user hasn't set up any API keys.
 */
export const NoProvidersConfigured: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          // Empty providers config - no API keys set
          providersConfig: {},
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openFirstProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for the configure prompt to appear
    await canvas.findByTestId("configure-providers-prompt", {}, { timeout: 10000 });
  },
};

/**
 * Single provider configured - shows the provider bar with one icon and ChatInput.
 */
export const SingleProviderConfigured: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openFirstProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for the provider bar to appear (it contains "Providers" settings link)
    await waitFor(
      () => {
        if (!canvas.queryByText("Providers")) {
          throw new Error("Provider bar not visible");
        }
      },
      { timeout: 10000 }
    );
  },
};

/**
 * Multiple providers configured - shows the provider bar with multiple icons.
 */
export const MultipleProvidersConfigured: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        expandProjects(["/Users/dev/my-project"]);
        return createMockORPCClient({
          projects: new Map([projectWithNoWorkspaces("/Users/dev/my-project")]),
          workspaces: [],
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
            openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
            google: { apiKeySet: true, isEnabled: true, isConfigured: true },
            xai: { apiKeySet: true, isEnabled: true, isConfigured: true },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await openFirstProjectCreationView(storyRoot);
    const canvas = within(storyRoot);

    // Wait for the provider bar to appear
    await waitFor(
      () => {
        if (!canvas.queryByText("Providers")) {
          throw new Error("Provider bar not visible");
        }
      },
      { timeout: 10000 }
    );
  },
};
