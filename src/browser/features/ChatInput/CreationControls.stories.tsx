import { useState, type ComponentProps, type ReactNode, useEffect, useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { APIProvider } from "@/browser/contexts/API";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { WorkspaceProvider } from "@/browser/contexts/WorkspaceContext";
import type { WorkspaceNameState } from "@/browser/hooks/useWorkspaceName";
import { lightweightMeta, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import {
  mockCoderInfoAvailable,
  mockCoderInfoMissing,
  mockCoderInfoOutdated,
} from "@/browser/stories/mocks/coder";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import {
  RUNTIME_MODE,
  type ParsedRuntime,
  type RuntimeAvailabilityStatus,
} from "@/common/types/runtime";
import type { CoderInfo } from "@/common/orpc/schemas/coder";
import { CreationControls } from "./CreationControls";
import type { RuntimeAvailabilityState } from "./useCreationWorkspace";
import {
  SettingsSectionStory,
  setupSettingsStory,
} from "../Settings/Sections/settingsStoryUtils.js";

const BASE_RUNTIME_AVAILABILITY = {
  local: { available: true },
  worktree: { available: true },
  ssh: { available: true },
  docker: { available: true },
} as const;

function getLoadedRuntimeAvailability(
  devcontainer: RuntimeAvailabilityStatus
): RuntimeAvailabilityState {
  return {
    status: "loaded",
    data: {
      ...BASE_RUNTIME_AVAILABILITY,
      devcontainer,
    },
  };
}

const DEVCONTAINER_UNAVAILABLE = getLoadedRuntimeAvailability({
  available: false,
  reason: "devcontainer CLI not found. Install from https://containers.dev/",
});

const DEVCONTAINER_SINGLE_CONFIG = getLoadedRuntimeAvailability({
  available: true,
  cliVersion: "0.81.1",
  configs: [
    {
      path: ".devcontainer/devcontainer.json",
      label: "Default (.devcontainer/devcontainer.json)",
    },
  ],
});

const DEVCONTAINER_MULTI_CONFIG = getLoadedRuntimeAvailability({
  available: true,
  cliVersion: "0.81.1",
  configs: [
    {
      path: ".devcontainer/devcontainer.json",
      label: "Default (.devcontainer/devcontainer.json)",
    },
    {
      path: ".devcontainer/backend/devcontainer.json",
      label: "Backend (.devcontainer/backend/devcontainer.json)",
    },
    {
      path: ".devcontainer/frontend/devcontainer.json",
      label: "Frontend (.devcontainer/frontend/devcontainer.json)",
    },
  ],
});

type CreationControlsProps = ComponentProps<typeof CreationControls>;

const DEVCONTAINER_BASE_CREATION_CONTROLS_PROPS: Omit<
  CreationControlsProps,
  "selectedRuntime" | "onSelectedRuntimeChange" | "runtimeAvailabilityState"
> = {
  branches: ["main", "develop"],
  branchLoad: "loaded",
  trunkBranch: "main",
  onTrunkBranchChange: fn(),
  coderConfigFallback: {},
  sshHostFallback: "devbox.internal",
  disabled: false,
  projectPath: "/home/user/projects/my-app",
  userProjects: new Map(),
  onSelectedProjectPathChange: fn(),
  projectSelectDisabled: false,
  projectName: "my-app",
  nameState: {
    name: "devcontainer-story",
    title: "Devcontainer Story",
    isGenerating: false,
    autoGenerate: true,
    error: null,
    setAutoGenerate: fn(),
    setName: fn(),
  },
};

function DevcontainerCreationControlsStory(props: {
  runtimeAvailabilityState: RuntimeAvailabilityState;
}) {
  const [selectedRuntime, setSelectedRuntime] = useState<ParsedRuntime>({
    mode: "devcontainer",
    configPath: "",
  });

  return (
    <SettingsSectionStory setup={() => setupSettingsStory({})}>
      <div className="bg-background p-6">
        <div className="max-w-3xl">
          <CreationControls
            {...DEVCONTAINER_BASE_CREATION_CONTROLS_PROPS}
            selectedRuntime={selectedRuntime}
            onSelectedRuntimeChange={setSelectedRuntime}
            runtimeAvailabilityState={props.runtimeAvailabilityState}
          />
        </div>
      </div>
    </SettingsSectionStory>
  );
}

/** The project and workspace isolation selects, driven by a real selection state. */
function IsolationPickerStory(props: {
  runtimeAvailabilityState: RuntimeAvailabilityState;
  coderInfo?: CoderInfo | null;
  initialRuntime?: ParsedRuntime;
  /** Pins a phone-width container; the test-runner plays at desktop size (AGENTS.md). */
  phoneWidth?: boolean;
  /** The story's project is trusted (SSH+None directory trust is offered only then). */
  trustedProject?: boolean;
}) {
  const [selectedRuntime, setSelectedRuntime] = useState<ParsedRuntime>(
    props.initialRuntime ?? { mode: RUNTIME_MODE.WORKTREE }
  );

  return (
    <SettingsSectionStory setup={() => setupSettingsStory({})}>
      <div className={props.phoneWidth ? "bg-background p-2" : "bg-background p-6"}>
        <div
          className={props.phoneWidth ? "w-[375px]" : "max-w-3xl"}
          data-testid="isolation-picker-frame"
        >
          <CreationControls
            {...DEVCONTAINER_BASE_CREATION_CONTROLS_PROPS}
            selectedRuntime={selectedRuntime}
            onSelectedRuntimeChange={setSelectedRuntime}
            runtimeAvailabilityState={props.runtimeAvailabilityState}
            coderInfo={props.coderInfo}
            userProjects={
              props.trustedProject
                ? new Map([
                    [
                      DEVCONTAINER_BASE_CREATION_CONTROLS_PROPS.projectPath,
                      { workspaces: [], trusted: true },
                    ],
                  ])
                : DEVCONTAINER_BASE_CREATION_CONTROLS_PROPS.userProjects
            }
          />
        </div>
      </div>
    </SettingsSectionStory>
  );
}

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Creation Controls",
  component: IsolationPickerStory,
  args: {
    runtimeAvailabilityState: getLoadedRuntimeAvailability({ available: true }),
  },
} satisfies Meta<typeof IsolationPickerStory>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Opens the environment panel from its chip. The panel is portaled, so its rows and fields are
 * queried on document.body.
 */
async function openEnvironmentPanel(storyRoot: HTMLElement): Promise<void> {
  const chip = await within(storyRoot).findByTestId("creation-environment", {}, { timeout: 10000 });
  if (chip.getAttribute("aria-expanded") !== "true") await userEvent.click(chip);
  await within(document.body).findByRole("radiogroup", { name: "Project isolation" });
}

/** Coder option is visible and selectable when Coder CLI is available. */
export const CoderAvailable: Story = {
  args: {
    coderInfo: mockCoderInfoAvailable,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    await openEnvironmentPanel(storyRoot);
    await within(document.body).findByRole("radio", { name: /^Coder/i }, { timeout: 10000 });
    await userEvent.keyboard("{Escape}");
  },
};

/** Coder option is hidden when Coder CLI is missing. */
export const CoderNotAvailable: Story = {
  // Its closed-menu snapshot is the same as CoderAvailable's; the play checks the behavior.
  parameters: { pixel: PIXEL_DISABLED },
  args: {
    coderInfo: mockCoderInfoMissing,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    await openEnvironmentPanel(storyRoot);
    await within(document.body).findByRole("radio", { name: /^SSH/i }, { timeout: 10000 });
    await expect(within(document.body).queryByRole("radio", { name: /^Coder/i })).toBeNull();
    await userEvent.keyboard("{Escape}");
  },
};

/** Coder option remains visible but disabled when CLI version is outdated. */
export const CoderOutdated: Story = {
  // Closed, the chip looks the same as CoderAvailable's; the play checks the disabled row. This
  // keeps the Pixel snapshot budget level now that EnvironmentPanelOpen snapshots the open panel.
  parameters: { pixel: PIXEL_DISABLED },
  args: {
    coderInfo: mockCoderInfoOutdated,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    await openEnvironmentPanel(storyRoot);
    const coderOption = await within(document.body).findByRole(
      "radio",
      { name: /^Coder/i },
      { timeout: 10000 }
    );

    await expect(coderOption).toHaveAttribute("aria-disabled", "true");
    await expect(coderOption).toHaveTextContent("2.20.0");
    await expect(coderOption).toHaveTextContent("2.25.0");
    await userEvent.keyboard("{Escape}");
  },
};

/** Dev container runtime unavailable (option remains visible but disabled). */
export const DevcontainerUnavailable: Story = {
  args: {
    runtimeAvailabilityState: DEVCONTAINER_UNAVAILABLE,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    await openEnvironmentPanel(storyRoot);

    const devcontainerOption = await within(document.body).findByRole("radio", {
      name: /^Dev container/i,
    });

    await expect(devcontainerOption).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");
  },
};

/**
 * SSH with no workspace isolation runs in an existing directory on the host. The containers have no
 * SSH backend yet, so they stay listed but disabled with the reason.
 */
export const SshWithoutIsolation: Story = {
  // On a phone the environment panel spans the viewport and its columns stack, so this story is
  // the phone snapshot of the creation controls, with the panel left open.
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  args: {
    phoneWidth: true,
    trustedProject: true,
    initialRuntime: {
      mode: "ssh",
      host: "devbox.internal",
      workspaceIsolation: "none",
      projectDir: "~/src/my-app",
    },
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);
    const body = within(document.body);

    // Narrow-layout contract: the chip and "Set as default" stay inside the phone-width frame.
    const frame = canvas.getByTestId("isolation-picker-frame").getBoundingClientRect();
    const chip = await canvas.findByTestId("creation-environment", {}, { timeout: 10000 });
    await expect(chip.getBoundingClientRect().right).toBeLessThanOrEqual(frame.right + 1);
    // Closed, the chip names the host and the shared directory, not "SSH" and "None".
    await expect(chip).toHaveTextContent("devbox.internal");
    await expect(chip).toHaveTextContent("~/src/my-app");
    const setDefault = canvas.getByRole("button", { name: "Set as default" });
    await expect(setDefault.getBoundingClientRect().right).toBeLessThanOrEqual(frame.right + 1);

    // The project is trusted but this host directory is not: its own trust is offered, on the
    // page (checked before the panel opens: the panel is modal and hides the page from queries).
    await expect(canvas.getByRole("button", { name: "Trust directory" })).toBeVisible();

    await openEnvironmentPanel(storyRoot);
    await expect(await body.findByLabelText("Project directory on host")).toHaveValue(
      "~/src/my-app"
    );
    await expect(body.getByLabelText("Host")).toHaveValue("devbox.internal");

    const dockerOption = await body.findByRole("radio", { name: /^Docker/i });
    await expect(dockerOption).toHaveAttribute("aria-disabled", "true");
    await expect(dockerOption).toHaveTextContent("Not yet supported on SSH projects");
  },
};

