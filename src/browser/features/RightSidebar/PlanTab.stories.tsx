import { useRef } from "react";
import type { FC, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "storybook/test";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { APIClient } from "@/browser/contexts/API";
import { APIProvider } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

import { PlanTab } from "./PlanTab";

const PLAN_WORKSPACE_ID = "ws-plan-tab";
const PLAN_PATH = "/home/user/.xum/plans/my-app/ws-plan-tab.md";
const PLAN_CONTENT = `# Plan tab story

## Goal

Show the workspace's plan next to the chat, with the plan card's main actions.

## Steps

1. Read the plan file through \`workspace.getPlanContent\`.
2. Re-read it when a turn ends or the window regains focus.
3. Keep **Implement**, **Edit** and **Copy** one click away.`;

const PlanStoryShell: FC<{ setup: () => APIClient; children: ReactNode }> = (props) => {
  const clientRef = useRef<APIClient | null>(null);
  clientRef.current ??= props.setup();

  return (
    <ThemeProvider>
      <TooltipProvider>
        <APIProvider client={clientRef.current}>{props.children}</APIProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
};

function setupClient(result: Awaited<ReturnType<APIClient["workspace"]["getPlanContent"]>>) {
  return (): APIClient => {
    const client = createMockORPCClient();
    client.workspace.getPlanContent = () => Promise.resolve(result);
    return client;
  };
}

const meta: Meta<typeof PlanTab> = {
  title: "Features/RightSidebar/PlanTab",
  component: PlanTab,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      // A right-sidebar pane's width.
      <div style={{ width: 360, height: 600 }} className="bg-background">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const WithPlan: Story = {
  render: () => (
    <PlanStoryShell
      setup={setupClient({ success: true, data: { content: PLAN_CONTENT, path: PLAN_PATH } })}
    >
      <PlanTab workspaceId={PLAN_WORKSPACE_ID} />
    </PlanStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      canvas.getByText("Plan tab story");
      canvas.getByText(PLAN_PATH);
    });
  },
};

export const NoPlanYet: Story = {
  render: () => (
    <PlanStoryShell
      setup={setupClient({ success: false, error: `Plan file not found at ${PLAN_PATH}` })}
    >
      <PlanTab workspaceId={PLAN_WORKSPACE_ID} />
    </PlanStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      canvas.getByText(/Switch to the Plan agent/);
    });
  },
};
