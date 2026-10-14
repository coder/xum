/**
 * First-run onboarding wizard (#5944): the step indicator has an accessible name, and the
 * wizard's text meets WCAG AA contrast in every theme. Lighthouse scored the light theme's
 * muted text at 3.6-3.8:1 before the fix. The dark themes also check the step's accent links,
 * which use the text-only accent token since #5946.
 */

import { expect, waitFor, within } from "@storybook/test";

import type { ThemeMode } from "@/browser/contexts/ThemeContext";
import { textContrast } from "@/browser/stories/helpers/contrast";

import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createMockORPCClient } from "./mocks/orpc";

export default {
  ...appMeta,
  title: "App/OnboardingWizard",
};

/** A first run: no splash seen and no provider configured, so the wizard opens on its Gateway step. */
const renderFirstRun = () => (
  <AppWithMocks
    setup={() => createMockORPCClient({ viewedSplashScreens: [], providersConfig: {} })}
  />
);

async function expectAccessibleWizard(canvasElement: HTMLElement) {
  const body = within(canvasElement.ownerDocument.body);
  const dialog = within(await body.findByRole("dialog", {}, { timeout: 15_000 }));

  // Screen readers get the progress as one named image, not an unnamed div.
  const progress = await dialog.findByRole("img", { name: /^Step 1 of \d+$/ });
  await expect(progress).toBeVisible();

  const texts = [
    await dialog.findByText(/^1 \/ \d+$/),
    await dialog.findByText(/^OSS contributors with GitHub accounts/),
    await dialog.findByText(/^vouchers which you can/),
  ];
  await waitFor(async () => {
    for (const text of texts) {
      await expect(textContrast(text)).toBeGreaterThanOrEqual(4.5);
    }
  });
}

/**
 * The step's accent links reach 4.5:1 on the dialog. Dark themes only: the light accent text is a
 * separate token decision (#6449). Dark #0070cc was 3.36:1 here (#5946).
 */
async function expectReadableWizardLinks(canvasElement: HTMLElement) {
  const dialog = within(await within(canvasElement.ownerDocument.body).findByRole("dialog"));
  const links = [
    ...["Coder", "Discord", "claim here"].map((name) => dialog.getByRole("link", { name })),
    dialog.getByRole("button", { name: "Settings → Providers" }),
  ];
  const failing = links
    .map((link) => ({ name: link.textContent ?? "", ratio: textContrast(link) }))
    .filter((link) => link.ratio < 4.5)
    .map((link) => `${link.ratio.toFixed(2)}:1 "${link.name}"`);
  await expect(failing.join("\n")).toBe("");
}

// Behavioral contract only, so Pixel snapshots are off. The screenshots on #5944's PR show the
// layout at phone and laptop widths.
const contractStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  render: renderFirstRun,
  play: async ({ canvasElement }) => {
    await expectAccessibleWizard(canvasElement);
    if (theme === "dark" || theme === "flexoki-dark")
      await expectReadableWizardLinks(canvasElement);
  },
});

export const Light = contractStory("light");
export const Dark = contractStory("dark");
export const FlexokiLight = contractStory("flexoki-light");
export const FlexokiDark = contractStory("flexoki-dark");
