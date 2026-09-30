import React from "react";
import { PIXEL_DUAL_THEME, appMeta, AppWithMocks, type AppStory } from "@/browser/stories/meta.js";
import {
  collapseLeftSidebar,
  collapseRightSidebar,
  expandProjects,
  selectWorkspace,
} from "@/browser/stories/helpers/uiState";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";

export default {
  ...appMeta,
  title: "Components/TitleBar",
};

// Integration: stories render full app to test TitleBar layout in context of sidebar + workspace content.

// ─────────────────────────────────────────────────────────────────────────────
// Shared workspace fixtures (2 projects, 4 workspaces)
// ─────────────────────────────────────────────────────────────────────────────

function createPopulatedClient() {
  // Keep createdAt deterministic so recency tie-breakers can't reorder sibling
  // workspaces between Storybook runs.
  const stableCreatedAt = "2023-11-14T22:13:20.000Z";
  const workspaces = [
    createWorkspace({
      id: "tb-1",
      name: "feature/dark-mode",
      projectName: "web-app",
      createdAt: stableCreatedAt,
    }),
    createWorkspace({
      id: "tb-2",
      name: "fix/nav-overflow",
      projectName: "web-app",
      createdAt: stableCreatedAt,
    }),
    createWorkspace({
      id: "tb-3",
      name: "main",
      projectName: "api-server",
      createdAt: stableCreatedAt,
    }),
    createWorkspace({
      id: "tb-4",
      name: "refactor/auth",
      projectName: "api-server",
      createdAt: stableCreatedAt,
    }),
  ];
  const projects = groupWorkspacesByProject(workspaces);

  selectWorkspace(workspaces[0]);
  expandProjects([...projects.keys()]);
  collapseRightSidebar();
  collapseLeftSidebar();

  return createMockORPCClient({ projects, workspaces });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * macOS desktop mode with traffic lights inset.
 * Logo is stacked above version to fit in constrained space.
 */
export const MacOSDesktop: AppStory = {
  decorators: [
    (Story) => {
      // Save and restore window.api to prevent leaking to other stories
      const originalApiRef = React.useRef(window.api);
      window.api = {
        platform: "darwin",
        versions: {
          node: "20.0.0",
          chrome: "120.0.0",
          electron: "28.0.0",
        },
        // This function's presence triggers isDesktopMode() → true
        getIsRosetta: () => Promise.resolve(false),
      };

      // Cleanup on unmount
      React.useEffect(() => {
        const savedApi = originalApiRef.current;
        return () => {
          window.api = savedApi;
        };
      }, []);

      return <Story />;
    },
  ],
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => <AppWithMocks setup={createPopulatedClient} />,
};

/**
 * Browser / web mode — no Electron API, standard title bar.
 * Uses the same populated workspace data as MacOSDesktop.
 */
export const BrowserMode: AppStory = {
  render: () => <AppWithMocks setup={createPopulatedClient} />,
};
