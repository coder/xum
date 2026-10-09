/**
 * The root page with no project selected (#5948): its empty-state line meets WCAG AA contrast in
 * every theme. Lighthouse measured the light theme's muted text at 3.8:1 before the fix.
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
    await expect(textContrast(line)).toBeGreaterThanOrEqual(4.5);
  },
});

export const Light = contractStory("light");
export const Dark = contractStory("dark");
export const FlexokiLight = contractStory("flexoki-light");
export const FlexokiDark = contractStory("flexoki-dark");
