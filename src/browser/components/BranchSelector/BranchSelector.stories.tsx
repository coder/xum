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
 * The opacity a `pointer: coarse` media rule gives `el`, or null when no such rule matches it.
 * Walks nested rules too: Tailwind v4 emits arbitrary media variants as a media block nested in
 * the class's style rule, so the declarations can sit in a CSSNestedDeclarations child.
 */
function coarsePointerOpacity(el: Element): number | null {
  const visit = (rules: CSSRuleList, selector: string | null, inCoarse: boolean): number | null => {
    for (const rule of rules) {
      const ruleSelector = rule instanceof CSSStyleRule ? rule.selectorText : selector;
      const coarse =
        inCoarse ||
        (rule instanceof CSSMediaRule && rule.conditionText.includes("pointer: coarse"));
      const style =
        rule instanceof CSSStyleRule || rule instanceof CSSNestedDeclarations ? rule.style : null;
      if (coarse && ruleSelector && style?.opacity && el.matches(ruleSelector)) {
        const value = style.opacity.trim();
        return value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value);
      }
      if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) {
        const found = visit(rule.cssRules, ruleSelector, coarse);
        if (found !== null) return found;
      }
    }
    return null;
  };
  for (const sheet of document.styleSheets) {
    const found = visit(sheet.cssRules, null, false);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The footer "Copy branch name" button is hover-revealed on mouse pointers. Touch users have no
 * hover, so it must be visible on coarse pointers, and a copy must show its check icon without
 * relying on hover or the tooltip.
 *
 * Neither Pixel nor the Storybook test-runner emulates touch, so `pointer: coarse` never matches
 * here. Instead the play reads the loaded stylesheets and asserts that a coarse-pointer media rule
 * whose selector matches this button sets it to full opacity. Removing the class, or breaking its
 * media condition, fails the story. The copy confirmation is checked directly: the click is
 * dispatched without moving the pointer, so hover cannot reveal it.
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

    await expect(coarsePointerOpacity(button)).toBe(1);

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
