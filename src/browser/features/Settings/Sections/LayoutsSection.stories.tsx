import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "storybook/test";
import { LayoutsSection } from "./LayoutsSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/LayoutsSection",
  component: LayoutsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const LayoutsEmpty: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          layoutPresets: {
            version: 2,
            slots: [],
          },
        })
      }
    >
      <LayoutsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByRole("heading", { name: /layout slots/i });
    await canvas.findByText(/^Add layout$/i);

    if (canvas.queryByText(/Slot 1/i)) {
      throw new Error("Expected no slot rows to be rendered in the empty state");
    }
  },
};

export const LayoutsConfigured: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          layoutPresets: {
            version: 2,
            slots: [
              {
                slot: 1,
                preset: {
                  id: "preset-1",
                  name: "My Layout",
                  leftSidebarCollapsed: false,
                  rightSidebar: {
                    collapsed: false,
                    width: { mode: "px", value: 420 },
                    layout: {
                      version: 1,
                      nextId: 2,
                      focusedTabsetId: "tabset-1",
                      root: {
                        type: "tabset",
                        id: "tabset-1",
                        tabs: ["costs", "review", "terminal_new:t1"],
                        activeTab: "review",
                      },
                    },
                  },
                },
              },
              {
                slot: 10,
                preset: {
                  id: "preset-10",
                  name: "Extra Layout",
                  leftSidebarCollapsed: false,
                  rightSidebar: {
                    collapsed: true,
                    width: { mode: "px", value: 400 },
                    layout: {
                      version: 1,
                      nextId: 2,
                      focusedTabsetId: "tabset-1",
                      root: {
                        type: "tabset",
                        id: "tabset-1",
                        tabs: ["costs"],
                        activeTab: "costs",
                      },
                    },
                  },
                },
              },
            ],
          },
        })
      }
    >
      <LayoutsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByRole("heading", { name: /layout slots/i });

    await canvas.findByText(/My Layout/i);
    await canvas.findByText(/Extra Layout/i);
    await canvas.findByText(/^Slot 1$/i);
    await canvas.findByText(/^Slot 10$/i);
    await canvas.findByText(/^Add layout$/i);

    if (canvas.queryByText(/Slot 2/i)) {
      throw new Error("Expected only configured layouts to render");
    }
  },
};
