import { useRef } from "react";
import type { FC, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "@storybook/test";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { APIClient } from "@/browser/contexts/API";
import { APIProvider } from "@/browser/contexts/API";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import assert from "@/common/utils/assert";

import { PlanFileDialog } from "./PlanFileDialog";

const PLAN_PREVIEW_WORKSPACE_ID = "ws-plan-preview";
const PLAN_PREVIEW_PATH = "/home/user/.mux/plans/my-app/ws-plan-preview.md";
const PLAN_PREVIEW_CONTENT = `# Plan preview modal story

- Show the preserved plan directly in the right sidebar flow.
- Keep open-in-editor as a secondary action.
- Verify markdown remains readable in a dialog.`;

const PlanStoryShell: FC<{ setup: () => APIClient; children: ReactNode }> = ({
  setup,
  children,
}) => {
  const clientRef = useRef<APIClient | null>(null);
  clientRef.current ??= setup();

  return (
    <ThemeProvider>
      <TooltipProvider>
        <APIProvider client={clientRef.current}>
          <ExperimentsProvider>{children}</ExperimentsProvider>
        </APIProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
};

function setupPlanPreviewClient(): APIClient {
  const client = createMockORPCClient();

  client.workspace.getPlanContent = (input) => {
    assert(input.workspaceId === PLAN_PREVIEW_WORKSPACE_ID, "Unexpected workspace in story mock");

    return Promise.resolve({
      success: true as const,
      data: {
        content: PLAN_PREVIEW_CONTENT,
        path: PLAN_PREVIEW_PATH,
      },
    });
  };

  return client;
}

const meta: Meta<typeof PlanFileDialog> = {
  title: "Features/RightSidebar/PlanFileDialog",
  component: PlanFileDialog,
  parameters: {
    layout: "fullscreen",
    pixel: {
      // Wide variant: these stories need >=1600px, so use the 1900px desktop viewport.
      matrix: { themes: ["dark", "light"], viewports: ["desktop"] },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 1600, height: "100dvh" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const PlanPreviewModal: Story = {
  render: () => (
    <PlanStoryShell setup={setupPlanPreviewClient}>
      <PlanFileDialog
        open={true}
        onOpenChange={() => {
          // No-op in Storybook; dialog remains open for visual regression snapshots.
        }}
        workspaceId={PLAN_PREVIEW_WORKSPACE_ID}
      />
    </PlanStoryShell>
  ),
  play: async () => {
    const body = within(document.body);

    await waitFor(() => {
      body.getByText("Plan preview modal story");
      body.getByText(PLAN_PREVIEW_PATH);
    });
  },
};
