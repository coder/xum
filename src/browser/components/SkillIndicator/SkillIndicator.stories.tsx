import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "storybook/test";
import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import { SkillIndicator } from "./SkillIndicator.js";

const SSH_TIMEOUT = "SSH connection to dev.example did not become healthy within 10000ms";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Components/SkillIndicator",
  component: SkillIndicator,
  args: {
    loadedSkills: [],
    availableSkills: [
      { name: "my-company-style", description: "Company-wide coding style", scope: "global" },
      { name: "init", description: "Bootstrap an AGENTS.md file", scope: "built-in" },
    ],
    unavailableSources: [
      { scope: "project", displayPath: "/home/coder/project/.xum/skills", message: SSH_TIMEOUT },
      { scope: "project", displayPath: "/home/coder/project/.agents/skills", message: SSH_TIMEOUT },
    ],
  },
  render: (args) => (
    <div className="bg-background flex min-h-[360px] items-start justify-end p-6">
      <SkillIndicator {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: /unavailable source/i })
    );
    await waitFor(() => within(document.body).getByText("Unavailable sources"));
  },
} satisfies Meta<typeof SkillIndicator>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The SSH host did not answer: global and built-in skills still list, project roots are named. */
export const UnavailableProjectSources: Story = {
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } } },
};

export const UnavailableProjectSourcesPhone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
};

const DISPLAY_NAME_ARGS = {
  availableSkills: [
    {
      name: "poteto-mode",
      displayName: "Poteto Mode",
      description: "Route work through the pstack skills",
      scope: "global" as const,
    },
    { name: "init", description: "Bootstrap an AGENTS.md file", scope: "built-in" as const },
  ],
  skillWarnings: [
    {
      directoryName: "poteto-mode",
      scope: "global" as const,
      displayPath: "/home/coder/.xum/skills/poteto-mode/SKILL.md",
      message:
        "SKILL.md name 'Poteto Mode' is not the directory name, so Xum loads the skill as 'poteto-mode'.",
      hint: "Invoke it as /poteto-mode. Set name: poteto-mode to remove this warning.",
    },
  ],
  unavailableSources: [],
};

const openSkillWarnings: Story["play"] = async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("button", { name: /1 warning/i }));
  await waitFor(() => within(document.body).getByText("Skill warnings"));
};

/** A SKILL.md `name` that is not the directory name loads as a display name with a warning. */
// Play-only (no Pixel capture): the snapshot budget is at its cap, and the plays check the
// warning and the badge state.
export const DisplayNameWarning: Story = {
  args: DISPLAY_NAME_ARGS,
  play: openSkillWarnings,
  parameters: { pixel: PIXEL_DISABLED },
};

export const DisplayNameWarningPhone: Story = {
  args: DISPLAY_NAME_ARGS,
  play: openSkillWarnings,
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { pixel: PIXEL_DISABLED },
};
