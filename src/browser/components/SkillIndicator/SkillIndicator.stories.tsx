import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
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
