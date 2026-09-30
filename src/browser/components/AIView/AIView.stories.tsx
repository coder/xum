import type { AppStory } from "@/browser/stories/meta.js";
import { PIXEL_DUAL_THEME, appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { collapseLeftSidebar, selectWorkspace } from "@/browser/stories/helpers/uiState";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import {
  createIncompatibleWorkspace,
  createWorkspace,
  groupWorkspacesByProject,
} from "@/browser/stories/mocks/workspaces";

const meta = {
  ...appMeta,
  title: "Components/AIView",
};

export default meta;

// Integration: story renders full app with incompatible workspace to test AIView error state.
export const IncompatibleWorkspace: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-main", name: "main", projectName: "my-app" }),
          createIncompatibleWorkspace({
            id: "ws-incompatible",
            name: "incompatible",
            projectName: "my-app",
          }),
        ];

        selectWorkspace(workspaces[1]);
        collapseLeftSidebar();

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
};
