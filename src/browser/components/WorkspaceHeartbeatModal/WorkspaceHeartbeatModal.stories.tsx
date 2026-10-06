import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "@storybook/test";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
} from "@/browser/contexts/WorkspaceContext";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { HEARTBEAT_DEFAULT_INTERVAL_MS } from "@/constants/heartbeat";

import { WorkspaceHeartbeatModal } from "./WorkspaceHeartbeatModal";

const WORKSPACE_ID = "ws-heartbeat-layout";

const LONG_HEARTBEAT_MESSAGE = [
  "Recurring needs-triage reconcile for coder/agent-tty.",
  "Desired state: every open GitHub issue with `needs-triage` and without `triage:ongoing` / `triage:done` has exactly one triage workspace.",
  "Actual-state reads before side effects; archive stale duplicate workspaces; launch missing ones; report the workspace IDs and next blocking decision.",
].join(" ");

type HeartbeatSettings = NonNullable<FrontendWorkspaceMetadata["heartbeat"]>;

function createHeartbeatStoryApi(settings: HeartbeatSettings, configFails = false): APIClient {
  return {
    workspace: {
      heartbeat: {
        get: () => Promise.resolve(settings),
        set: () => Promise.resolve({ success: true, data: undefined }),
      },
    },
    config: {
      getConfig: () =>
        configFails
          ? Promise.reject(new Error("config unavailable"))
          : Promise.resolve({
              heartbeatDefaultIntervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
              heartbeatDefaultPrompt: "Review current progress and decide whether to continue.",
            }),
    },
  } as unknown as APIClient;
}

function createWorkspaceContextValue(): WorkspaceContextValue {
  return {
    workspaceMetadata: new Map<string, FrontendWorkspaceMetadata>(),
    loading: false,
    loaded: true,
    loadError: null,
    setWorkspaceMetadata: () => undefined,
  } as unknown as WorkspaceContextValue;
}

const enabledLongMessageSettings: HeartbeatSettings = {
  enabled: true,
  intervalMs: 7 * 60_000,
  contextMode: "compact",
  message: LONG_HEARTBEAT_MESSAGE,
};

const disabledLongMessageSettings: HeartbeatSettings = {
  ...enabledLongMessageSettings,
  enabled: false,
};

// Non-default schedule: fixed wall-clock cadence with an explicit when-busy queue mode, so the
// Trigger and When busy selects snapshot in their non-default states.
const fixedScheduleSettings: HeartbeatSettings = {
  ...enabledLongMessageSettings,
  contextMode: "normal",
  trigger: "interval",
  whenBusy: "tool-end",
};

function WorkspaceHeartbeatModalStoryShell(props: {
  children: ReactNode;
  settings: HeartbeatSettings;
  configFails?: boolean;
}) {
  return (
    <APIProvider client={createHeartbeatStoryApi(props.settings, props.configFails)}>
      <WorkspaceContext.Provider value={createWorkspaceContextValue()}>
        <div className="bg-background min-h-screen">{props.children}</div>
      </WorkspaceContext.Provider>
    </APIProvider>
  );
}

function renderOpenModal(
  settings: HeartbeatSettings = enabledLongMessageSettings,
  configFails = false
) {
  return (
    <WorkspaceHeartbeatModalStoryShell settings={settings} configFails={configFails}>
      <WorkspaceHeartbeatModal
        workspaceId={WORKSPACE_ID}
        open={true}
        onOpenChange={() => {
          // Keep the modal open for viewport snapshots.
        }}
      />
    </WorkspaceHeartbeatModalStoryShell>
  );
}

async function assertHeartbeatModalLoaded(canvasElement: HTMLElement): Promise<void> {
  const body = within(canvasElement.ownerDocument.body);
  const dialog = await body.findByRole("dialog", { name: "Configure heartbeat" });
  const modal = within(dialog);

  await waitFor(() => {
    const messageField = modal.getByLabelText("Heartbeat message");
    if (!(messageField instanceof HTMLTextAreaElement)) {
      throw new Error("Expected heartbeat message field to be a textarea");
    }
    if (messageField.value !== LONG_HEARTBEAT_MESSAGE) {
      throw new Error("Expected long heartbeat message to load before snapshotting");
    }
  });
}

const meta = {
  title: "Components/WorkspaceHeartbeatModal",
  component: WorkspaceHeartbeatModal,
  args: {
    workspaceId: WORKSPACE_ID,
    open: true,
    onOpenChange: () => undefined,
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof WorkspaceHeartbeatModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LongMessageDesktop: Story = {
  globals: {
    viewport: { value: "desktop", isRotated: false },
  },
  render: () => renderOpenModal(),
  play: async ({ canvasElement }) => {
    await assertHeartbeatModalLoaded(canvasElement);
  },
};

export const LongMessageMobile: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: { matrix: { viewports: ["phone"] } },
  },
  render: () => renderOpenModal(),
  play: async ({ canvasElement }) => {
    await assertHeartbeatModalLoaded(canvasElement);
  },
};

export const DisabledLongMessageDesktop: Story = {
  globals: {
    viewport: { value: "desktop", isRotated: false },
  },
  render: () => renderOpenModal(disabledLongMessageSettings),
  play: async ({ canvasElement }) => {
    await assertHeartbeatModalLoaded(canvasElement);
  },
};

export const FixedScheduleDesktop: Story = {
  globals: {
    viewport: { value: "desktop", isRotated: false },
  },
  render: () => renderOpenModal(fixedScheduleSettings),
  play: async ({ canvasElement }) => {
    await assertHeartbeatModalLoaded(canvasElement);

    // Contract: the non-default schedule loads into the new selects before snapshotting.
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: "Configure heartbeat" });
    const modal = within(dialog);
    await waitFor(() => {
      const triggerSelect = modal.getByLabelText("Heartbeat trigger");
      if (!(triggerSelect instanceof HTMLSelectElement) || triggerSelect.value !== "interval") {
        throw new Error("Expected fixed-schedule trigger to load before snapshotting");
      }
      const whenBusySelect = modal.getByLabelText("Heartbeat when busy");
      if (!(whenBusySelect instanceof HTMLSelectElement) || whenBusySelect.value !== "tool-end") {
        throw new Error("Expected explicit when-busy mode to load before snapshotting");
      }
    });
  },
};

export const DisabledLongMessageMobile: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: { matrix: { viewports: ["phone"] } },
  },
  render: () => renderOpenModal(disabledLongMessageSettings),
  play: async ({ canvasElement }) => {
    await assertHeartbeatModalLoaded(canvasElement);
  },
};

// The config read fails: the intro leaves out the global default sentence instead of stating the
// built-in default as if it were the configured one (#5704). The play pins that. The layout is
// the LongMessageDesktop one, so this story takes no Pixel snapshot (repo snapshot cap).
export const ConfigUnavailableDesktop: Story = {
  globals: {
    viewport: { value: "desktop", isRotated: false },
  },
  parameters: {
    pixel: PIXEL_DISABLED,
  },
  render: () => renderOpenModal(enabledLongMessageSettings, true),
  play: async ({ canvasElement }) => {
    await assertHeartbeatModalLoaded(canvasElement);
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Configure heartbeat",
    });
    const text = dialog.textContent ?? "";
    if (!text.includes("Valid range:")) {
      throw new Error("Expected the heartbeat intro to render");
    }
    if (text.includes("Workspaces without their own interval use")) {
      throw new Error("Expected no global default sentence when the config cannot load");
    }
  },
};
