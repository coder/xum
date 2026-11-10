import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "storybook/test";
import { useState } from "react";

import { lightweightMeta } from "@/browser/stories/meta.js";
import {
  mockCoderInfoOutdated,
  mockCoderParseError,
  mockCoderPresetsCoderOnCoder,
  mockCoderTemplates,
  mockCoderWorkspaces,
} from "@/browser/stories/mocks/coder";
import type { CoderInfo } from "@/common/orpc/schemas/coder";
import type { CoderWorkspaceConfig } from "@/common/types/runtime";

import {
  CoderAvailabilityMessage,
  CoderWorkspaceForm,
  type CoderWorkspaceFormProps,
} from "./CoderControls";

type CoderWorkspaceFormStoryProps = Omit<CoderWorkspaceFormProps, "onCoderConfigChange">;

interface CoderAvailabilityMessageStoryProps {
  coderInfo: CoderInfo | null;
}

const notLoggedInMessage = "Run `coder login <url>` first.";

const NEW_WORKSPACE_CONFIG: CoderWorkspaceConfig = {
  existingWorkspace: false,
  template: "coder-on-coder",
  templateOrg: "default",
};

const EXISTING_WORKSPACE_CONFIG: CoderWorkspaceConfig = {
  existingWorkspace: true,
  workspaceName: undefined,
};

const baseCoderWorkspaceFormProps: CoderWorkspaceFormStoryProps = {
  coderConfig: NEW_WORKSPACE_CONFIG,
  templates: mockCoderTemplates,
  templatesError: null,
  presets: mockCoderPresetsCoderOnCoder,
  presetsError: null,
  existingWorkspaces: mockCoderWorkspaces,
  workspacesError: null,
  loadingTemplates: false,
  loadingPresets: false,
  loadingWorkspaces: false,
  disabled: false,
  hasError: false,
};

function getCoderWorkspaceFormProps(
  overrides: Partial<CoderWorkspaceFormStoryProps> = {}
): CoderWorkspaceFormStoryProps {
  return {
    ...baseCoderWorkspaceFormProps,
    ...overrides,
  };
}

function CoderWorkspaceFormStory(props: CoderWorkspaceFormStoryProps) {
  const [coderConfig, setCoderConfig] = useState<CoderWorkspaceConfig | null>(
    () => props.coderConfig
  );

  return (
    <div className="bg-background flex min-h-screen items-start justify-center p-6">
      <CoderWorkspaceForm
        {...props}
        coderConfig={coderConfig}
        onCoderConfigChange={setCoderConfig}
      />
    </div>
  );
}

function CoderAvailabilityMessageStory(props: CoderAvailabilityMessageStoryProps) {
  return (
    <div className="bg-background flex min-h-screen items-start justify-center p-6">
      <CoderAvailabilityMessage coderInfo={props.coderInfo} />
    </div>
  );
}

const meta = {
  ...lightweightMeta,
  title: "Features/Runtime/CoderControls",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const NewWorkspace: Story = {
  render: () => <CoderWorkspaceFormStory {...getCoderWorkspaceFormProps()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByTestId("coder-controls-inner");
    await canvas.findByTestId("coder-template-select");
    await canvas.findByTestId("coder-preset-select");
  },
};

export const ExistingWorkspace: Story = {
  render: () => (
    <CoderWorkspaceFormStory
      {...getCoderWorkspaceFormProps({ coderConfig: EXISTING_WORKSPACE_CONFIG })}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByTestId("coder-workspace-select");
  },
};

export const TemplatesParseError: Story = {
  render: () => (
    <CoderWorkspaceFormStory
      {...getCoderWorkspaceFormProps({
        templates: [],
        templatesError: mockCoderParseError,
        presets: [],
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(mockCoderParseError);
    await waitFor(() => {
      const templateSelect = canvas.queryByTestId("coder-template-select");
      if (!templateSelect?.hasAttribute("data-disabled")) {
        throw new Error("Expected template select to be disabled when templates fail to parse");
      }
    });
  },
};

export const PresetsParseError: Story = {
  render: () => (
    <CoderWorkspaceFormStory
      {...getCoderWorkspaceFormProps({
        presets: [],
        presetsError: mockCoderParseError,
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(mockCoderParseError);
  },
};

export const ExistingWorkspaceParseError: Story = {
  render: () => (
    <CoderWorkspaceFormStory
      {...getCoderWorkspaceFormProps({
        coderConfig: EXISTING_WORKSPACE_CONFIG,
        existingWorkspaces: [],
        workspacesError: mockCoderParseError,
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(mockCoderParseError);
  },
};

export const NoPresets: Story = {
  render: () => (
    <CoderWorkspaceFormStory
      {...getCoderWorkspaceFormProps({
        templates: [mockCoderTemplates[0]],
        presets: [],
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(() => {
      const presetSelect = canvas.queryByTestId("coder-preset-select");
      if (!presetSelect?.hasAttribute("data-disabled")) {
        throw new Error("Expected preset select to be disabled when no presets are available");
      }
    });
  },
};

export const NoRunningWorkspaces: Story = {
  render: () => (
    <CoderWorkspaceFormStory
      {...getCoderWorkspaceFormProps({
        coderConfig: EXISTING_WORKSPACE_CONFIG,
        existingWorkspaces: [],
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(() => {
      const workspaceSelect = canvas.queryByTestId("coder-workspace-select");
      if (!workspaceSelect?.textContent?.includes("No workspaces found")) {
        throw new Error('Expected workspace select to show "No workspaces found"');
      }
    });
  },
};

export const WithLoginInfo: Story = {
  render: () => (
    <CoderWorkspaceFormStory
      {...getCoderWorkspaceFormProps({
        username: "coder-user",
        deploymentUrl: "https://coder.example.com",
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Logged in as/i);
    await canvas.findByText("coder-user");
    await canvas.findByText("https://coder.example.com");
  },
};

export const AvailabilityLoading: Story = {
  render: () => <CoderAvailabilityMessageStory coderInfo={null} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText("Checking…");
    await waitFor(() => {
      const spinner = canvasElement.querySelector(".animate-spin");
      if (!spinner) {
        throw new Error("Expected loading spinner while Coder availability is being checked");
      }
    });
  },
};

export const AvailabilityOutdated: Story = {
  render: () => <CoderAvailabilityMessageStory coderInfo={mockCoderInfoOutdated} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const warning = await canvas.findByText("Coder CLI 2.20.0 is below minimum v2.25.0.");
    await waitFor(() => {
      if (!warning.className.includes("text-yellow-500")) {
        throw new Error("Expected outdated availability message to use warning styling");
      }
    });
  },
};

export const AvailabilityUnavailableNotLoggedIn: Story = {
  render: () => (
    <CoderAvailabilityMessageStory
      coderInfo={{
        state: "unavailable",
        reason: {
          kind: "not-logged-in",
          message: notLoggedInMessage,
        },
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const warning = await canvas.findByText(notLoggedInMessage);
    await waitFor(() => {
      if (!warning.className.includes("text-yellow-500")) {
        throw new Error("Expected unavailable-not-logged-in message to use warning styling");
      }
    });
  },
};
