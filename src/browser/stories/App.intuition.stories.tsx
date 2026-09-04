import type { ComponentType } from "react";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import type { IntuitionToolResult } from "@/common/types/tools";
import {
  EMPTY_INTUITION,
  INTUITION_CUE,
  RECOGNIZED_INTUITION,
  UNCERTAIN_INTUITION,
} from "@/browser/features/Tools/IntuitionToolCall.fixtures";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar } from "./helpers/uiState";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";

export default {
  ...appMeta,
  title: "App/MemoryIntuition",
};

function setupIntuitionStory(name: string, result?: IntuitionToolResult) {
  collapseLeftSidebar();
  return setupSimpleChatStory({
    workspaceId: `ws-intuition-${name}`,
    workspaceName: "memory-intuition",
    messages: [
      createUserMessage("intuition-user", "What should we remember before this database rollout?", {
        historySequence: 1,
      }),
      createAssistantMessage("intuition-assistant", "I'll check for relevant lessons first.", {
        historySequence: 2,
        toolCalls: [
          {
            type: "dynamic-tool",
            toolName: "intuition",
            toolCallId: "intuition-call",
            input: { cue: INTUITION_CUE },
            ...(result
              ? { state: "output-available", output: result }
              : { state: "input-available" }),
          },
        ],
      }),
    ],
  });
}

async function expandCard(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const header = await canvas.findByRole("button", { name: "Memory intuition details" });
  await waitFor(() => expect(header).toBeVisible());
  if (header.getAttribute("aria-expanded") !== "true") await userEvent.click(header);
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  return { canvas, header };
}

export const Pending: AppStory = {
  render: () => <AppWithMocks setup={() => setupIntuitionStory("pending")} />,
  play: async ({ canvasElement }) => {
    const { canvas } = await expandCard(canvasElement);
    await expect(canvas.getByText("Waiting for result")).toBeVisible();
    await expect(canvas.queryByText("no matches")).toBeNull();
  },
};

export const Recognized: AppStory = {
  render: () => (
    <AppWithMocks setup={() => setupIntuitionStory("recognized", RECOGNIZED_INTUITION)} />
  ),
  play: async ({ canvasElement }) => {
    const { canvas } = await expandCard(canvasElement);
    for (const memory of RECOGNIZED_INTUITION.memories) {
      await expect(canvas.getByText(memory.path)).toBeVisible();
      await expect(canvas.getByText(memory.excerpt, { normalizer: (text) => text })).toBeVisible();
    }
  },
};

export const Uncertain: AppStory = {
  render: () => (
    <AppWithMocks setup={() => setupIntuitionStory("uncertain", UNCERTAIN_INTUITION)} />
  ),
  play: async ({ canvasElement }) => {
    const { canvas } = await expandCard(canvasElement);
    await expect(canvas.getByText(UNCERTAIN_INTUITION.candidates[0].description)).toBeVisible();
    await expect(canvas.queryByText(RECOGNIZED_INTUITION.memories[0].excerpt)).toBeNull();
  },
};

export const Empty: AppStory = {
  render: () => <AppWithMocks setup={() => setupIntuitionStory("empty", EMPTY_INTUITION)} />,
  play: async ({ canvasElement }) => {
    const { canvas } = await expandCard(canvasElement);
    await expect(canvas.getByText("no matches")).toBeVisible();
    await expect(canvas.queryByText("Uncertain leads")).toBeNull();
  },
};

const limitResult = {
  kind: "limit_reached",
  message: "The per-turn recall limit has been reached. Use memory directly for further reads.",
} satisfies IntuitionToolResult;
export const LimitReached: AppStory = {
  render: () => <AppWithMocks setup={() => setupIntuitionStory("limit", limitResult)} />,
  play: async ({ canvasElement }) => {
    const { canvas } = await expandCard(canvasElement);
    await expect(canvas.getByText(limitResult.message)).toBeVisible();
    await expect(canvas.queryByText("no matches")).toBeNull();
  },
};

const errorResult = {
  kind: "error",
  isError: true,
  message: "Memory intuition was cancelled by the caller.",
} satisfies IntuitionToolResult;
export const Error: AppStory = {
  render: () => <AppWithMocks setup={() => setupIntuitionStory("error", errorResult)} />,
  play: async ({ canvasElement }) => {
    const { canvas } = await expandCard(canvasElement);
    await expect(canvas.getByText(errorResult.message)).toBeVisible();
    await expect(canvas.getByText("failed")).toBeVisible();
  },
};

function PhoneDecorator(Story: ComponentType) {
  // The runner ignores viewport globals; constrain the full app for breakpoint assertions too.
  return (
    <div style={{ width: 390, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

export const Phone: AppStory = {
  render: () => <AppWithMocks setup={() => setupIntuitionStory("phone", RECOGNIZED_INTUITION)} />,
  decorators: [PhoneDecorator],
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  play: async ({ canvasElement }) => {
    const { canvas, header } = await expandCard(canvasElement);
    await expect(header.getBoundingClientRect().width).toBeLessThan(390);
    await expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);
    const cue = canvas.getByText(INTUITION_CUE);
    await expect(cue.scrollWidth).toBeGreaterThan(cue.clientWidth);
    await expect(cue.clientWidth).toBeGreaterThan(0);
    const card = header.parentElement!;
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
    await expect(canvas.getByText(RECOGNIZED_INTUITION.memories[0].path)).toBeVisible();
  },
};
