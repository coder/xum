import { userEvent, waitFor } from "@storybook/test";

import { appMeta, AppWithMocks, type AppStory } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";

// Integration: stories render the full app so the sidebar's "New scratch chat"
// entry can navigate to the real scratch creation route.
export default {
  ...appMeta,
  title: "Components/ScratchPage",
};

/**
 * With multiple projects configured, the scratch header must show "Scratch"
 * as the current scope and offer the project switcher: on mobile the sidebar
 * auto-collapses after navigation and is otherwise the only way to reach a
 * project's creation page.
 */
export const ScratchCreationWithProjects: AppStory = {
  // Mirrors the Pixel phone variant so local viewing reproduces the mobile flow
  // the story covers; the test-runner ignores globals and plays at desktop width.
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["laptop", "phone"] },
    },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        // Start expanded so the play function can click the sidebar entry
        // even in mobile viewport modes.
        updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, false);
        return createMockORPCClient({
          projects: new Map([
            ["/Users/dev/frontend-app", { workspaces: [] }],
            ["/Users/dev/backend-api", { workspaces: [] }],
          ]),
          workspaces: [],
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    try {
      const newScratchButton = await waitFor(
        () => {
          // Guard: a previous story's play-function may have left the sidebar
          // collapsed via localStorage.
          if (document.documentElement.dataset.leftSidebarCollapsed === "true") {
            const expandBtn = storyRoot.querySelector<HTMLElement>("[aria-label='Expand sidebar']");
            if (expandBtn) expandBtn.click();
            throw new Error("Sidebar collapsed: expanding");
          }
          const el = storyRoot.querySelector<HTMLElement>("[aria-label='New scratch chat']");
          if (!el) throw new Error("New scratch chat button not found");
          return el;
        },
        { timeout: 10_000 }
      );
      await userEvent.click(newScratchButton);

      await waitFor(
        () => {
          const group = storyRoot.querySelector("[data-component='ScratchProjectGroup']");
          if (!group) throw new Error("Scratch project header not found");
          const selector = group.querySelector("[data-testid='project-selector']");
          if (!selector) throw new Error("Project switcher not found on scratch page");
          if (!(selector.textContent ?? "").includes("Scratch")) {
            throw new Error("Project switcher does not show the Scratch scope");
          }
        },
        { timeout: 10_000 }
      );
    } finally {
      // Remove the sidebar-state override so later stories start from the
      // default expanded-on-desktop state even if assertions fail.
      updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, null);
    }
  },
};
