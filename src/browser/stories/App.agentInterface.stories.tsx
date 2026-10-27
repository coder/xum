/**
 * Agent interface view (artifacts-agent-interface): a workspace with a status page shows the
 * Status / Chat toggle in the menu bar. TouchToggle is play-only; on Chromium the test-runner
 * (.storybook/test-runner.ts) emulates a touch phone and checks the toggle's tap targets, because
 * Pixel and plays cannot emulate a coarse pointer. StatusBarMidTurn and its phone variant show the
 * host's status bar above the page during a turn that runs a tool, with the transcript peek open.
 */
import { expect, waitFor, within } from "storybook/test";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  AGENT_INTERFACE_TRANSCRIPT_PEEK_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
} from "@/common/constants/storage";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

import { setupSimpleChatStory } from "./helpers/chatSetup";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./storyTime";

export default {
  ...appMeta,
  title: "App/AgentInterface",
};

const STATUS_HTML = `<!doctype html><html><body><h1>Release status</h1><p>Canary at 25%.</p></body></html>`;

const STATUS_PAGE: ArtifactReadResult = {
  status: "ok",
  path: AGENT_INTERFACE_STATUS_ARTIFACT,
  kind: "html",
  size: STATUS_HTML.length,
  modifiedMs: 1,
  encoding: "utf8",
  content: STATUS_HTML,
};

function setup(
  options: {
    workspaceId?: string;
    onChat?: (workspaceId: string, emit: (message: WorkspaceChatMessage) => void) => void;
  } = {}
) {
  const client = setupSimpleChatStory({
    workspaceId: options.workspaceId ?? "ws-agent-interface",
    workspaceName: "release",
    projectName: "xum",
    experiments: {
      [EXPERIMENT_IDS.ARTIFACTS]: true,
      [EXPERIMENT_IDS.ARTIFACTS_AGENT_INTERFACE]: true,
    },
    messages: [
      createUserMessage("u1", "Roll out the canary.", { historySequence: 1 }),
      createAssistantMessage("a1", "Canary is at 25%. The status page tracks it.", {
        historySequence: 2,
      }),
    ],
    onChat: options.onChat,
  });
  // A collapsed left sidebar drops the header's left padding, so on a phone the actions row,
  // which the toggle starts, reaches the screen edge.
  updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, true);
  client.artifacts = {
    ...client.artifacts,
    list: () =>
      Promise.resolve({
        success: true as const,
        data: {
          available: true as const,
          dir: "/scratch/artifacts",
          entries: [
            {
              path: STATUS_PAGE.path,
              kind: STATUS_PAGE.kind,
              size: STATUS_PAGE.size,
              modifiedMs: STATUS_PAGE.modifiedMs,
            },
          ],
          truncated: false,
        },
      }),
    read: (input) =>
      Promise.resolve(
        input.path === STATUS_PAGE.path
          ? { success: true as const, data: STATUS_PAGE }
          : { success: false as const, error: `Artifact not found: ${input.path}` }
      ),
  };
  return client;
}

export const TouchToggle: AppStory = {
  render: () => <AppWithMocks setup={setup} />,
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const toggle = await waitFor(
      () => {
        const element = canvasElement.querySelector<HTMLElement>(
          '[data-testid="agent-interface-view-toggle"]'
        );
        if (element == null) throw new Error("Agent interface toggle missing");
        return element;
      },
      { timeout: 10000 }
    );
    const group = within(toggle);
    // No stored choice: the main pane opens on the status page.
    await expect(group.getByRole("button", { name: "Status" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(group.getByRole("button", { name: "Chat" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  },
};

/** A turn in progress after the history replays: reply text so far, then a bash call still running. */
function setupMidTurn(workspaceId: string) {
  // The transcript peek opens from its persisted choice, as after a reload.
  updatePersistedState(AGENT_INTERFACE_TRANSCRIPT_PEEK_KEY, true);
  return setup({
    workspaceId,
    onChat: (chatWorkspaceId, emit) => {
      if (chatWorkspaceId !== workspaceId) return;
      // After the static history and its caught-up (also a 50 ms timer, queued first).
      setTimeout(() => {
        const messageId = "a2-streaming";
        emit({
          type: "stream-start",
          workspaceId,
          messageId,
          model: "anthropic:claude-sonnet-4-5",
          historySequence: 3,
          startTime: STABLE_TIMESTAMP,
        });
        emit({
          type: "stream-delta",
          workspaceId,
          messageId,
          delta: "Checking the canary's error rate before the next step.",
          tokens: 10,
          timestamp: STABLE_TIMESTAMP,
        });
        emit({
          type: "tool-call-start",
          workspaceId,
          messageId,
          toolCallId: "call-canary-check",
          toolName: "bash",
          args: { script: "sleep 20", display_name: "Canary error rate", timeout_secs: 30 },
          tokens: 5,
          timestamp: STABLE_TIMESTAMP,
        });
      }, 50);
    },
  });
}

async function waitForRunningTool(canvasElement: HTMLElement) {
  await waitFor(
    () => {
      const activity = canvasElement.querySelector(
        '[data-testid="agent-interface-status-activity"]'
      );
      if (!activity?.textContent?.includes("Canary error rate")) {
        throw new Error("Status bar does not name the running tool yet");
      }
      if (canvasElement.querySelector('[data-testid="agent-interface-transcript-peek"]') == null) {
        throw new Error("Transcript peek missing");
      }
    },
    { timeout: 10000 }
  );
}

export const StatusBarMidTurn: AppStory = {
  render: () => <AppWithMocks setup={() => setupMidTurn("ws-agent-interface-mid-turn")} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } },
  },
  play: async ({ canvasElement }) => {
    await waitForRunningTool(canvasElement);
  },
};

/** The same bar at phone width: the rows wrap and truncate instead of overflowing. */
export const StatusBarMidTurnPhone: AppStory = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: () => <AppWithMocks setup={() => setupMidTurn("ws-agent-interface-mid-turn-phone")} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark"], viewports: ["phone"] } },
  },
  play: async ({ canvasElement }) => {
    await waitForRunningTool(canvasElement);
  },
};
