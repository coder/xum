/**
 * The root page with no project (#5948, #5950): its empty-state line, the title bar's version, the
 * sidebar's "No projects" text and both "Add Project" buttons meet WCAG AA contrast in every
 * theme. Lighthouse measured the light theme's muted and secondary text at 2.9-3.8:1 before the
 * fixes.
 *
 * KeyboardSidebarToggle: the app shell's toggle bar keeps one toggle for both sidebar states, so
 * Enter leaves focus on it.
 *
 * ToggleStaysPut: the bar sits outside the animated sidebar, so the toggle does not move while the
 * sidebar width animates.
 *
 * ToggleClearsWindowControls: the collapsed sidebar has no width, so the toggle is the only
 * pointer way back and must start after the inset reserved for the macOS traffic lights; the
 * title bar's content must start after the toggle.
 */

import { expect, userEvent, waitFor, within } from "storybook/test";

import type { ThemeMode } from "@/browser/contexts/ThemeContext";
import { MAC_TRAFFIC_LIGHTS_INSET } from "@/browser/hooks/useDesktopTitlebar";
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

const findToggle = async (canvasElement: HTMLElement, name: string) =>
  within(canvasElement).findByRole("button", { name }, { timeout: 15_000 });

export const KeyboardSidebarToggle: AppStory = {
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={() => createMockORPCClient()} />,
  play: async ({ canvasElement }) => {
    const toggle = await findToggle(canvasElement, "Collapse sidebar");
    toggle.focus();

    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(toggle).toHaveAccessibleName("Open sidebar menu"));
    await expect(document.activeElement).toBe(toggle);

    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(toggle).toHaveAccessibleName("Collapse sidebar"));
    await expect(document.activeElement).toBe(toggle);
  },
};

export const ToggleStaysPut: AppStory = {
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={() => createMockORPCClient()} />,
  play: async ({ canvasElement }) => {
    const toggle = await findToggle(canvasElement, "Collapse sidebar");
    const before = toggle.getBoundingClientRect();
    const sidebar = canvasElement.querySelector<HTMLElement>("[data-testid='left-sidebar']");
    if (!sidebar) throw new Error("left sidebar not found");
    const startWidth = sidebar.getBoundingClientRect().width;

    await userEvent.click(toggle);
    // Sample every frame until the width animation ends.
    const samples: Array<{ width: number; left: number; top: number }> = [];
    const deadline = performance.now() + 2_000;
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const rect = toggle.getBoundingClientRect();
      const width = sidebar.getBoundingClientRect().width;
      samples.push({ width, left: rect.left, top: rect.top });
      if (width === 0) break;
    }
    await expect(samples.at(-1)?.width).toBe(0);
    await expect(samples.some((sample) => sample.width > 0 && sample.width < startWidth)).toBe(
      true
    );
    for (const sample of samples) {
      await expect({ left: sample.left, top: sample.top }).toEqual({
        left: before.left,
        top: before.top,
      });
    }
  },
};

export const ToggleClearsWindowControls: AppStory = {
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={() => createMockORPCClient()} />,
  play: async ({ canvasElement }) => {
    // initTitlebarInsets() sets this on :root in Electron on macOS; the app inherits it from here.
    canvasElement.style.setProperty("--titlebar-left-inset", `${MAC_TRAFFIC_LIGHTS_INSET}px`);
    try {
      const toggle = await findToggle(canvasElement, "Collapse sidebar");
      const origin = canvasElement.getBoundingClientRect().left;
      await expect(toggle.getBoundingClientRect().left - origin).toBeGreaterThanOrEqual(
        MAC_TRAFFIC_LIGHTS_INSET
      );
      const version = await within(canvasElement).findByRole("button", {
        name: "Open about dialog",
      });
      await expect(version.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        toggle.getBoundingClientRect().right
      );

      await userEvent.click(toggle);
      await waitFor(() => expect(toggle).toHaveAccessibleName("Open sidebar menu"));
      await expect(toggle.getBoundingClientRect().left - origin).toBeGreaterThanOrEqual(
        MAC_TRAFFIC_LIGHTS_INSET
      );
    } finally {
      canvasElement.style.removeProperty("--titlebar-left-inset");
    }
  },
};
