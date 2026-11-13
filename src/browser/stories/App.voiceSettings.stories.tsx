import { expect, userEvent, within } from "storybook/test";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { openSettingsDialog } from "./storyPlayHelpers";
import { expandLeftSidebar } from "./helpers/uiState";
import { setupSettingsStory } from "@/browser/features/Settings/Sections/settingsStoryUtils";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { VOICE_MODEL_KEY } from "@/common/constants/storage";

export default { ...appMeta, title: "App/VoiceSettings" };

function setup() {
  expandLeftSidebar();
  updatePersistedState(VOICE_MODEL_KEY, "openai");
  return setupSettingsStory({ providersConfig: {} });
}

async function exerciseSettings(canvasElement: HTMLElement) {
  const canvas = within(await openSettingsDialog(canvasElement));
  await userEvent.click(await canvas.findByRole("button", { name: "Voice" }));
  const local = await canvas.findByRole("group", { name: "On this device" });
  await expect(within(local).getByRole("radio", { name: /Parakeet TDT v3/ })).toBeDisabled();
  await expect(within(local).getByRole("radio", { name: /Parakeet TDT v2/ })).toBeDisabled();
  await expect(canvas.getByRole("radio", { name: /OpenAI Whisper/ })).toBeChecked();
  if (window.innerWidth < 768) {
    await expect(local.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(local.scrollWidth).toBeLessThanOrEqual(local.clientWidth);
  }
}

export const Desktop: AppStory = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark"], viewports: ["desktop"] } } },
  render: () => <AppWithMocks setup={setup} />,
  play: async ({ canvasElement }) => exerciseSettings(canvasElement),
};

export const Phone: AppStory = {
  ...Desktop,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark"], viewports: ["phone"] } } },
  play: async ({ canvasElement }) => exerciseSettings(canvasElement),
};
