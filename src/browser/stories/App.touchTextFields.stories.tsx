/**
 * Phone text fields (#5972): on touch phones, editable text is at least 16 px, because iOS Safari
 * zooms the page when a smaller field gets focus (documented WebKit behavior, not verified on a
 * device here).
 *
 * Neither Pixel nor the test-runner matches `pointer: coarse`, so the play reads the shipped rule
 * from CSSOM instead of the rendered size, like `coarsePointerMinHeight` in
 * App.phoneViewports.stories.tsx. It checks the media branches, which fields the selector matches,
 * the minimum's value, and that the composer's inline `max()` resolves once the variable is set.
 */

import { expect, userEvent, waitFor, within } from "@storybook/test";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { expandLeftSidebar, expandProjects } from "./helpers/uiState";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";

export default {
  ...appMeta,
  title: "App/TouchTextFields",
};

/** iOS Safari's focus-zoom threshold. */
const MIN_TEXT_ENTRY_FONT = "16px";
const MIN_VARIABLE = "--min-text-entry-font-size";
const PROJECT_PATH = "/home/user/projects/xum";

interface TouchRules {
  /** Media condition of the block that holds the field rule. */
  conditionText: string;
  /** Selector of the rule that sets `font-size: var(--min-text-entry-font-size)`. */
  fieldSelector: string;
  /** Value the same block gives the variable on `:root`. */
  minimum: string;
}

/** The coarse-pointer block that raises text fields, read from the shipped stylesheets. */
function findTouchTextFieldRules(): TouchRules | null {
  const visit = (rules: CSSRuleList): TouchRules | null => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes("pointer: coarse")) {
        let fieldSelector: string | null = null;
        let minimum = "";
        for (const inner of rule.cssRules) {
          if (!(inner instanceof CSSStyleRule)) continue;
          if (inner.style.fontSize === `var(${MIN_VARIABLE})`) fieldSelector = inner.selectorText;
          if (inner.selectorText === ":root") {
            minimum = inner.style.getPropertyValue(MIN_VARIABLE).trim() || minimum;
          }
        }
        if (fieldSelector !== null) {
          return { conditionText: rule.conditionText, fieldSelector, minimum };
        }
      }
      if (rule instanceof CSSGroupingRule) {
        const found = visit(rule.cssRules);
        if (found !== null) return found;
      }
    }
    return null;
  };
  for (const sheet of document.styleSheets) {
    const found = visit(sheet.cssRules);
    if (found !== null) return found;
  }
  return null;
}

async function findRendered<T>(find: () => T | null, what: string): Promise<T> {
  return waitFor(() => {
    const found = find();
    if (found === null) throw new Error(`${what} not rendered`);
    return found;
  });
}

const renderWorkspace = () => (
  <AppWithMocks
    setup={() => {
      const client = setupSimpleChatStory({
        workspaceId: "ws-touch-fields",
        workspaceName: "touch-fields",
        projectName: "xum",
        projectPath: PROJECT_PATH,
        messages: [
          createUserMessage("msg-1", "Hello", {
            historySequence: 1,
            timestamp: STABLE_TIMESTAMP - 60_000,
          }),
          createAssistantMessage("msg-2", "Hi.", {
            historySequence: 2,
            timestamp: STABLE_TIMESTAMP - 50_000,
          }),
        ],
      });
      expandLeftSidebar();
      expandProjects([PROJECT_PATH]);
      return client;
    }}
  />
);

/** Behavioral contract only, so Pixel snapshots are off. */
export const Contract: AppStory = {
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: renderWorkspace,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);

    // a. The rule lives in a coarse-pointer block that covers portrait and landscape phones.
    const rules = findTouchTextFieldRules();
    if (rules === null)
      throw new Error("No coarse-pointer rule sets var(--min-text-entry-font-size)");
    await expect(rules.conditionText).toMatch(/max-width:\s*768px/);
    await expect(rules.conditionText).toMatch(/orientation:\s*landscape/);
    await expect(rules.conditionText).toMatch(/max-height:\s*500px/);
    // c. The same block sets the minimum.
    await expect(rules.minimum).toBe(MIN_TEXT_ENTRY_FONT);

    // b. The selector covers the compact fields and skips the larger workspace-name field.
    const composer = await canvas.findByRole("textbox", { name: "Message" }, { timeout: 15_000 });
    await expect(composer.matches(rules.fieldSelector)).toBe(true);

    // d. The composer's inline size reads the variable: 13 px without it, 16 px with it.
    await expect(getComputedStyle(composer).fontSize).toBe("13px");
    const wrapper = composer.parentElement;
    if (!wrapper) throw new Error("Composer has no parent");
    wrapper.style.setProperty(MIN_VARIABLE, MIN_TEXT_ENTRY_FONT);
    try {
      await expect(getComputedStyle(composer).fontSize).toBe(MIN_TEXT_ENTRY_FONT);
    } finally {
      wrapper.style.removeProperty(MIN_VARIABLE);
    }
    await expect(getComputedStyle(composer).fontSize).toBe("13px");

    await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    const palette = await body.findByLabelText("Command palette");
    await expect(palette.matches(rules.fieldSelector)).toBe(true);
    await userEvent.keyboard("{Escape}");

    await userEvent.keyboard("{Control>},{/Control}");
    const settings = within(await body.findByRole("dialog", { name: "Settings" }));
    await userEvent.click(await settings.findByRole("button", { name: "Models" }));
    const filter = await settings.findByRole("textbox", { name: "Filter models" });
    await expect(filter.matches(rules.fieldSelector)).toBe(true);
    // The shared Input renders `<input>` with no type attribute when the caller passes none.
    await userEvent.click(await settings.findByRole("button", { name: "Backup" }));
    const repository = await settings.findByRole("textbox", { name: "Repository URL" });
    await expect(repository.hasAttribute("type")).toBe(false);
    await expect(repository.matches(rules.fieldSelector)).toBe(true);
    await userEvent.click(settings.getByRole("button", { name: "Close settings" }));

    await userEvent.click(await body.findByRole("button", { name: "Create workspace in xum" }));
    const workspaceName = await findRendered(
      () => canvasElement.querySelector('[data-component="WorkspaceNameInputBlock"] input'),
      "Workspace name input"
    );
    await expect(workspaceName.matches(rules.fieldSelector)).toBe(false);
  },
};