/**
 * The environment panel open on the default selection: where it runs, the isolation and the base
 * branch side by side, with the branch list filtered.
 */
export const EnvironmentPanelOpen: Story = {
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const body = within(document.body);

    await openEnvironmentPanel(storyRoot);
    const filter = await body.findByRole("combobox", { name: "Select source branch" });
    await userEvent.type(filter, "dev");
    // Filtering narrows the list to the match and keeps the selection.
    await expect(body.getByRole("option", { name: "develop" })).toBeVisible();
    await expect(body.queryByRole("option", { name: "main" })).toBeNull();
    await expect(within(storyRoot).getByTestId("creation-environment")).toHaveTextContent("main");
  },
};

/** Dev container runtime with a single config. */
export const DevcontainerSingleConfig: Story = {
  render: () => (
    <DevcontainerCreationControlsStory runtimeAvailabilityState={DEVCONTAINER_SINGLE_CONFIG} />
  ),
  play: async ({ canvasElement }) => {
    const body = within(document.body);

    // The config sits under the Dev container row of the environment panel.
    await openEnvironmentPanel(canvasElement);
    const configSelect = await body.findByRole("combobox", { name: "Dev container config" });
    await expect(configSelect).toBeEnabled();
    await expect(
      body.findByText("Default (.devcontainer/devcontainer.json)")
    ).resolves.toBeInTheDocument();
  },
};

