import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import { selectWorkspace } from "@/browser/stories/helpers/uiState";
import type { Secret } from "@/common/types/secrets";
import { SecretsSection } from "./SecretsSection.js";
import { SettingsSectionStory } from "./settingsStoryUtils.js";

interface SecretsStoryOptions {
  globalSecrets?: Secret[];
  projectSecrets?: Map<string, Secret[]>;
}

function setupSecretsStory(options: SecretsStoryOptions = {}) {
  const projectPathA = "/Users/test/my-app";
  const projectPathB = "/Users/test/other-app";

  const workspaces = [
    createWorkspace({
      id: "ws-secrets-a",
      name: "main",
      projectName: "my-app",
      projectPath: projectPathA,
    }),
    createWorkspace({
      id: "ws-secrets-b",
      name: "main",
      projectName: "other-app",
      projectPath: projectPathB,
    }),
  ];

  selectWorkspace(workspaces[0]);

  return createMockORPCClient({
    workspaces,
    projects: groupWorkspacesByProject(workspaces),
    globalSecrets: options.globalSecrets ?? [{ key: "GLOBAL_TOKEN", value: "global-secret" }],
    projectSecrets:
      options.projectSecrets ??
      new Map<string, Secret[]>([
        [projectPathA, [{ key: "PROJECT_TOKEN", value: "project-secret" }]],
        [projectPathB, [{ key: "OTHER_TOKEN", value: "other-secret" }]],
      ]),
  });
}

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/SecretsSection",
  component: SecretsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

function renderSecretsSection(setup: () => ReturnType<typeof createMockORPCClient>) {
  return (
    <SettingsSectionStory setup={setup}>
      <div className="bg-background p-6">
        <SecretsSection />
      </div>
    </SettingsSectionStory>
  );
}

export const GlobalSecretsView: Story = {
  render: () => renderSecretsSection(() => setupSecretsStory()),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Secrets are stored in/i);
    await canvas.findByDisplayValue("GLOBAL_TOKEN");
  },
};

export const PopulatedGlobalSecrets: Story = {
  render: () =>
    renderSecretsSection(() =>
      setupSecretsStory({
        globalSecrets: [
          { key: "OPENAI_API_KEY", value: "sk-openai" },
          { key: "ANTHROPIC_API_KEY", value: "sk-anthropic" },
          { key: "GITHUB_TOKEN", value: "ghp_123" },
          { key: "SENTRY_AUTH_TOKEN", value: "sentry" },
        ],
      })
    ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByDisplayValue("OPENAI_API_KEY");
    await canvas.findByDisplayValue("ANTHROPIC_API_KEY");
    await canvas.findByDisplayValue("GITHUB_TOKEN");
    await canvas.findByDisplayValue("SENTRY_AUTH_TOKEN");
  },
};

export const ProjectSecrets: Story = {
  render: () => renderSecretsSection(() => setupSecretsStory()),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const projectScopeToggle = await canvas.findByRole("radio", { name: /^Project$/i });
    await userEvent.click(projectScopeToggle);

    await canvas.findByText(/Select a project to configure/i);
    await canvas.findByDisplayValue("PROJECT_TOKEN");
  },
};
