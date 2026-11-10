import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "storybook/test";
import { SecuritySection } from "./SecuritySection.js";
import { SettingsSectionStory, setupSecurityStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/SecuritySection",
  component: SecuritySection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const SecurityEmpty: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSecurityStory([])}>
      <SecuritySection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Project Trust/i);
    await canvas.findByText(/No projects added yet\./i);
  },
};

export const SecurityMixedTrust: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSecurityStory([
          { name: "my-app", path: "/Users/dev/my-app", trusted: true },
          { name: "untrusted-repo", path: "/Users/dev/untrusted-repo", trusted: false },
          { name: "another-project", path: "/Users/dev/another-project", trusted: true },
        ])
      }
    >
      <SecuritySection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Project Trust/i);
    await canvas.findByRole("button", { name: /^Trust untrusted-repo$/i });

    const revokeButtons = await canvas.findAllByRole("button", {
      name: /^Revoke trust for /i,
    });

    if (revokeButtons.length !== 2) {
      throw new Error(`Expected 2 Revoke trust buttons, got ${revokeButtons.length}`);
    }
  },
};

export const SecurityAllTrusted: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSecurityStory([
          { name: "my-app", path: "/Users/dev/my-app", trusted: true },
          { name: "payments-service", path: "/Users/dev/payments-service", trusted: true },
        ])
      }
    >
      <SecuritySection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Project Trust/i);
    const revokeButtons = await canvas.findAllByRole("button", {
      name: /^Revoke trust for /i,
    });

    if (revokeButtons.length === 0) {
      throw new Error("Expected at least one Revoke trust button");
    }

    if (canvas.queryByRole("button", { name: /^Trust /i })) {
      throw new Error("Expected no Trust buttons when all projects are trusted");
    }
  },
};

export const SecurityAllUntrusted: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSecurityStory([
          { name: "my-app", path: "/Users/dev/my-app", trusted: false },
          { name: "legacy-repo", path: "/Users/dev/legacy-repo", trusted: false },
        ])
      }
    >
      <SecuritySection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Project Trust/i);
    const trustButtons = await canvas.findAllByRole("button", { name: /^Trust /i });

    if (trustButtons.length === 0) {
      throw new Error("Expected at least one Trust button");
    }

    if (canvas.queryByRole("button", { name: /^Revoke trust for /i })) {
      throw new Error("Expected no Revoke trust buttons when all projects are untrusted");
    }
  },
};