/** Dev container runtime with multiple configs. */
export const DevcontainerMultiConfig: Story = {
  render: () => (
    <DevcontainerCreationControlsStory runtimeAvailabilityState={DEVCONTAINER_MULTI_CONFIG} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(document.body);

    await openEnvironmentPanel(canvasElement);
    const configSelect = await canvas.findByRole("combobox", { name: "Dev container config" });
    await userEvent.click(configSelect);

    const backendOption = await within(document.body).findByRole("option", {
      name: /Backend \(\.devcontainer\/backend\/devcontainer\.json\)/i,
    });
    await userEvent.click(backendOption);

    await expect(
      canvas.findByText("Backend (.devcontainer/backend/devcontainer.json)")
    ).resolves.toBeInTheDocument();
  },
};

const CREATION_PROJECT_PATH = "/Users/dev/my-project";

function CreationControlsStoryShell(props: { children: ReactNode }) {
  const workspaceStore = useWorkspaceStoreRaw();
  const client = useMemo(
    () =>
      createMockORPCClient({
        projects: new Map([[CREATION_PROJECT_PATH, { workspaces: [] }]]),
        workspaces: [],
      }),
    []
  );

  useEffect(() => {
    workspaceStore.setClient(client);
    // useProvidersConfig consumers read the shared store, which gets its
    // client from AppLoader in the real app — wire it manually here too.
    getProvidersConfigStore().setClient(client);
    return () => {
      workspaceStore.setClient(null);
      getProvidersConfigStore().setClient(null);
    };
  }, [client, workspaceStore]);

  return (
    <APIProvider client={client}>
      <RouterProvider>
        <ProjectProvider>
          <WorkspaceProvider>
            <SettingsProvider>{props.children}</SettingsProvider>
          </WorkspaceProvider>
        </ProjectProvider>
      </RouterProvider>
    </APIProvider>
  );
}

