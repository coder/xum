import { expect, userEvent, waitFor, within } from "@storybook/test";
import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { PhoneSubagentReportDecorator } from "./helpers/subagentReportStory";
import { collapseLeftSidebar, collapseRightSidebar } from "./helpers/uiState";
import { createAssistantMessage } from "./mocks/messages";
import { createWorkspace, STABLE_TIMESTAMP } from "./mocks/workspaces";

const WORKSPACE_ID = "ws-agent-communication";
const REPORT_TITLE = "Preserving active-pointer crash recovery";
const REPORT =
  "One final generation-guard audit caught an edge not covered by existing tests: startup’s authoritative newer-handle selection must be allowed to replace a stale **active** child pointer, not only terminal pointers.\n\nI’m adding a compare-with-snapshotted previous execution ID permission only for startup reconciliation, plus a test for the old running status.";
const MESSAGE =
  "Focused follow-up before finalizing: verify the native canvas clipping behavior and the parent popup-blocked failure path.\n\nCheck handshake ordering in src/browser/features/Tools/SubagentTranscriptDialog.tsx and keep the change scoped to the existing behavior.";

function setupCommunicationStory(failed = false, longMessage = false) {
  // Separate transcript stores so switching stories cannot retain a successful delivery.
  const workspaceId = `${WORKSPACE_ID}-${failed ? "failed" : longMessage ? "long" : "sent"}`;
  collapseLeftSidebar();
  collapseRightSidebar();
  updatePersistedState(getAutoExpandPrefsKey(workspaceId), {});
  return setupSimpleChatStory({
    workspaceId,
    workspaceName: "agent-communication",
    projectName: "mux",
    messages: [
      createAssistantMessage("outgoing-updates", "", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP,
        toolCalls: [
          {
            type: "dynamic-tool",
            toolCallId: "outgoing-report",
            toolName: "agent_report",
            state: "output-available",
            input: { title: REPORT_TITLE, reportMarkdown: REPORT },
            output: failed
              ? { success: false, error: "The parent workspace is unavailable." }
              : { success: true },
          },
          {
            type: "dynamic-tool",
            toolCallId: "outgoing-message",
            toolName: "task_send_message",
            state: "output-available",
            input: {
              task_id: "b3947e259a",
              message: longMessage
                ? Array.from({ length: 200 }, (_, index) => `Check ${index + 1}: ${MESSAGE}`).join(
                    "\n\n"
                  )
                : MESSAGE,
            },
            output: failed
              ? {
                  status: "refused",
                  taskId: "b3947e259a",
                  reason: "This message is already queued.",
                }
              : { status: "reactivated", taskId: "b3947e259a" },
          },
        ],
      }),
    ],
    additionalWorkspaces: [
      createWorkspace({
        id: "b3947e259a",
        name: "reviewer",
        title: "Reviewer",
        projectName: "mux",
        parentWorkspaceId: workspaceId,
        taskStatus: "running",
      }),
    ],
  });
}

export default {
  ...appMeta,
  title: "App/AgentCommunication",
};

export const Outgoing: AppStory = {
  render: () => <AppWithMocks setup={setupCommunicationStory} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole("button", { name: "Message to Reviewer" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Prove keyboard collapse/expand as well as pointer interaction.
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard(" ");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  },
};

export const Phone: AppStory = {
  ...Outgoing,
  // Pin both the manager/Pixel viewport and the test-runner's otherwise desktop-width canvas.
  globals: { viewport: { value: "mobile1", isRotated: false } },
  decorators: [PhoneSubagentReportDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  play: async (context) => {
    await Outgoing.play?.(context);
    const cards = context.canvasElement.querySelectorAll(
      '[data-component="AgentCommunicationCard"]'
    );
    await expect(cards.length).toBe(2);
    for (const card of cards) {
      await expect(card.clientWidth).toBeLessThan(390);
      await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    }
  },
};

// Replayed kernel history has compact records, not the full streamed nestedCalls.
function setupCompactedCommunicationStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  return setupSimpleChatStory({
    workspaceId: "ws-compacted-agent-communication",
    workspaceName: "compacted-communication",
    projectName: "mux",
    messages: [
      createAssistantMessage("compacted-updates", "", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP,
        toolCalls: [
          {
            type: "dynamic-tool",
            toolCallId: "compacted-execution",
            toolName: "code_execution",
            state: "output-available",
            input: { code: "// Send agent updates" },
            output: {
              success: true,
              duration_ms: 2,
              consoleOutput: [],
              toolCalls: [
                {
                  toolName: "agent_report",
                  args: { title: REPORT_TITLE, reportMarkdown: REPORT },
                  ok: true,
                  bytes: 32,
                  duration_ms: 1,
                },
                {
                  toolName: "task_send_message",
                  args: { task_id: "b3947e259a", message: MESSAGE },
                  ok: true,
                  bytes: 64,
                  duration_ms: 1,
                },
              ],
            },
          },
        ],
      }),
    ],
  });
}

export const Compacted: AppStory = {
  render: () => <AppWithMocks setup={setupCompactedCommunicationStory} />,
  parameters: Outgoing.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole("button", { name: "Message to agent" });
    if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
    await expect(canvas.getByRole("region", { name: "Message content" })).toHaveTextContent(
      MESSAGE.replace(/\s+/g, " ")
    );
    const cards = canvasElement.querySelectorAll('[data-component="AgentCommunicationCard"]');
    await expect(cards).toHaveLength(2);
    for (const card of cards) {
      const status = within(card as HTMLElement).getByRole("status");
      await expect(status).not.toHaveClass("text-danger");
      await expect(status).not.toHaveClass("text-success");
      await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    }
  },
};

export const CompactedPhone: AppStory = {
  ...Compacted,
  globals: Phone.globals,
  decorators: Phone.decorators,
  parameters: Phone.parameters,
};

export const DeliveryFailures: AppStory = {
  render: () => <AppWithMocks setup={() => setupCommunicationStory(true)} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findAllByRole("alert")).toHaveLength(2);
    const toggle = canvas.getByRole("button", { name: REPORT_TITLE });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.getAllByRole("alert")).toHaveLength(2);
  },
};

export const LongMessage: AppStory = {
  ...Outgoing,
  render: () => <AppWithMocks setup={() => setupCommunicationStory(false, true)} />,
  play: async (context) => {
    await Outgoing.play?.(context);
    const content = within(context.canvasElement).getByRole("region", { name: "Message content" });
    await expect(content.scrollHeight).toBeGreaterThan(content.clientHeight);
    await expect(content.clientHeight).toBeLessThanOrEqual(window.innerHeight * 0.4 + 1);
    content.focus();
    await expect(content).toHaveFocus();
    content.scrollTo({ top: content.scrollHeight });
    await waitFor(() => expect(content.scrollTop).toBeGreaterThan(0));
    await expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth);
  },
};

export const LongMessagePhone: AppStory = {
  ...LongMessage,
  globals: Phone.globals,
  decorators: Phone.decorators,
  parameters: Phone.parameters,
};
