import { expect, fn, waitFor, within } from "@storybook/test";
import { PIXEL_DISABLED, appMeta, AppWithMocks, type AppStory } from "@/browser/stories/meta.js";
import { createGitStatusExecutor } from "@/browser/stories/helpers/git";
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
  title: "Components/BranchSelector",
};

const BRANCH = "feature/copy-branch";

function setupBranchWorkspace() {
  const workspace = createWorkspace({
    id: "branch-copy-1",
    name: BRANCH,
    projectName: "mux",
    createdAt: "2023-11-14T22:13:20.000Z",
  });
  const projects = groupWorkspacesByProject([workspace]);
  selectWorkspace(workspace);
  expandProjects([...projects.keys()]);
  collapseRightSidebar();
  collapseLeftSidebar();

  const gitStatusExecutor = createGitStatusExecutor();
  return createMockORPCClient({
    projects,
    workspaces: [workspace],
    // The copy button needs a resolved branch. GitStatusStore's passive status script reports
    // it under ---HEAD_BRANCH---, which the shared status fixture leaves out.
    executeBash: async (workspaceId: string, script: string) => {
      const result = await gitStatusExecutor(workspaceId, script);
      if (!script.includes("---HEAD_BRANCH---") || !result.success) return result;
      return { ...result, output: `---HEAD_BRANCH---\n${BRANCH}\n${result.output}` };
    },
  });
}

/**
 * The footer "Copy branch name" button is hover-revealed on mouse pointers. Touch users have no
 * hover, so it must be visible on coarse pointers, and a copy must show its check icon without
 * relying on hover or the tooltip.
 *
 * Neither Pixel nor the Storybook test-runner emulates touch, so the coarse-pointer assertion
 * only runs when the page really matches `(hover: none) and (pointer: coarse)` (for example a
 * Playwright context with `hasTouch` and `isMobile`). The copy confirmation is checked
 * everywhere: the click is dispatched without moving the pointer, so hover cannot reveal it.
 */
export const CopyBranchNameWithoutHover: AppStory = {
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  render: () => <AppWithMocks setup={setupBranchWorkspace} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole(
      "button",
      { name: "Copy branch name" },
      { timeout: 10_000 }
    );

    if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
      await expect(getComputedStyle(button).opacity).toBe("1");
    }

    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      button.click();
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(BRANCH));
      await waitFor(async () => {
        await expect(button.querySelector(".lucide-check")).not.toBeNull();
        await expect(getComputedStyle(button).opacity).toBe("1");
      });
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  },
};
