/**
 * The root page with no project (#5948, #5950): its empty-state line, the title bar's version, the
 * sidebar's "No projects" text and both "Add Project" buttons meet WCAG AA contrast in every
 * theme. Lighthouse measured the light theme's muted and secondary text at 2.9-3.8:1 before the
 * fixes.
 */

import { expect, within } from "@storybook/test";

import type { ThemeMode } from "@/browser/contexts/ThemeContext";
import { textContrast } from "@/browser/stories/helpers/contrast";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createMockORPCClient } from "./mocks/orpc";

export default {
  ...appMeta,
  title: "App/HomeEmptyState",
};

// Behavioral contract only, so Pixel snapshots are off. The screenshots on #5948's PR show the
// layout at phone and laptop widths.
const contractStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={() => createMockORPCClient()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const line = await canvas.findByText(
      "Select or add a project to get started.",
      {},
      { timeout: 15_000 }
    );
    const versionButton = await canvas.findByRole("button", { name: "Open about dialog" });
    const version = versionButton.querySelector<HTMLElement>("div.truncate");
    if (!version) throw new Error("version text not found in the title bar");
    const texts = [
      line,
      version,
      await canvas.findByText("No projects"),
      // The sidebar header's button (aria-label "Add project") and the empty state's button.
      ...(await canvas.findAllByRole("button", { name: /^\+?\s*Add project$/i })),
    ];
    // The two "Add Project" buttons and the three texts: a missing one would skip its check.
    await expect(texts).toHaveLength(5);
    for (const text of texts) {
      await expect(textContrast(text), `contrast of "${text.textContent}"`).toBeGreaterThanOrEqual(
        4.5
      );
    }
  },
});

export const Light = contractStory("light");
export const Dark = contractStory("dark");
export const FlexokiLight = contractStory("flexoki-light");
export const FlexokiDark = contractStory("flexoki-dark");
