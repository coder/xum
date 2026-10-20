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
 *
 * RosettaBannerClearsToggle: with the sidebar collapsed, the fixed toggle bar sits over the top of
 * the main column, where platform warning banners render; the warning must start after it.
 *
 * CollapsedTitleBarDrags: on desktop the collapsed root page still drags the window across the
 * top strip, while the fixed toggle bar's button, which the page strip covers, stays clickable.
 */

import { expect, userEvent, waitFor, within } from "storybook/test";

import type { ThemeMode } from "@/browser/contexts/ThemeContext";
import { MAC_TRAFFIC_LIGHTS_INSET } from "@/browser/hooks/useDesktopTitlebar";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { ROSETTA_BANNER_DISMISSED_KEY } from "@/common/constants/storage";
import { textContrast } from "@/browser/stories/helpers/contrast";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { collapseLeftSidebar } from "./helpers/uiState";
import { windowDragsAt, withDesktopApi } from "./helpers/windowDrag";
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

// Collapsed before the app renders, so no hover or focus leaves the toggle's tooltip on screen.
const setupCollapsed = () => {
  collapseLeftSidebar();
  return createMockORPCClient();
};

const findCollapsedBar = async (canvasElement: HTMLElement) => {
  const toggle = await findToggle(canvasElement, "Open sidebar menu");
  const bar = toggle.closest<HTMLElement>("[data-testid='left-sidebar-toggle-bar']");
  if (!bar) throw new Error("left sidebar toggle bar not found");
  return bar;
};

export const RosettaBannerClearsToggle: AppStory = {
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  beforeEach: () => {
    updatePersistedState(ROSETTA_BANNER_DISMISSED_KEY, null);
    return withDesktopApi({ isRosetta: true })();
  },
  render: () => <AppWithMocks setup={setupCollapsed} />,
  play: async ({ canvasElement }) => {
    const bar = await findCollapsedBar(canvasElement);
    const warning = await within(canvasElement).findByText(/running under Rosetta/i);
    const icon = warning.parentElement?.querySelector("svg");
    if (!icon) throw new Error("Rosetta warning icon not found");
    await expect(icon.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      bar.getBoundingClientRect().right
    );
  },
};

export const CollapsedTitleBarDrags: AppStory = {
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  beforeEach: withDesktopApi({ isRosetta: false, getIsRosetta: () => Promise.resolve(false) }),
  render: () => <AppWithMocks setup={setupCollapsed} />,
  play: async ({ canvasElement }) => {
    const bar = await findCollapsedBar(canvasElement);
    const main = await within(canvasElement).findByRole("main");
    const mainRect = main.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    // Points across the top strip, from past the bar to the main column's right edge.
    const y = barRect.top + barRect.height / 2;
    for (const x of [barRect.right + 8, (barRect.right + mainRect.right) / 2, mainRect.right - 8]) {
      await expect(windowDragsAt(x, y), `drag region at x=${x}`).toBe(true);
    }
    const toggle = within(bar)
      .getByRole("button", { name: "Open sidebar menu" })
      .getBoundingClientRect();
    await expect(
      windowDragsAt(toggle.left + toggle.width / 2, toggle.top + toggle.height / 2),
      "Open sidebar menu button drags the window"
    ).toBe(false);
  },
};
