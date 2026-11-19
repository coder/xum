import type { ComponentType } from "react";
import { expect, waitFor, within } from "storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AutoModelRoutingGroup } from "./AutoModelRoutingExperimentConfig.js";
import { ExperimentsSection } from "./ExperimentsSection.js";
import { MemoryConsolidationGroup } from "./MemorySection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ExperimentsSection",
  component: ExperimentsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Experiments: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          // Seed the parent off explicitly so the "sub-experiments hidden"
          // assertion does not rely on the experiment's default value.
          experiments: { [EXPERIMENT_IDS.MEMORY]: false },
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Memory sub-experiments are nested under Agent Memory, so with the parent
    // off they must not appear anywhere in the list.
    await canvas.findByLabelText("Toggle Agent Memory");
    await expect(canvas.queryByLabelText("Toggle Memory Consolidation")).toBeNull();
  },
};

export const MemorySettingsEnabled: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: {
            [EXPERIMENT_IDS.MEMORY]: true,
            [EXPERIMENT_IDS.MEMORY_CONSOLIDATION]: true,
          },
        })
      }
    >
      <ExperimentsSection />
      {/* The dream limits moved to Settings → Memory; shown here next to the switch they follow. */}
      <MemoryConsolidationGroup />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // With Agent Memory enabled, the sub-experiment toggles render in the
    // nested panel under the parent row.
    await canvas.findByLabelText("Toggle Memory Consolidation");
    // With consolidation on, the Memory group shows its dream cost ceiling, empty until set.
    await expect(await canvas.findByLabelText("Dream cost ceiling")).toHaveValue("");
    // The edit limit shows the default 8 until the user saves another.
    await expect(await canvas.findByLabelText("Dream edit limit")).toHaveValue("8");
    // The run timeout shows the default 5 minutes until the user saves another.
    await expect(await canvas.findByLabelText("Dream run timeout")).toHaveValue("5");
  },
};

export const ExperimentsToggleOn: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: { [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true },
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // With PTC enabled, the RLM Mode sub-experiment renders in the nested
    // panel under the parent row.
    await canvas.findByLabelText("Toggle RLM Mode");
  },
};

export const AutoModelRoutingEnabled: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: { [EXPERIMENT_IDS.AUTO_MODEL_ROUTING]: true },
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
            openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
          },
        })
      }
    >
      {/* The tier editor moved from under its Experiments row to Settings → Models. */}
      <AutoModelRoutingGroup />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The Auto routing group renders the evaluation model field, the default tier rows, and the
    // preview control.
    await canvas.findByLabelText("Evaluation model");
    await canvas.findByLabelText("Tier 4 description");
    await canvas.findByRole("button", { name: "Add tier" });
  },
};

// Pixel's named phone viewport width. The test-runner ignores viewport globals and plays at
// desktop size, so the decorator forces this width; the clamp keeps the narrower local
// `mobile1` viewport from clipping the frame.
const PHONE_VIEWPORT_WIDTH = 390;

function PhoneWidthDecorator(Story: ComponentType) {
  return (
    <div
      data-phone-frame
      style={{ width: `min(100vw, ${PHONE_VIEWPORT_WIDTH}px)`, overflow: "hidden" }}
    >
      <Story />
    </div>
  );
}

export const AutoModelRoutingEnabledPhone: Story = {
  ...AutoModelRoutingEnabled,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  decorators: [PhoneWidthDecorator],
  play: async ({ canvasElement, parameters, globals }) => {
    await expect(parameters).toMatchObject({ pixel: { matrix: { viewports: ["phone"] } } });
    await expect(globals).toMatchObject({ viewport: { value: "mobile1" } });

    const canvas = within(canvasElement);
    await canvas.findByLabelText("Tier 4 description");
    await canvas.findByRole("button", { name: "Add tier" });

    const frame = canvasElement.querySelector("[data-phone-frame]");
    const section = canvasElement.querySelector("[data-auto-model-routing-config]");
    if (!(frame instanceof HTMLElement) || !(section instanceof HTMLElement)) {
      throw new Error("Phone frame or routing section did not render");
    }
    const frameRight = frame.getBoundingClientRect().right;
    // Nothing in the routing panel may extend past the phone frame: inputs, selectors, and
    // the per-tier controls must all fit inside the narrow column.
    await waitFor(async () => {
      await expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
      for (const element of section.querySelectorAll<HTMLElement>("input, button, textarea")) {
        await expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(frameRight + 1);
      }
    });
  },
};

/**
 * Phone-width contract for the configure buttons: in a narrow section the button shows only its
 * section icon and stays inside the row. Pixel snapshots it at the phone viewport; the label
 * hides by container width, so the fixed 375px frame makes the play hold in the CI
 * test-runner too, which plays at desktop size (AGENTS.md).
 */
export const ConfigureButtonsPhoneWidth: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: {
            [EXPERIMENT_IDS.CONFIGURABLE_BIND_URL]: true,
            [EXPERIMENT_IDS.MEMORY]: true,
            [EXPERIMENT_IDS.MEMORY_CONSOLIDATION]: true,
          },
        })
      }
    >
      <div data-testid="phone-frame" style={{ width: 375, maxWidth: "100%" }}>
        <ExperimentsSection />
      </div>
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const frame = canvas.getByTestId("phone-frame").getBoundingClientRect();
    for (const name of ["Configure in Server access", "Configure in Memory"]) {
      const button = await canvas.findByRole("button", { name });
      // Icon only: the section name is the accessible name, not visible text.
      await expect(within(button).queryByText(/Server access|Memory/)).not.toBeVisible();
      await expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(frame.right);
    }
    const toggle = canvas.getByLabelText("Toggle Expose API server on LAN/VPN");
    await expect(toggle.getBoundingClientRect().right).toBeLessThanOrEqual(frame.right);
  },
};