const BASE_CREATION_NAME_STATE: WorkspaceNameState = {
  name: "workspace-name",
  title: null,
  isGenerating: false,
  autoGenerate: true,
  error: null,
  setAutoGenerate: fn(),
  setName: fn(),
};

const CREATION_ERROR_BASE_CONTROLS_PROPS = {
  branches: ["main"],
  branchLoad: "loaded",
  trunkBranch: "main",
  onTrunkBranchChange: fn(),
  selectedRuntime: { mode: RUNTIME_MODE.WORKTREE },
  coderConfigFallback: {},
  sshHostFallback: "devbox",
  onSelectedRuntimeChange: fn(),
  disabled: false,
  projectPath: CREATION_PROJECT_PATH,
  userProjects: new Map(),
  onSelectedProjectPathChange: fn(),
  projectSelectDisabled: false,
  projectName: "my-project",
  runtimeAvailabilityState: getLoadedRuntimeAvailability({ available: true }),
  nameState: BASE_CREATION_NAME_STATE,
} satisfies CreationControlsProps;

function renderCreationControls(nameState: WorkspaceNameState) {
  return (
    <CreationControlsStoryShell>
      <div className="bg-background p-6">
        <div className="max-w-4xl">
          <CreationControls {...CREATION_ERROR_BASE_CONTROLS_PROPS} nameState={nameState} />
        </div>
      </div>
    </CreationControlsStoryShell>
  );
}

function createNameState(overrides: Partial<WorkspaceNameState>): WorkspaceNameState {
  return {
    ...BASE_CREATION_NAME_STATE,
    ...overrides,
  };
}

/** Name generation failure when provider blocks access for the current account scope. */
export const NameGenerationPermissionDenied: Story = {
  render: () =>
    renderCreationControls(
      createNameState({
        error: {
          kind: "generation",
          error: {
            type: "permission_denied",
            provider: "anthropic",
            raw: "Forbidden",
          },
        },
      })
    ),
};

/** Name generation failure when provider rate limits requests. */
export const NameGenerationRateLimited: Story = {
  render: () =>
    renderCreationControls(
      createNameState({
        error: {
          kind: "generation",
          error: {
            type: "rate_limit",
            raw: "Too many requests",
          },
        },
      })
    ),
};

/** Name generation failure when API credentials are invalid. */
export const NameGenerationAuthError: Story = {
  render: () =>
    renderCreationControls(
      createNameState({
        error: {
          kind: "generation",
          error: {
            type: "authentication",
            authKind: "invalid_credentials",
            provider: "openai",
            raw: "Invalid API key",
          },
        },
      })
    ),
};

export const NameValidationError: Story = {
  render: () =>
    renderCreationControls(
      createNameState({
        autoGenerate: false,
        name: "invalid name!",
        error: {
          kind: "validation",
          message:
            'Branch names can only contain lowercase letters, numbers, hyphens, underscores, and "/" separators',
        },
      })
    ),
};
