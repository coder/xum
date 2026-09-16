/**
 * Instance-wide discovery: `task_list scope:"instance"` rendered inside the full App transcript.
 * Rows are root workspaces across projects with a busy/idle snapshot, the caller's own row, a long
 * project path, and a truncated page that advertises `nextOffset`.
 */

import type { ComponentType } from "react";
import { waitFor, within } from "@storybook/test";

import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { NARROW_VIEWPORT_MAX_WIDTH_PX } from "@/constants/layout";

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar, collapseRightSidebar } from "./helpers/uiState";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";

const WORKSPACE_ID = "ws-instance-discovery";

const INSTANCE_LIST_ARGS = { scope: "instance", limit: 3 };
const INSTANCE_LIST_RESULT = {
  tasks: [
    {
      taskId: WORKSPACE_ID,
      status: "workspace",
      workspaceName: "coordinator",
      title: "Coordinate the migration",
      relationship: "self",
      projectPath: "/home/alice/projects/mux",
      activity: "busy",
      depth: 0,
    },
    {
      taskId: "ws-release-cut-19c2",
      status: "workspace",
      workspaceName: "release-cut",
      title: "Cut release/2026.09",
      relationship: "unrelated",
      projectPath:
        "/home/alice/projects/platform/services/billing/reconciliation-pipeline-with-an-extremely-long-directory-name",
      activity: "busy",
      depth: 0,
    },
    {
      taskId: "ws-docs-sweep-42b0",
      status: "workspace",
      workspaceName: "docs-sweep",
      relationship: "unrelated",
      projectPath: "C:\\Users\\alice\\projects\\api-docs\\",
      activity: "idle",
      depth: 0,
    },
  ],
  note: "Rows are root workspaces in this Xum instance and an availability snapshot. More rows match; pass `nextOffset` as `offset` to continue.",
  nextOffset: 3,
};

function setupInstanceDiscoveryStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  // Tool expansion is a sticky per-workspace preference; start collapsed so the play owns it.
  updatePersistedState(getAutoExpandPrefsKey(WORKSPACE_ID), {});
  return setupSimpleChatStory({
    workspaceId: WORKSPACE_ID,
    workspaceName: "coordinator",
    projectName: "mux",
    projectPath: "/home/alice/projects/mux",
    messages: [
      createUserMessage("discovery-user", "Which other workspaces are active right now?", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 60_000,
      }),
      createAssistantMessage("discovery-assistant", "", {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP,
        toolCalls: [
          {
            type: "dynamic-tool",
            toolCallId: "discovery-list",
            toolName: "task_list",
            state: "output-available",
            input: INSTANCE_LIST_ARGS,
            output: INSTANCE_LIST_RESULT,
          },
        ],
      }),
    ],
  });
}

/** Expands the task_list card and waits for the instance rows to render their activity snapshot. */
async function expandInstanceList(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  (await canvas.findByText("task_list", {}, { timeout: 15_000 })).click();
  await waitFor(() => {
    // Instance rows are the only rows carrying an activity snapshot.
    if (canvas.queryByText("idle") == null || canvas.queryAllByText("busy").length !== 2) {
      throw new Error("instance rows did not render their activity snapshot");
    }
  });
}

export default {
  ...appMeta,
  title: "App/InstanceDiscovery",
};

export const Desktop: AppStory = {
  render: () => <AppWithMocks setup={setupInstanceDiscoveryStory} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } },
  },
  play: async ({ canvasElement }) => {
    await expandInstanceList(canvasElement);
    const canvas = within(canvasElement);
    // Project context shows as the basename only; the full path would drown the row. ("mux" may
    // also appear in the workspace chrome, so count matches instead of requiring exactly one.)
    if (canvas.queryAllByText("mux").length === 0 || canvas.queryByText("api-docs") == null) {
      throw new Error("instance rows did not render their project basenames");
    }
    if (canvas.queryByText(/reconciliation-pipeline-with-an-extremely-long/) == null) {
      throw new Error("long project basename was dropped instead of truncated");
    }
    if (canvas.queryByText("self") == null || canvas.queryAllByText("unrelated").length !== 2) {
      throw new Error("instance rows did not render their relationships");
    }
  },
};

const PHONE_WIDTH = 390;

function PhoneDecorator(Story: ComponentType) {
  return (
    <div
      data-instance-discovery-phone-width={PHONE_WIDTH}
      style={{ width: PHONE_WIDTH, height: 844, overflow: "hidden" }}
    >
      <Story />
    </div>
  );
}

/**
 * Phone-width contract for instance rows: the wrapping badge row (id, status, title, relationship,
 * project, activity) must stay inside a 390px transcript. Pinned to the Pixel phone viewport; the
 * fixed-width decorator keeps the frame narrow in the desktop-sized test-runner, and the
 * media-dependent fit assertion is guarded on the real viewport width.
 */
export const Phone390: AppStory = {
  ...Desktop,
  globals: { viewport: { value: "instanceDiscoveryPhone", isRotated: false } },
  decorators: [PhoneDecorator],
  parameters: {
    ...appMeta.parameters,
    viewport: {
      options: {
        instanceDiscoveryPhone: {
          name: "Phone 390",
          styles: { width: `${PHONE_WIDTH}px`, height: "844px" },
          type: "mobile",
        },
      },
    },
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  play: async (context) => {
    await Desktop.play?.(context);
    const frame = context.canvasElement.querySelector<HTMLElement>(
      "[data-instance-discovery-phone-width]"
    );
    if (!frame) throw new Error("phone frame decorator did not render");
    const frameRect = frame.getBoundingClientRect();
    if (frameRect.width !== PHONE_WIDTH) {
      throw new Error(
        `phone frame is ${frameRect.width}px wide; expected ${PHONE_WIDTH}px — the story would snapshot the wrong layout`
      );
    }
    // The desktop-sized test-runner retains the app's desktop minimum width; only the
    // manager/Pixel phone viewport activates its narrow media rules, so fit is asserted there.
    if (window.innerWidth <= NARROW_VIEWPORT_MAX_WIDTH_PX) {
      // The expanded details surface is the note's parent; every row lives inside it.
      const surface = within(frame).getByText(INSTANCE_LIST_RESULT.note).parentElement;
      if (!surface) throw new Error("task_list details surface did not render");
      // Right-edge containment rather than scrollWidth: ancestors clip overflow, which would
      // hide a too-wide badge or truncated span from scrollWidth-based checks.
      for (const element of surface.querySelectorAll<HTMLElement>("*")) {
        const right = element.getBoundingClientRect().right;
        if (right > frameRect.right + 1) {
          throw new Error(
            `instance list content overflowed the ${PHONE_WIDTH}px frame by ${Math.round(right - frameRect.right)}px`
          );
        }
      }
    }
  },
};
