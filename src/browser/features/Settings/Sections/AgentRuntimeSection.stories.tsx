import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { AgentRuntimeSection } from "./AgentRuntimeSection.js";
import { AgentSandboxSettings } from "./AgentSandboxSettings.js";
import {
  PhoneWidthDecorator,
  SettingsSectionStory,
  setupSettingsStory,
} from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/AgentRuntimeSection",
  component: AgentRuntimeSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentRuntime: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          agentResourceLimits: {
            enabled: true,
            limits: { cpuCores: 8, memoryGiB: 16 },
            projects: {},
            status: { state: "active", cgroup: "/xum/xum-agents" },
            support: { state: "ready", cgroup: "/xum" },
          },
          agentSandbox: {
            global: { enabled: true, network: "allowlist", allowedHosts: ["registry.npmjs.org"] },
            projects: {},
            support: { state: "supported" },
          },
        })
      }
    >
      <AgentRuntimeSection />
    </SettingsSectionStory>
  ),
  parameters: { pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByRole("heading", { name: /Resource limits/i });
    await canvas.findByRole("heading", { name: /Agent sandbox/i });
    await canvas.findByText(/Active: agents share 8 CPU cores and 16 GiB of memory/i);
    await waitFor(async () => {
      await expect(canvas.getByLabelText("CPU limit")).toHaveValue(8);
      await expect(canvas.getByLabelText("Memory limit")).toHaveValue(16);
    });

    const inputs = canvas.queryAllByRole("spinbutton");
    await expect(inputs).toEqual([
      canvas.getByLabelText("CPU limit"),
      canvas.getByLabelText("Memory limit"),
    ]);
  },
};

/** The agent sandbox section at phone width, with a project override and an edited host list. */
export const AgentSandboxPhone: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          agentSandbox: {
            global: { enabled: true, network: "allowlist", allowedHosts: ["registry.npmjs.org"] },
            projects: { "/home/user/projects/my-app": { enabled: false } },
            support: { state: "supported" },
          },
        })
      }
    >
      <AgentSandboxSettings />
    </SettingsSectionStory>
  ),
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { exclude: true } },
  decorators: [PhoneWidthDecorator],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const off = await canvas.findByRole("button", { name: "Off" });
    await waitFor(() => expect(off).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(canvas.getByRole("button", { name: "Global" }));
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Global" })).toHaveAttribute("aria-pressed", "true")
    );

    await userEvent.click(canvas.getByRole("button", { name: "Edit hosts" }));
    await canvas.findByLabelText("Allowed hosts, one per line");

    const frame = canvasElement.querySelector("[data-phone-frame]");
    if (!(frame instanceof HTMLElement)) throw new Error("Phone frame did not render");
    const frameRight = frame.getBoundingClientRect().right;
    for (const name of ["Off", "Use defaults", "Save hosts"]) {
      const button = canvas.getByRole("button", { name });
      await expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(frameRight + 1);
    }
  },
};
