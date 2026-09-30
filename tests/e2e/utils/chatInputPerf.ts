import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  readReactProfileSnapshot,
  resetReactProfileSamples,
  withChromeProfiles,
  writePerfArtifacts,
} from "./perfProfile";

interface ProfileChatInputTypingOptions {
  page: Page;
  testInfo: TestInfo;
  runLabel: string;
  sample: string;
  input?: Locator;
  initialValue?: string;
  historyProfile?: unknown;
}

/**
 * Profiles real sequential typing in any rendered ChatInput and writes the
 * standard Chrome + React artifacts. Scenarios own setup and render-count
 * budgets so this can cover creation, workspace, scratch, and future variants.
 */
export async function profileChatInputTyping(options: ProfileChatInputTypingOptions) {
  const input =
    options.input ??
    options.page.getByRole("textbox", { name: /Message Claude|Edit your last message/ });
  const initialValue = options.initialValue ?? "";

  await expect(input).toBeVisible({ timeout: 20_000 });
  await expect(input).toHaveValue(initialValue);
  const profilerReset = await resetReactProfileSamples(options.page);
  expect(profilerReset).toBe(true);

  const chromeProfile = await withChromeProfiles(
    options.page,
    { label: options.runLabel },
    async () => {
      await input.click();
      await input.pressSequentially(options.sample, { delay: 0 });
      await expect(input).toHaveValue(`${initialValue}${options.sample}`);
    }
  );

  const reactProfile = await readReactProfileSnapshot(options.page);
  if (!reactProfile) {
    throw new Error("React profile snapshot was not captured");
  }

  const artifactDirectory = await writePerfArtifacts({
    testInfo: options.testInfo,
    runLabel: options.runLabel,
    chromeProfile,
    reactProfile,
    historyProfile: options.historyProfile ?? null,
  });
  options.testInfo.annotations.push({
    type: "perf-artifact",
    description: artifactDirectory,
  });

  return { chromeProfile, reactProfile, artifactDirectory };
}
